import { healRevivesDead, reviveToOne } from "../migrate.ts";
import type { Effect } from "../model.ts";
import { MAX_EFFECTS, type DurationInput, type OpOf } from "../protocol.ts";
import { resolveDuration } from "../rules/durations.ts";
import {
  INCAPACITATING_KEYS,
  applyDamage,
  applyDeathSaves,
  applyHeal,
  applyHpSet,
  applyLife,
  applyTemp,
  effectEvent,
  endConcentration,
  type ActorEvent,
} from "../rules/hp.ts";
import { applyRest } from "../rules/rest.ts";
import { hpRevertOf } from "./hpUndo.ts";
import { Refuse, gone, invalid, type Tx } from "./tx.ts";

export function actorHp(tx: Tx, op: OpOf<"actor.hp">): void {
  const resolved = tx.resolveActor(op.target);
  const settings = tx.state.meta.settings;
  const revivesDead = healRevivesDead(settings, tx.env.opVersion);
  const c = op.change;
  const r =
    c.kind === "damage"
      ? applyDamage(resolved.actor, c.amount, resolved.kind, settings, c.crit ?? false)
      : c.kind === "heal"
        ? applyHeal(resolved.actor, c.amount, revivesDead)
        : c.kind === "temp"
          ? applyTemp(resolved.actor, c.amount)
          : applyHpSet(resolved.actor, c, resolved.kind, settings, revivesDead);
  if (r.actor === resolved.actor) return;
  tx.putActor(resolved, r.actor);
  // The HP after the change, and what it replaced, so the log reads "3/7 left" and the DM can take it back (features section 10).
  const left = { ...r.actor.hp };
  const revert = hpRevertOf(resolved.actor, r.actor, tx.state.encounter?.entries ?? []);
  tx.addActorEvents(resolved, r.events.map((e) => (e.type === "hp" ? { ...e, left, revert } : e)));
}

/** A short or long rest (shared/rules/rest.ts). A long rest restores HP by itself, so it takes no `heal`. */
export function actorRest(tx: Tx, op: OpOf<"actor.rest">): void {
  if (op.kind === "long" && op.heal !== undefined) throw invalid("a long rest restores all HP by itself");
  const resolved = tx.resolveActor(op.target);
  const r = applyRest(resolved.actor, op.kind, op.heal ?? 0);
  if ("refused" in r) throw invalid(r.refused);
  tx.putActor(resolved, r.actor);
  tx.addActorEvents(resolved, r.events);
}

/**
 * Damage to several creatures at once (an area's damage). Each goes through
 * actorHp, so temporary HP goes first, 0 HP and concentration prompts work
 * and the log reads as it does for one creature's damage. A creature named
 * twice, such as two tokens of one character, is refused rather than hurt
 * twice.
 */
export function actorDamageMany(tx: Tx, op: OpOf<"actor.damageMany">): void {
  const holders = new Set<string>();
  for (const hit of op.hits) {
    const resolved = tx.resolveActor(hit.target);
    const holder = `${resolved.holder}:${resolved.id}`;
    if (holders.has(holder)) throw invalid("a creature is listed twice");
    holders.add(holder);
    actorHp(tx, { t: "actor.hp", target: hit.target, change: { kind: "damage", amount: hit.amount } });
  }
}

export function actorDeathSave(tx: Tx, op: OpOf<"actor.deathSave">): void {
  const resolved = tx.resolveActor(op.target);
  if (resolved.actor.life !== "dying") throw invalid("only a dying creature makes death saves");
  const r = applyDeathSaves(resolved.actor, op.ok, op.fail);
  tx.putActor(resolved, r.actor);
  tx.addActorEvents(resolved, r.events);
}

export function actorLife(tx: Tx, op: OpOf<"actor.life">): void {
  const resolved = tx.resolveActor(op.target);
  const r = applyLife(resolved.actor, op.life, reviveToOne(tx.env.opVersion));
  tx.putActor(resolved, r.actor);
  tx.addActorEvents(resolved, r.events);
}

function stripUndefined<T extends object>(value: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** The creature a duration is measured against must exist, or the timer could never run. */
function checkAnchor(tx: Tx, input: DurationInput): void {
  const of = input.of;
  if ("tokenId" in of) tx.token(of.tokenId);
  else if ("characterId" in of) tx.character(of.characterId);
  else if (!tx.state.encounter?.entries.some((e) => e.id === of.entryId)) throw gone("entry");
}

export function effectAdd(tx: Tx, op: OpOf<"actor.effect.add">): void {
  const resolved = tx.resolveActor(op.target);
  const actor = resolved.actor;
  if (actor.effects.length >= MAX_EFFECTS) throw new Refuse("quota", `at most ${MAX_EFFECTS} effects per creature`);
  if (actor.effects.some((e) => e.id === op.effect.id)) throw invalid("effect already exists");
  const { duration, ...rest } = op.effect;
  const effect: Effect = stripUndefined(rest);
  if (duration) {
    checkAnchor(tx, duration);
    effect.duration = resolveDuration(tx.state, duration);
  }
  let next = { ...actor, effects: [...actor.effects, effect] };
  const events: ActorEvent[] = [effectEvent(effect, "add")];
  if (INCAPACITATING_KEYS.has(effect.key)) {
    const ended = endConcentration(next);
    next = ended.actor;
    events.push(...ended.events);
  }
  tx.putActor(resolved, next);
  tx.addActorEvents(resolved, events);
}

export function effectUpdate(tx: Tx, op: OpOf<"actor.effect.update">): void {
  const resolved = tx.resolveActor(op.target);
  const index = resolved.actor.effects.findIndex((e) => e.id === op.effectId);
  const current = resolved.actor.effects[index];
  if (!current) throw gone("effect");
  const next: Effect = { ...current };
  const p = op.patch;
  if (p.hiddenFromPlayers !== undefined) next.hiddenFromPlayers = p.hiddenFromPlayers;
  if (p.triggerShown !== undefined) next.triggerShown = p.triggerShown;
  for (const field of ["label", "glyph", "color", "level", "spell"] as const) {
    const value = p[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else (next as Record<string, unknown>)[field] = value;
  }
  if (p.duration === null) delete next.duration;
  else if (p.duration !== undefined) {
    checkAnchor(tx, p.duration);
    next.duration = resolveDuration(tx.state, p.duration);
  }
  const effects = [...resolved.actor.effects];
  effects[index] = next;
  tx.putActor(resolved, { ...resolved.actor, effects });
}

export function effectRemove(tx: Tx, op: OpOf<"actor.effect.remove">): void {
  const resolved = tx.resolveActor(op.target);
  const effect = resolved.actor.effects.find((e) => e.id === op.effectId);
  if (!effect) throw gone("effect");
  tx.putActor(resolved, { ...resolved.actor, effects: resolved.actor.effects.filter((e) => e.id !== op.effectId) });
  tx.addActorEvents(resolved, [effectEvent(effect, "remove")]);
}
