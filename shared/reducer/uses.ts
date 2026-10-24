import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import { healRevivesDead } from "../migrate.ts";
import type { Actor, ClassResource, Encounter, EncounterSnapshot, InitEntry, LogEvent, PromptKey, Settled, TurnRecord, TurnUses, UseKey, UseMark } from "../model.ts";
import { promptRefusal } from "../permissions.ts";
import { seenByNonOwners, stableStringify } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "../rules/damage.ts";
import { applyHeal } from "../rules/hp.ts";
import { hpRevertOf } from "./hpUndo.ts";
import { invalid, type ResolvedActor, type Tx } from "./tx.ts";

/**
 * A creature's limited uses (docs/design-v1-combat-controls.md 2 and 3):
 * what `actor.use` spends and gives back. The reducer never reads a stat
 * block (3.2), so the op carries what the sending device read there, and
 * the marks keep the ability's name, so they read and give back without it.
 */

type UseOp = OpOf<"actor.use">;
type UseLine = Extract<LogEvent, { type: "use" }>;

/** The refusal of a spend that would hold one mark past `LIMITS.usesPerActor`. */
export const USES_FULL = "Too many uses are spent. A rest brings them back.";
export const NO_LEGENDARY_LEFT = "No legendary actions left.";
export const NO_RESISTANCE = "No Legendary Resistance left.";
export const NO_RESOURCES = "Only a character has class resources.";
export const AMOUNT_FOR_A_POOL = "Only a pool spends an amount.";

export function onceRefusal(name: string): string {
  return `${name} can't be taken again until the start of its next turn.`;
}

export function usedRefusal(name: string): string {
  return `${name} is already used.`;
}

export function noUsesRefusal(name: string): string {
  return `No uses of ${name} left.`;
}

export function noResourceRefusal(name: string, left: number): string {
  return left === 0 ? `${name} has no uses left.` : `Only ${left} of ${name} left.`;
}

/** The mark under a key, read as an own field alone, so no key ever reaches an object's prototype. */
export function markOf(actor: Pick<Actor, "uses">, key: UseKey): UseMark | undefined {
  const uses = actor.uses;
  return uses !== undefined && Object.hasOwn(uses, key) ? uses[key] : undefined;
}

/** The actor with its marks set to `uses`, the field gone when none is left. */
export function withUses(actor: Actor, uses: Record<UseKey, UseMark>): Actor {
  const next = { ...actor };
  if (Object.keys(uses).length > 0) next.uses = uses;
  else delete next.uses;
  return next;
}

/** The actor with one mark put or removed (`mark` null). */
function withMark(actor: Actor, key: UseKey, mark: UseMark | null): Actor {
  const uses: Record<UseKey, UseMark> = { ...actor.uses };
  if (mark === null) delete uses[key];
  else {
    if (!Object.hasOwn(uses, key) && Object.keys(uses).length >= LIMITS.usesPerActor) throw invalid(USES_FULL);
    uses[key] = mark;
  }
  return withUses(actor, uses);
}

/** Writes a use line about the creature, stamped as addActorEvents stamps its events. */
export function addUseLine(tx: Tx, resolved: ResolvedActor, line: Omit<UseLine, "tokenId" | "characterId" | "seen">): void {
  const token = resolved.holder === "token" ? tx.state.tokens[resolved.id] : undefined;
  const about = token ? { tokenId: resolved.id, ...(seenByNonOwners(tx.state, token, tx.env) ? { seen: true as const } : {}) } : { characterId: resolved.id };
  tx.addEvent({ ...line, ...about });
}

/**
 * Spends one of a creature's limited uses, or with `back` gives one back
 * (3.1). A give back with nothing to give changes nothing and writes no
 * line, and so does the Dice panel's mark (`ifReady`) of an ability already
 * used. A use after a secret roll (`quiet`) writes a `hidden` line.
 */
export function actorUse(tx: Tx, op: UseOp): void {
  const resolved = tx.resolveActor(op.target);
  const use = op.use;
  switch (use.kind) {
    case "legendary":
      return legendaryUse(tx, resolved, use, op);
    case "resist":
      return resistUse(tx, resolved, op);
    case "ability":
      return abilityUse(tx, resolved, use, op);
    case "resource":
      return resourceUse(tx, resolved, use, op);
    case "regenerate":
      return regenerate(tx, resolved, use);
  }
}

/** The creature's name as a refusal gives it: its character's, for a token that plays one. */
export function nameOf(resolved: ResolvedActor): string {
  return resolved.character?.name ?? resolved.token?.name ?? "It";
}

