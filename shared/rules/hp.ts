import type { Actor, Effect, LifeState, LogEvent, RoomSettings, TokenKind } from "../model.ts";

/**
 * HP and life-state transitions (design section 9.6). Pure functions over an
 * actor: each returns the new actor and the structured log events the change
 * produced, and the reducer stamps ids and targets on those events.
 *
 * The Unconscious that 0 HP brings carries a fixed effect id, so healing and
 * death can remove exactly that one and leave a condition the DM applied by
 * hand.
 */
export const ZERO_HP_UNCONSCIOUS_ID = "unconscious@0";

export type HpLabel = "Healthy" | "Bloodied" | "Dying" | "Dead";

/** A log event minus the target, which the reducer fills in. */
export type ActorEvent =
  | Extract<LogEvent, { type: "hp" }>
  | Extract<LogEvent, { type: "life" }>
  | Extract<LogEvent, { type: "effect" }>
  | Extract<LogEvent, { type: "concentration" }>
  | Extract<LogEvent, { type: "deathSave" }>
  | Extract<LogEvent, { type: "rest" }>;

export type HpResult = { actor: Actor; events: ActorEvent[] };

/** Conditions that include Incapacitated in the 2024 rules, which end concentration. */
export const INCAPACITATING_KEYS: ReadonlySet<Effect["key"]> = new Set([
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
]);

export function hpLabel(actor: Pick<Actor, "hp" | "life">): HpLabel {
  if (actor.life === "dead") return "Dead";
  if (actor.life === "dying" || actor.life === "stable") return "Dying";
  if (actor.hp.cur <= Math.floor(actor.hp.max / 2)) return "Bloodied";
  return "Healthy";
}

/**
 * A creature with no HP to show (docs/design-v1-combat-flow.md 3.6.6): a
 * companion that is an effect, such as Spiritual Weapon, or any token whose
 * maximum is 0. Every view that draws HP, life marks or AC asks this one
 * predicate, so the token panel, its bar, the tracker, the map and the
 * projection agree.
 *
 * It decides only from what the caller holds: the effect clause needs the
 * token's `companion` and `kind`, the maximum clause the actor's `hp`.
 * Missing HP never counts as 0, so a creature whose HP the viewer may not
 * see is not HP-less. An ordinary object may have HP of its own, such as a
 * door the DM tracks, so being an object alone does not make it HP-less.
 */
export function hpLess(
  actor: { hp?: Pick<Actor["hp"], "max"> } | undefined,
  token?: { kind: TokenKind; companion?: unknown },
): boolean {
  if (token?.companion !== undefined && token.kind === "object") return true;
  return actor?.hp !== undefined && actor.hp.max === 0;
}

/**
 * The life state a view draws: the stored one, or alive while `hpLess`
 * holds. A creature made an effect keeps its stored life and death saves
 * underneath (docs/design-v1-combat-flow.md 3.6.6), and every life control
 * and decoration (death save pips, Revive, a dead row's dim and strike, the
 * map's marks) reads this, so none of them shows or changes it until the
 * companion is a creature again.
 */
export function shownLife(actor: { hp?: Pick<Actor["hp"], "max">; life?: LifeState } | undefined, token?: { kind: TokenKind; companion?: unknown }): LifeState | undefined {
  return hpLess(actor, token) ? "alive" : actor?.life;
}

export function isBloodied(actor: Pick<Actor, "hp">): boolean {
  return actor.hp.cur <= Math.floor(actor.hp.max / 2);
}

/** `cur / max` rounded to the nearest 1/20, the only HP shape a `bar` viewer gets. */
export function hpBar(actor: Pick<Actor, "hp">): number {
  if (actor.hp.max <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, actor.hp.cur / actor.hp.max));
  return Math.round(ratio * 20) / 20;
}

export function concentrationDc(damage: number): number {
  return Math.min(30, Math.max(10, Math.floor(damage / 2)));
}

export function isConcentrating(actor: Pick<Actor, "effects">): boolean {
  return actor.effects.some((e) => e.key === "concentrating");
}

