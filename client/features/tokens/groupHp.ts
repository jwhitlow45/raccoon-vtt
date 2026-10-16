import type { Character, MemberId, Token } from "#shared/model.ts";
import type { ActorTarget, ClientOp, HpChange } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomActions } from "../../state/types.ts";
import { tokenAccess, type Role } from "./access.ts";
import { withCrit, type HpMode, type HpParse } from "./hpInput.ts";

/**
 * One HP entry for several creatures (features section 10: "one entry can
 * apply to a multi-selection"), as plain functions for node --test. Each
 * creature gets its own `actor.hp`, so the shared rules spend its temporary
 * HP first and settle its 0 HP state on their own, exactly as a single entry
 * would.
 */

export type HpTarget = {
  /** Whose HP this is: two tokens of one character share it, and must not take the damage twice. */
  holder: string;
  target: ActorTarget;
  name: string;
  access: "all" | "relative" | "none";
  /** At 0 HP and dying or stable: damage here can be a critical hit (design 9.6). */
  atZero: boolean;
  /** Dead in this viewer's copy, for the entry's lines on healing the dead (deadLines). */
  dead: boolean;
  /** Its HP maximum, when this viewer holds its HP. */
  max: number | undefined;
};

type TokenLike = Pick<Token, "id" | "ownerIds" | "actor" | "kind" | "name"> & Partial<Pick<Token, "publicName" | "number" | "nameHidden">>;

/** What this viewer may do to each selected creature's HP, the way the token's own bar decides it. */
export function hpTargets(
  tokens: readonly TokenLike[],
  ctx: {
    role: Role;
    memberId: MemberId | null | undefined;
    characters: Readonly<Record<string, Character | undefined>>;
    playersApplyDamage: boolean;
  },
): HpTarget[] {
  return tokens.map((token) => {
    const character = "ref" in token.actor ? ctx.characters[token.actor.ref] : undefined;
    const access = tokenAccess({
      role: ctx.role,
      memberId: ctx.memberId,
      view: { characters: character ? { [character.id]: character } : {}, meta: { settings: { playersApplyDamage: ctx.playersApplyDamage } } },
      token,
    });
    const actor = "inline" in token.actor ? token.actor.inline : character?.actor;
    const atZero = actor?.hp?.cur === 0 && (actor.life === "dying" || actor.life === "stable");
    return {
      holder: "ref" in token.actor ? `character:${token.actor.ref}` : `token:${token.id}`,
      target: { tokenId: token.id },
      name: displayName(token as Token),
      access: access.hp,
      atZero: !!atZero,
      dead: actor?.life === "dead",
      max: actor?.hp?.max,
    };
  });
}

/**
 * What one entry may do to all of them: everything only when every creature
 * allows it, damage and healing when some allow only that. Creatures this
 * viewer cannot touch at all are left out, and the entry says so.
 */
export function groupAccess(targets: readonly HpTarget[]): "all" | "relative" | "none" {
  const open = targets.filter((t) => t.access !== "none");
  if (open.length === 0) return "none";
  return open.every((t) => t.access === "all") ? "all" : "relative";
}

/** One `actor.hp` per creature this viewer may change, each holder once. A critical hit counts only where it means something: at 0 HP. */
export function hpOps(targets: readonly HpTarget[], change: HpChange, crit: boolean): ClientOp[] {
  const relative = change.kind === "damage" || change.kind === "heal";
  const seen = new Set<string>();
  const ops: ClientOp[] = [];
  for (const t of targets) {
    if (t.access === "none" || (t.access === "relative" && !relative) || seen.has(t.holder)) continue;
    seen.add(t.holder);
    ops.push({ t: "actor.hp", target: t.target, change: withCrit(change, crit && t.atZero) });
  }
  return ops;
}

/**
 * Sends one entry's ops as one gesture, so one undo takes the whole entry
 * back from every creature it reached, not from the last of them alone
 * (docs/design-v1-dm-tools.md 3.5).
 */