/** Refuses a prompt that cannot be settled now (permissions.ts promptRefusal), as permissions did before any die. */
export function checkPrompt(tx: Tx, resolved: ResolvedActor, record: number, what: PromptKey, reopen = false): void {
  const refusal = promptRefusal(tx.state, resolved.actor, nameOf(resolved), record, what, reopen);
  if (refusal !== null) throw invalid(refusal);
}

/** The actor with one prompt of its record settled, or reopened (`settled` null). */
export function withSettled(actor: Actor, what: PromptKey, settled: Settled | null): Actor {
  const record = actor.turnRecord;
  if (!record) return actor;
  const all: Partial<Record<PromptKey, Settled>> = { ...record.settled };
  if (settled === null) delete all[what];
  else all[what] = settled;
  const { settled: _old, ...rest } = record;
  return { ...actor, turnRecord: Object.keys(all).length > 0 ? { ...rest, settled: all } : rest };
}

/**
 * A turn's Skip, or Reopen of a skipped prompt while its turn runs (3.1).
 * Skip writes no line. A done prompt never reopens this way: its roll or
 * its heal stands, and the heal's take back reopens Regeneration (3.4).
 */
export function actorPrompt(tx: Tx, op: OpOf<"actor.prompt">): void {
  const resolved = tx.resolveActor(op.target);
  const what = op.what as PromptKey;
  const reopen = op.state === "open";
  checkPrompt(tx, resolved, op.record, what, reopen);
  if (reopen && resolved.actor.turnRecord?.settled?.[what]?.state !== "skipped") return;
  tx.putActor(resolved, withSettled(resolved.actor, what, reopen ? null : { state: "skipped" }));
}

/**
 * Regeneration's Apply (2.3, 4.3): its heal by applyHeal's rules, which
 * brings back a dying creature, and a dead one where the room lets healing
 * do so, settling the prompt with what it healed. Its HP line's take back
 * names the record, so it reopens the prompt (3.4).
 */
function regenerate(tx: Tx, resolved: ResolvedActor, use: Extract<UseOp["use"], { kind: "regenerate" }>): void {
  checkPrompt(tx, resolved, use.record, "regeneration");
  const actor = resolved.actor;
  const healed = applyHeal(actor, use.amount, healRevivesDead(tx.state.meta.settings, tx.env.opVersion));
  tx.putActor(resolved, withSettled(healed.actor, "regeneration", { state: "done", total: healed.actor.hp.cur - actor.hp.cur }));
  if (healed.actor === actor) return;
  const left = { ...healed.actor.hp };
  const revert = { ...hpRevertOf(actor, healed.actor, tx.state.encounter?.entries ?? []), record: use.record };
  tx.addActorEvents(resolved, healed.events.map((e) => (e.type === "hp" ? { ...e, left, revert } : e)));
}

/** "Fire Breath recharge", cut to a roll's label, whole characters kept (protocol.ts diceRollInput). */
export function rechargeLabel(name: string): string {
  const suffix = " recharge";
  if (name.length + suffix.length <= LIMITS.diceLabelChars) return `${name}${suffix}`;
  let cut = "";
  for (const char of name) {
    if (cut.length + char.length + 1 + suffix.length > LIMITS.diceLabelChars) break;
    cut += char;
  }
  return `${cut.trimEnd()}…${suffix}`;
}

function lineFlags(op: UseOp): Pick<UseLine, "back" | "hidden"> {
  return { ...(op.back ? { back: true as const } : {}), ...(op.quiet ? { hidden: true as const } : {}) };
}

function legendaryUse(tx: Tx, resolved: ResolvedActor, use: Extract<UseOp["use"], { kind: "legendary" }>, op: UseOp): void {
  const actor = resolved.actor;
  const legendary = actor.legendary;
  const mark = use.key !== undefined ? markOf(actor, use.key) : undefined;
  let next: Actor;
  if (op.back) {
    const pips = Math.min(use.cost, legendary?.actionsUsed ?? 0);
    if (pips === 0 && mark?.kind !== "turn") return;
    next = legendary && pips > 0 ? { ...actor, legendary: { ...legendary, actionsUsed: legendary.actionsUsed - pips } } : actor;
    if (mark?.kind === "turn" && use.key !== undefined) next = withMark(next, use.key, null);
  } else {
    if (!legendary || legendary.actionsUsed + use.cost > legendary.actionsMax) throw invalid(NO_LEGENDARY_LEFT);
    if (mark?.kind === "turn") throw invalid(onceRefusal(mark.name));
    next = { ...actor, legendary: { ...legendary, actionsUsed: legendary.actionsUsed + use.cost } };
    if (use.once && use.key !== undefined && use.name !== undefined) next = withMark(next, use.key, { kind: "turn", name: use.name, used: 1, max: 1 });
  }
  tx.putActor(resolved, next);
  const after = next.legendary;
  const line: Omit<UseLine, "tokenId" | "characterId" | "seen"> = { type: "use", what: "legendary", ...lineFlags(op) };
  if (use.name !== undefined) line.name = use.name;
  if (use.cost > 1) line.cost = use.cost;
  if (after) {
    line.left = after.actionsMax - after.actionsUsed;
    line.max = after.actionsMax;
  }
  addUseLine(tx, resolved, line);
}