function withUnconscious(actor: Actor): Actor {
  if (actor.effects.some((e) => e.key === "unconscious")) return actor;
  return { ...actor, effects: [...actor.effects, { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" }] };
}

function withoutZeroUnconscious(actor: Actor): Actor {
  if (!actor.effects.some((e) => e.id === ZERO_HP_UNCONSCIOUS_ID)) return actor;
  return { ...actor, effects: actor.effects.filter((e) => e.id !== ZERO_HP_UNCONSCIOUS_ID) };
}

/** The log event for an effect starting, ending or pausing, marked when players may not know about the effect. */
export function effectEvent(effect: Effect, action: Extract<LogEvent, { type: "effect" }>["action"]): ActorEvent {
  const event: ActorEvent = { type: "effect", key: effect.key, action };
  if (effect.spell !== undefined) event.spell = effect.spell;
  if (effect.hiddenFromPlayers) event.hidden = true;
  return event;
}

/** Ends every concentration effect, logging each spell, for Incapacitated and for death. */
export function endConcentration(actor: Actor): HpResult {
  const ending = actor.effects.filter((e) => e.key === "concentrating");
  if (ending.length === 0) return { actor, events: [] };
  return {
    actor: { ...actor, effects: actor.effects.filter((e) => e.key !== "concentrating") },
    events: ending.map((e) => ({
      type: "concentration",
      ended: true,
      ...(e.spell !== undefined ? { spell: e.spell } : {}),
      ...(e.hiddenFromPlayers ? { hidden: true as const } : {}),
    })),
  };
}

function setLife(actor: Actor, life: LifeState): HpResult {
  const events: ActorEvent[] = [];
  let next: Actor = { ...actor, life };
  if (life === "dying") {
    next = withUnconscious(next);
  } else if (life === "dead") {
    // Unconscious belongs to dying (9.6). A dead creature keeps only the
    // conditions someone applied by hand.
    next = withoutZeroUnconscious(next);
    const ended = endConcentration(next);
    next = ended.actor;
    events.push(...ended.events);
  }
  events.push({ type: "life", life });
  return { actor: next, events };
}

/**
 * What happens the moment current HP reaches 0 from above. Objects just sit
 * at 0. Monsters die when the room says so, and otherwise follow the PC rules
 * with death saves the DM enters.
 */
function reachZero(actor: Actor, kind: TokenKind, settings: RoomSettings): HpResult {
  if (kind === "object") return { actor, events: [] };
  const diesAtZero = (kind === "monster" || kind === "npc") && settings.monstersDieAtZero;
  if (diesAtZero) return setLife(actor, "dead");
  const dying = setLife({ ...actor, deathSaves: { ok: 0, fail: 0 } }, "dying");
  // Falling Unconscious includes Incapacitated, which ends concentration.
  const ended = endConcentration(dying.actor);
  return { actor: ended.actor, events: [...dying.events, ...ended.events] };
}

export function applyDamage(
  actor: Actor,
  amount: number,
  kind: TokenKind,
  settings: RoomSettings,
  crit = false,
): HpResult {
  if (amount <= 0 || actor.life === "dead") return { actor, events: [] };
  const events: ActorEvent[] = [];
  const absorbed = Math.min(actor.hp.temp, amount);
  const toCur = amount - absorbed;
  let next: Actor = { ...actor, hp: { ...actor.hp, temp: actor.hp.temp - absorbed } };

  if (next.hp.cur > 0) {
    const cur = Math.max(0, next.hp.cur - toCur);
    const leftover = toCur - next.hp.cur;
    next = { ...next, hp: { ...next.hp, cur } };
    events.push({ type: "hp", change: "damage", amount, ...(crit ? { crit } : {}), label: hpLabel(next) });
    if (cur === 0) {
      const zero = leftover >= next.hp.max && kind !== "object" ? setLife(next, "dead") : reachZero(next, kind, settings);
      next = zero.actor;
      events.push(...zero.events);
      // The label event was logged before the life change, so refresh it.
      const hp = events.find((e) => e.type === "hp");
      if (hp && hp.type === "hp") hp.label = hpLabel(next);
    } else if (isConcentrating(next)) {
      // One prompt covers every concentration at once, so it is hidden only when each of them is.
      const hidden = next.effects.every((e) => e.key !== "concentrating" || e.hiddenFromPlayers);
      events.push({ type: "concentration", dc: concentrationDc(amount), ...(hidden ? { hidden: true as const } : {}) });
    }
    return { actor: next, events };
  }

  // Already at 0: damage adds failed death saves, or kills outright. The
  // 2024 rules count the damage taken, so a hit that temporary HP soaks up
  // still costs a death save, and the whole hit counts toward the maximum.
  events.push({ type: "hp", change: "damage", amount, ...(crit ? { crit } : {}), label: hpLabel(next) });
  if (kind === "object" || next.life === "alive") return { actor: next, events };
  if (amount >= next.hp.max) {
    const dead = setLife(next, "dead");
    return { actor: dead.actor, events: [...events, ...dead.events] };
  }
  const fails = crit ? 2 : 1;
  if (next.life === "stable") {
    const dying = setLife({ ...next, deathSaves: { ok: 0, fail: fails } }, "dying");
    next = dying.actor;
    events.push(...dying.events, { type: "deathSave", ok: 0, fail: fails });
  } else {
    const fail = Math.min(3, next.deathSaves.fail + fails);
    next = { ...next, deathSaves: { ...next.deathSaves, fail } };
    events.push({ type: "deathSave", ok: next.deathSaves.ok, fail });
    if (fail >= 3) {
      const dead = setLife(next, "dead");
      next = dead.actor;
      events.push(...dead.events);
    }
  }
  const hp = events.find((e) => e.type === "hp");
  if (hp && hp.type === "hp") hp.label = hpLabel(next);
  return { actor: next, events };
}

/** Coming back from 0 HP: alive again, the automatic Unconscious gone, death saves cleared. */
function revive(actor: Actor): Actor {
  return withoutZeroUnconscious({ ...actor, life: "alive", deathSaves: { ok: 0, fail: 0 } });
}

/**
 * Whether HP rising to `cur` brings the creature back: from 0 while dying
 * or stable, as the rules say, and from death when the room lets healing
 * bring back the dead (`revivesDead`, docs/design-v1-combat-flow.md 3.4).
 * A dead creature may hold HP, set while that was off, so death is judged
 * on its life alone.
 */
function comesBack(actor: Actor, cur: number, revivesDead: boolean): boolean {
  if (cur <= 0) return false;
  if (actor.life === "dead") return revivesDead;
  return actor.hp.cur === 0 && (actor.life === "dying" || actor.life === "stable");
}

export function applyHeal(actor: Actor, amount: number, revivesDead = false): HpResult {
  if (amount <= 0) return { actor, events: [] };
  const cur = Math.min(actor.hp.max, actor.hp.cur + amount);
  const back = comesBack(actor, cur, revivesDead);
  if (actor.life === "dead" && !back) return { actor, events: [] };
  let next: Actor = { ...actor, hp: { ...actor.hp, cur } };
  if (back) next = revive(next);
  const events: ActorEvent[] = [{ type: "hp", change: "heal", amount, label: hpLabel(next) }];
  if (back) events.push({ type: "life", life: "alive" });
  return { actor: next, events };
}

/**
 * The actor with a new temporary HP pool from a source other than its
 * shape: a grant, a set that changes it, or a Long Rest. The pool is then no
 * longer the one a shape gave, so ending the shape leaves it (W7-SOL-06).
 * Damage only draws the pool down and keeps whose it is.
 */
export function withNewPool(actor: Actor, temp: number): Actor {
  const next: Actor = { ...actor, hp: { ...actor.hp, temp } };
  if (actor.unshaped?.shapeTemp === undefined) return next;
  const { shapeTemp: _theShapes, ...unshaped } = actor.unshaped;
  return { ...next, unshaped };
}

/** Temporary HP is set, not added: the rules say to keep one pool, and the player picks which. */
export function applyTemp(actor: Actor, amount: number): HpResult {
  const next = withNewPool(actor, amount);
  return { actor: next, events: [{ type: "hp", change: "temp", amount, label: hpLabel(next) }] };
}

/**
 * An absolute HP edit. Dropping to 0 follows the reaching-0 rules without the
 * massive-damage check, and rising from 0 revives like healing. A dead
 * creature comes back only from a set that names a current HP above 0, and
 * only when the room lets healing bring back the dead (`revivesDead`). A
 * set of the maximum or temporary HP alone is a correction, not healing,
 * so it leaves the dead dead whatever the room says.
 */
export function applyHpSet(
  actor: Actor,
  values: { cur?: number; max?: number; temp?: number },
  kind: TokenKind,
  settings: RoomSettings,
  revivesDead = false,
): HpResult {
  const max = values.max ?? actor.hp.max;
  const requestedCur = values.cur ?? actor.hp.cur;
  const cur = Math.min(max, Math.max(0, requestedCur));
  const temp = values.temp ?? actor.hp.temp;
  let next: Actor = { ...(temp !== actor.hp.temp ? withNewPool(actor, temp) : actor), hp: { cur, max, temp } };
  const events: ActorEvent[] = [];
  if (actor.life !== "dead") {
    if (actor.hp.cur > 0 && cur === 0) {
      const zero = reachZero(next, kind, settings);
      next = zero.actor;
      events.push(...zero.events);
    } else if (comesBack(actor, cur, false)) {
      next = revive(next);
      events.push({ type: "life", life: "alive" });
    }
  } else if (values.cur !== undefined && comesBack(actor, cur, revivesDead)) {
    next = revive(next);
    events.push({ type: "life", life: "alive" });
  }
  const hp: ActorEvent = { type: "hp", change: "set", label: hpLabel(next) };
  if (values.cur !== undefined) hp.amount = cur;
  return { actor: next, events: [hp, ...events] };
}

/** Death save pips as the player entered them. Three successes stabilize, three failures kill. */
export function applyDeathSaves(actor: Actor, ok: number, fail: number): HpResult {
  const events: ActorEvent[] = [];
  let next: Actor = { ...actor, deathSaves: { ok, fail } };
  events.push({ type: "deathSave", ok, fail });
  if (fail >= 3) {
    const dead = setLife(next, "dead");
    next = dead.actor;
    events.push(...dead.events);
  } else if (ok >= 3) {
    next = { ...next, life: "stable", deathSaves: { ok: 0, fail: 0 } };
    events.push({ type: "life", life: "stable" });
  }
  return { actor: next, events };
}

/**
 * The DM's direct life change. Revive gives a creature that is not alive
 * exactly 1 HP, as Revivify does (docs/design-v1-combat-flow.md 3.5), even a
 * dead one holding HP set while healing could not bring it back. Ops stored
 * before op version 5 kept that HP, at least 1 (`toOne` false). A creature
 * already alive keeps its HP, at least 1, either way. Killing sets HP to 0.
 */
export function applyLife(actor: Actor, life: LifeState, toOne = false): HpResult {
  if (life === "alive") {
    const cur = toOne && actor.life !== "alive" ? 1 : Math.max(1, actor.hp.cur);
    const next = revive({ ...actor, hp: { ...actor.hp, cur } });
    return { actor: next, events: [{ type: "life", life }] };
  }
  if (life === "dead") {
    const dead = setLife({ ...actor, hp: { ...actor.hp, cur: 0 }, deathSaves: { ok: 0, fail: 0 } }, "dead");
    return dead;
  }
  const down: Actor = { ...actor, hp: { ...actor.hp, cur: 0 }, deathSaves: life === "stable" ? { ok: 0, fail: 0 } : actor.deathSaves };
  const result = setLife(down, life);
  const stabilized = life === "stable" ? withUnconscious(result.actor) : result.actor;
  return { actor: stabilized, events: result.events };
}