export function sendHpEntry(actions: Pick<RoomActions, "dispatch" | "newId">, targets: readonly HpTarget[], change: HpChange, crit: boolean): void {
  dispatchGesture(actions, hpOps(targets, change, crit));
}

/** What an entry will send, as its lines judge it: a heal, damage, a set (with the current HP it names, once typed) or temporary HP. */
export type EntryOperation = { kind: HpChange["kind"]; cur?: number };

/**
 * Why an entry under `relative` access (players who may only deal damage
 * and heal) cannot send what was typed, such as `=12` or `t5`, shown as
 * soon as it parses rather than after Apply. Null when it may go.
 */
export function entryRefusal(access: "all" | "relative", change: Pick<HpChange, "kind">, count: number): string | null {
  if (access === "all" || change.kind === "damage" || change.kind === "heal") return null;
  return count > 1 ? "You can only deal damage to or heal these creatures." : "You can only deal damage to or heal this creature.";
}

/**
 * The operation an entry's lines judge: the typed change once it parses
 * and the viewer may send it, else the chosen mode, so a refused `=12`
 * never promises to bring back the dead.
 */
export function entryOperation(access: "all" | "relative", mode: HpMode, preview: HpParse | null): EntryOperation {
  if (!preview?.ok || entryRefusal(access, preview.change, 1) !== null) return { kind: mode };
  const { change } = preview;
  return { kind: change.kind, ...(change.kind === "set" && change.cur !== undefined ? { cur: change.cur } : {}) };
}

/**
 * The lines an HP entry adds about the dead among its targets
 * (docs/design-v1-combat-flow.md 3.5), for one creature or a group alike.
 * They follow what will be sent, so `+5` typed under Damage reads as a heal.
 * With healing bringing back the dead (`revives`), a heal, or a set of a
 * current HP above 0, counts the dead it will bring back: those whose
 * maximum is above 0, or unknown to this viewer, since a maximum of 0
 * leaves them at 0. Off, a heal or a set says the dead stay dead before
 * anything is sent. Damage and temporary HP add nothing.
 */
export function deadLines(targets: readonly HpTarget[], operation: EntryOperation, ctx: { revives: boolean; dm: boolean }): string[] {
  const seen = new Set<string>();
  const reached: HpTarget[] = [];
  for (const t of targets) {
    if (t.access === "none" || seen.has(t.holder)) continue;
    seen.add(t.holder);
    reached.push(t);
  }
  const dead = reached.filter((t) => t.dead);
  if (dead.length === 0) return [];
  const one = reached.length === 1 ? dead[0] : undefined;
  if (ctx.revives) {
    const healing = operation.kind === "heal" || (operation.kind === "set" && operation.cur !== undefined && operation.cur > 0);
    if (!healing) return [];
    const back = dead.filter((t) => t.max === undefined || t.max > 0).length;
    if (back === 0) return [];
    return [back === 1 ? "Brings back 1 dead creature." : `Brings back ${back} dead creatures.`];
  }
  if (operation.kind === "heal") {
    if (one) return [`Healing does nothing while ${one.name} is dead.${ctx.dm ? ` Revive ${one.name} first.` : ""}`];
    return [`Healing does nothing to the ${dead.length} dead among them.`];
  }
  if (operation.kind === "set") {
    if (one) return [`${one.name} stays dead at the new HP. Only Revive brings ${one.name} back.`];
    return [`The ${dead.length} dead among them stay dead at the new HP. Only Revive brings them back.`];
  }
  return [];
}

/**
 * The line a dead creature's bar shows under its vitals to a player who may
 * heal it (docs/design-v1-combat-flow.md 3.5). The DM gets Revive's line
 * instead.
 */
export function deadHealLine(name: string, revives: boolean): string {
  return revives ? `Healing brings ${name} back.` : `Healing does nothing while ${name} is dead. Only the DM's Revive brings ${name} back.`;
}