function resistUse(tx: Tx, resolved: ResolvedActor, op: UseOp): void {
  const legendary = resolved.actor.legendary;
  if (op.back) {
    if (!legendary || legendary.resistUsed === 0) return;
  } else if (!legendary || legendary.resistUsed >= legendary.resistMax) throw invalid(NO_RESISTANCE);
  const resistUsed = legendary.resistUsed + (op.back ? -1 : 1);
  tx.putActor(resolved, { ...resolved.actor, legendary: { ...legendary, resistUsed } });
  addUseLine(tx, resolved, { type: "use", what: "resist", left: legendary.resistMax - resistUsed, max: legendary.resistMax, ...lineFlags(op) });
}

function abilityUse(tx: Tx, resolved: ResolvedActor, use: Extract<UseOp["use"], { kind: "ability" }>, op: UseOp): void {
  const actor = resolved.actor;
  const held = markOf(actor, use.key);
  // A mark of another kind under the key is from a block edited since (3.2), and this use reads the block as it is now.
  const mark = held?.kind === use.limit ? held : undefined;
  let next: UseMark | null;
  if (op.back) {
    if (!held) return;
    next = held.kind === "day" && held.used > 1 ? { ...held, used: held.used - 1 } : null;
  } else if (use.limit === "day") {
    const used = (mark?.used ?? 0) + 1;
    if (used > use.max) {
      if (use.ifReady) return;
      throw invalid(noUsesRefusal(use.name));
    }
    next = { kind: "day", name: use.name, used, max: use.max, ...(use.short ? { short: true as const } : {}) };
  } else {
    if (mark) {
      if (use.ifReady) return;
      throw invalid(usedRefusal(use.name));
    }
    next = { kind: use.limit, name: use.name, used: 1, max: 1, ...(use.min !== undefined ? { min: use.min } : {}) };
  }
  let after = withMark(actor, use.key, next);
  // Mark ready settles the recharge's open occurrence as done, in the same op (2.3).
  const record = actor.turnRecord;
  const due: PromptKey = `recharge:${use.key}`;
  if (op.back && held?.kind === "recharge" && record && promptRefusal(tx.state, actor, nameOf(resolved), record.id, due) === null) after = withSettled(after, due, { state: "done", outcome: "ready" });
  tx.putActor(resolved, after);
  const line: Omit<UseLine, "tokenId" | "characterId" | "seen"> = { type: "use", what: "ability", name: op.back ? held!.name : use.name, ...lineFlags(op) };
  const counted = op.back ? held! : next!;
  if (counted.kind === "day") {
    line.left = counted.max - (next?.used ?? 0);
    line.max = counted.max;
  }
  addUseLine(tx, resolved, line);
}

function resourceUse(tx: Tx, resolved: ResolvedActor, use: Extract<UseOp["use"], { kind: "resource" }>, op: UseOp): void {
  const character = resolved.character;
  if (!character) throw invalid(NO_RESOURCES);
  const resources = character.resources ?? [];
  const index = resources.findIndex((r) => r.id === use.id);
  const resource = resources[index];
  if (!resource) throw invalid("That class resource is not here.");
  if (use.amount !== undefined && !resource.pool) throw invalid(AMOUNT_FOR_A_POOL);
  const amount = use.amount ?? 1;
  let used: number;
  if (op.back) {
    used = Math.max(0, resource.used - amount);
    if (used === resource.used) return;
  } else {
    if (resource.used + amount > resource.max) throw invalid(noResourceRefusal(resource.name, resource.max - resource.used));
    used = resource.used + amount;
  }
  const next: ClassResource[] = [...resources];
  next[index] = { ...resource, used };
  const current = tx.character(character.id);
  tx.write(keys.character(character.id), { ...current, resources: next });
  const line: Omit<UseLine, "tokenId" | "characterId" | "seen"> = { type: "use", what: "resource", name: resource.name, left: resource.max - used, max: resource.max, ...lineFlags(op) };
  if (resource.pool) line.cost = Math.abs(resource.used - used);
  addUseLine(tx, resolved, line);
}

