import type { Character, MemberId, Token } from "#shared/model.ts";
import type { ActorTarget, ClientOp, HpChange } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomActions } from "../../state/types.ts";
import { tokenAccess, type Role } from "./access.ts";
import { withCrit } from "./hpInput.ts";

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
