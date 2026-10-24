import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { Actor, ClassResource, LogEvent, UseKey, UseMark } from "../model.ts";
import { seenByNonOwners } from "../project.ts";
import type { OpOf } from "../protocol.ts";
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
function addUseLine(tx: Tx, resolved: ResolvedActor, line: Omit<UseLine, "tokenId" | "characterId" | "seen">): void {
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
      throw invalid("Regeneration is not available yet");
  }
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
  tx.putActor(resolved, withMark(actor, use.key, next));
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