/**
 * The stat block a creature's marks are keyed by (2.4): its SRD creature,
 * as Wild Shape or another shape, its room monster or its companion block.
 * A change of it takes the marks, whose keys named the old block.
 */
export function linkOf(actor: Pick<Actor, "srdId" | "wildShape" | "monsterId" | "blockId">): string | undefined {
  if (actor.srdId !== undefined) return `${actor.wildShape ? "wild" : "srd"}:${actor.srdId}`;
  if (actor.monsterId !== undefined) return `monster:${actor.monsterId}`;
  if (actor.blockId !== undefined) return `block:${actor.blockId}`;
  return undefined;
}

/** Damage types together, each once, in the rules' order, so every device and a replay hold the same list. */
export function typeUnion(...lists: (readonly DamageType[] | undefined)[]): DamageType[] {
  const held = new Set(lists.flatMap((list) => list ?? []));
  return DAMAGE_TYPES.filter((type) => held.has(type));
}

/** The actor without what lasts only a turn or a fight (2.4): its `turn` marks, `hurt` and `turnRecord`, the very same actor when it holds none. */
export function withoutTurnScoped(actor: Actor): Actor {
  const marks = actor.uses ?? {};
  const turns = Object.keys(marks).filter((key) => marks[key]!.kind === "turn");
  if (turns.length === 0 && actor.hurt === undefined && actor.turnRecord === undefined) return actor;
  const uses = { ...marks };
  for (const key of turns) delete uses[key];
  const { hurt: _hurt, turnRecord: _record, ...rest } = withUses(actor, uses);
  return rest;
}

/**
 * The creatures a turn starts for (2.3): the landing row's own, the
 * `shared` companions of its character on the row token's scene, or the
 * players' scene for a row with no token, as Next clears their Reactions,
 * and the controlled mounts that joined the turn. Each once, by holder.
 */
function participants(tx: Tx, encounter: Encounter, landing: InitEntry, companions: readonly string[]): { resolved: ResolvedActor; landing: boolean }[] {
  const out: { resolved: ResolvedActor; landing: boolean }[] = [];
  const seen = new Set<string>();
  const add = (resolved: ResolvedActor | undefined, isLanding: boolean) => {
    const holder = resolved && `${resolved.holder}:${resolved.id}`;
    if (!resolved || seen.has(holder!)) return;
    seen.add(holder!);
    out.push({ resolved, landing: isLanding });
  };
  add(landing.tokenId !== undefined ? tx.tryResolveActor({ tokenId: landing.tokenId }) : landing.characterId !== undefined ? tx.tryResolveActor({ characterId: landing.characterId }) : undefined, true);
  for (const id of companions) add(tx.tryResolveActor({ tokenId: id }), false);
  for (const id of encounter.turnStart?.mounts ?? []) add(tx.tryResolveActor({ tokenId: id }), false);
  return out;
}

/**
 * Whether the landing row's own creature needs a turn record (2.3): only
 * where a card or a reset could apply, so a healthy goblin with nothing to
 * track does not change every turn. Every other creature of the turn gets
 * one, since they are few.
 */
function needsRecord(resolved: ResolvedActor, due: readonly string[]): boolean {
  const actor = resolved.actor;
  return (
    actor.hp.cur < actor.hp.max ||
    actor.life !== "alive" ||
    due.length > 0 ||
    (actor.hurt?.length ?? 0) > 0 ||
    Object.keys(actor.uses ?? {}).length > 0 ||
    actor.legendary !== undefined ||
    (resolved.character?.resources?.length ?? 0) > 0
  );
}

/**
 * A turn starts (docs/design-v1-combat-controls.md 2.3, 2.4 and 3.3): each
 * creature of it gets its turn record where 2.3 says, stamped with the seq
 * of the op, the turn's row and round, its HP and life, the damage types of
 * the window it closes (`took`, which empties `hurt`) and the recharges due
 * (`due`). Its once a turn marks go and its legendary actions refill. With
 * a saved step (`snapshot`, Next's), what each start replaced goes in it
 * for Previous: the landing creature's pips in `legendary`, as before, and
 * the rest in `turnUses`. A start passed on by a removal saves nothing, and
 * the removal's own undo takes it back.
 */
export function startTurnUses(tx: Tx, encounter: Encounter, landing: InitEntry, companions: readonly string[], snapshot: EncounterSnapshot | null): void {
  for (const { resolved, landing: isLanding } of participants(tx, encounter, landing, companions)) {
    const actor = resolved.actor;
    const marks = actor.uses ?? {};
    // Keys sorted, since a map's order is not kept through a jsonb round trip and the record must replay the same.
    const held = Object.keys(marks).sort();
    const due = held.filter((key) => marks[key]!.kind === "recharge").slice(0, LIMITS.dueUses);
    const turns = held.filter((key) => marks[key]!.kind === "turn");
    const saved: TurnUses = { holderId: resolved.id };
    let next: Actor = { ...actor };
    if (!isLanding || needsRecord(resolved, due)) {
      const record: TurnRecord = { id: tx.env.seq, entryId: landing.id, round: encounter.round, hp: actor.hp.cur, life: actor.life };
      if (actor.hurt && actor.hurt.length > 0) record.took = actor.hurt;
      if (due.length > 0) record.due = due;
      next.turnRecord = record;
      delete next.hurt;
      saved.record = actor.turnRecord ?? null;
    } else if (actor.turnRecord) {
      // An earlier turn's record would only ever say that turn is over.
      delete next.turnRecord;
      saved.record = actor.turnRecord;
    }
    if (turns.length > 0) {
      const uses = { ...marks };
      const removed: Record<UseKey, UseMark> = {};
      for (const key of turns) {
        removed[key] = marks[key]!;
        delete uses[key];
      }
      next = withUses(next, uses);
      saved.marks = removed;
    }
    const legendary = actor.legendary;
    if (legendary && legendary.actionsUsed !== 0) {
      next.legendary = { ...legendary, actionsUsed: 0 };
      if (!isLanding) saved.actionsUsed = legendary.actionsUsed;
      else if (snapshot) snapshot.legendary = { holderId: resolved.id, actionsUsed: legendary.actionsUsed };
    }
    if (stableStringify(next) === stableStringify(actor)) continue;
    tx.putActor(resolved, next);
    const link = linkOf(actor);
    if (link !== undefined) saved.link = link;
    if (snapshot && (saved.record !== undefined || saved.marks !== undefined || saved.actionsUsed !== undefined)) (snapshot.turnUses ??= []).push(saved);
  }
}

/**
 * A creature exactly as a saved turn named it: its character's actor, or a
 * token's own. A token that plays a character now holds no actor of its
 * own, so it was converted and gets nothing back.
 */
function holderNamed(tx: Tx, holderId: string): ResolvedActor | undefined {
  if (tx.state.characters[holderId]) return tx.tryResolveActor({ characterId: holderId });
  const token = tx.state.tokens[holderId];
  return token && "inline" in token.actor ? tx.tryResolveActor({ tokenId: holderId }) : undefined;
}

/**
 * Previous puts back what the turn's start replaced (3.3, 3.4): the record
 * it replaced, or none for `null`, `hurt` as the union of the removed
 * record's `took` and the creature's `hurt` now, the once a turn marks it
 * removed, while the mark bound holds, and the pips of its other creatures.
 * Uses spent during the turn stay spent. A creature deleted, converted or
 * relinked since gets nothing back, as a companion's Reaction does not.
 */
export function restoreTurnUses(tx: Tx, saved: readonly TurnUses[]): void {
  for (const entry of saved) {
    const resolved = holderNamed(tx, entry.holderId);
    if (!resolved || linkOf(resolved.actor) !== entry.link) continue;
    const actor = resolved.actor;
    let next: Actor = { ...actor };
    if (entry.record !== undefined) {
      const hurt = typeUnion(actor.turnRecord?.took, actor.hurt);
      if (hurt.length > 0) next.hurt = hurt;
      else delete next.hurt;
      if (entry.record === null) delete next.turnRecord;
      else next.turnRecord = entry.record;
    }
    if (entry.marks) {
      const uses: Record<UseKey, UseMark> = { ...next.uses };
      for (const key of Object.keys(entry.marks).sort()) {
        // A mark that would not fit is left off, which can only let an action be taken again.
        if (Object.hasOwn(uses, key) || Object.keys(uses).length >= LIMITS.usesPerActor) continue;
        uses[key] = entry.marks[key]!;
      }
      next = withUses(next, uses);
    }
    if (entry.actionsUsed !== undefined && next.legendary) next.legendary = { ...next.legendary, actionsUsed: Math.min(entry.actionsUsed, next.legendary.actionsMax) };
    if (stableStringify(next) !== stableStringify(actor)) tx.putActor(resolved, next);
  }
}
