import { classChangesWriteLines, clockTicks, combatUses, healRevivesDead, playerLimitsOps, reviveToOne } from "../migrate.ts";
import { CLOCK_TOO_FAR, clockNow } from "../calendar.ts";
import { HIDDEN_EFFECTS_FULL, LIMITS } from "../limits.ts";
import type { Effect, EffectEnds, RoomState } from "../model.ts";
import { heldClock } from "../project.ts";
import { MAX_EFFECTS, type Op, type OpOf, type OutcomeDamage, type TurnDurationInput } from "../protocol.ts";
import { SPAN_CLOCK_UNSHARED, SPAN_NEEDS_CLOCK, endsDue, resolveDuration } from "../rules/durations.ts";
import { ownEntry } from "../records.ts";
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
  hpLabel,
  ZERO_HP_UNCONSCIOUS_ID,
  hpRules,
  type ActorEvent,
} from "../rules/hp.ts";
import { EFFECTS_PER_CLASS, effectsFit, effectsFitChanged, type EffectsFit } from "../rules/effects.ts";
import { applyRest, restedResources } from "../rules/rest.ts";
import { hpRevertOf } from "./hpUndo.ts";
import { keys, parseKey } from "../keys.ts";
import { Refuse, gone, invalid, type ResolvedActor, type Tx } from "./tx.ts";
import { typeUnion } from "./uses.ts";
import { creatureRef } from "./rolls.ts";
import { damageDefenses } from "../rules/damageDefenses.ts";
import { dealtTypes, rowDamage } from "../rules/typedDamage.ts";

/** Save choices come only from the DM's outcome, never from a player's HP change. */
export function actorHp(tx: Tx, op: OpOf<"actor.hp">, context?: Omit<OutcomeDamage, "parts">): void {
  const resolved = tx.resolveActor(op.target);
  const settings = tx.state.meta.settings;
  const revivesDead = healRevivesDead(settings, tx.env.opVersion);
  let c = op.change;
  if (c.kind === "damage" && c.parts !== undefined) {
    const options: Parameters<typeof rowDamage>[2] = {
      onPass: context?.save?.onPass ?? "none", dexSave: context?.save?.dex ?? false,
      row: { defenses: damageDefenses(tx.state, resolved.actor, resolved.character), qualifiedOn: new Set(context?.qualifiedOn), evasion: context?.save?.evasion ?? false, effects: resolved.actor.effects },
    };
    const result = context?.save?.result ?? "fail";
    const dealt = rowDamage(c.parts, result, options);
    if (dealt.amount === 0 && resolved.actor.life !== "dead") {
      const beforeDefenses = rowDamage(c.parts, result, { ...options, row: { ...options.row, defenses: [] } });
      // A missing line would reveal a hidden defense. A save that prevents the hit still writes nothing.
      if (beforeDefenses.amount >= 1) tx.addActorEvents(resolved, [{ type: "hp", change: "damage", amount: 0, label: hpLabel(resolved.actor), left: { ...resolved.actor.hp }, ...(c.crit ? { crit: true } : {}) }]);
    }
    c = { ...c, amount: Math.min(100_000, dealt.amount), types: dealtTypes(c.parts, dealt.byPart) };
  }
  const r =
    c.kind === "damage"
      ? applyDamage(resolved.actor, c.amount, resolved.kind, settings, c.crit ?? false, hpRules(tx.env.opVersion))
      : c.kind === "heal"
        ? applyHeal(resolved.actor, c.amount, revivesDead)
        : c.kind === "temp"
          ? applyTemp(resolved.actor, c.amount)
          : applyHpSet(resolved.actor, c, resolved.kind, settings, revivesDead, hpRules(tx.env.opVersion));
  if (r.actor === resolved.actor) return;
  // Regeneration counts only types that dealt damage after defenses. Temporary HP that took the hit still count,
  // and a take back of the hit leaves them. Older ops carry their final types directly.
  const hurt = c.kind === "damage" && c.types !== undefined && c.types.length > 0 && c.amount >= 1 && combatUses(tx.env.opVersion) ? typeUnion(r.actor.hurt, c.types) : undefined;
  tx.putActor(resolved, hurt ? { ...r.actor, hurt } : r.actor);
  // The HP after the change, and what it replaced, so the log reads "3/7 left" and the DM can take it back (features section 10).
  const left = { ...r.actor.hp };
  const revert = hpRevertOf(resolved.actor, r.actor, tx.state.encounter?.entries ?? []);
  tx.addActorEvents(resolved, r.events.map((e) => {
    if (e.type === "hp") return { ...e, left, revert };
    if ((e.type === "deathSave" || (e.type === "concentration" && !e.ended)) && c.kind === "damage" && c.parts !== undefined) return { ...e, exact: true as const };
    return e;
  }));
}

/** A short or long rest (shared/rules/rest.ts). A long rest restores HP by itself, so it takes no `heal`. */
export function actorRest(tx: Tx, op: OpOf<"actor.rest">): void {
  if (op.kind === "long" && op.heal !== undefined) throw invalid("a long rest restores all HP by itself");
  const resolved = tx.resolveActor(op.target);
  const r = applyRest(resolved.actor, op.kind, op.heal ?? 0);
  if ("refused" in r) throw invalid(r.refused);
  tx.putActor(resolved, r.actor);
  // A character's class resources come back with it (docs/design/design-v1-combat-controls.md 2.4), on the character beside its actor.
  if (resolved.character) {
    const character = tx.character(resolved.character.id);
    let next = character;
    const resources = restedResources(character.resources, op.kind);
    if (resources !== character.resources) next = { ...next, resources };
    // A Long Rest records when it ended by the room's clock and which clock read it (docs/design/design-v1-calendar.md 4.5),
    // whoever rests the character. It never moves the clock: two players resting would move it twice.
    const clock = tx.state.clock;
    if (op.kind === "long" && clock && clockTicks(tx.env.opVersion)) next = { ...next, longRest: { at: clockNow(clock, tx.state.encounter), clock: clock.id } };
    if (next !== character) tx.write(keys.character(character.id), next);
  }
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
    actorHp(tx, { t: "actor.hp", target: hit.target, change: { kind: "damage", amount: hit.amount, ...(hit.types ? { types: hit.types } : {}) } });
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
  const r = applyLife(resolved.actor, op.life, reviveToOne(tx.env.opVersion), hpRules(tx.env.opVersion));
  tx.putActor(resolved, r.actor);
  tx.addActorEvents(resolved, r.events);
}

function stripUndefined<T extends object>(value: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** The creature a duration is measured against must exist, or the timer could never run. */
function checkAnchor(tx: Tx, input: TurnDurationInput): void {
  const of = input.of;
  if ("tokenId" in of) tx.token(of.tokenId);
  else if ("characterId" in of) tx.character(of.characterId);
  else if (!tx.state.encounter?.entries.some((e) => e.id === of.entryId)) throw gone("entry");
}

/**
 * A time span's end, counted from the current time on the clock the actor's
 * view holds (docs/design/design-v1-calendar-c2c3.md 4.3). A player whose view
 * holds none gets one refusal for no clock, a hidden one and a blackout.
 */
function spanEnds(tx: Tx, seconds: number): EffectEnds {
  const clock = heldClock(tx.state, tx.actor);
  if (!clock) throw invalid(tx.actor.role === "dm" ? SPAN_NEEDS_CLOCK : SPAN_CLOCK_UNSHARED);
  const at = clockNow(clock, tx.state.encounter) + seconds;
  if (at > LIMITS.clockSecondsMax) throw invalid(CLOCK_TOO_FAR);
  return { span: seconds, at, clock: clock.id };
}

/** The entity key a creature's converted conditions hash with (rules/effects.ts convertedEffectId). */
export function holderKey(resolved: Pick<ResolvedActor, "holder" | "id">): string {
  return resolved.holder === "token" ? keys.token(resolved.id) : keys.character(resolved.id);
}

/** A condition that does not fit its class, refused in the words of the class it would pass: a player's add reads only the shown one. */
function effectsFull(fit: Extract<EffectsFit, { ok: false }>): Refuse {
  return new Refuse("quota", fit.full === "hidden" ? HIDDEN_EFFECTS_FULL : `at most ${EFFECTS_PER_CLASS} effects per creature`);
}

/** The words of an edit of the automatic Unconscious without the fresh id it goes on under (rules/effects.ts). */
export const AUTOMATIC_NEEDS_ID = "editing the automatic Unconscious needs a new id for it";

export function effectAdd(tx: Tx, op: OpOf<"actor.effect.add">): void {
  const resolved = tx.resolveActor(op.target);
  const actor = resolved.actor;
  const byClass = playerLimitsOps(tx.env.opVersion);
  if (!byClass && actor.effects.length >= MAX_EFFECTS) throw new Refuse("quota", `at most ${MAX_EFFECTS} effects per creature`);
  if (actor.effects.some((e) => e.id === op.effect.id)) throw invalid("effect already exists");
  const { duration, ...rest } = op.effect;
  const effect: Effect = stripUndefined(rest);
  if (duration?.mode === "span") effect.ends = spanEnds(tx, duration.seconds);
  else if (duration) {
    checkAnchor(tx, duration);
    effect.duration = resolveDuration(tx.state, duration);
  }
  const fit = byClass ? effectsFit(holderKey(resolved), actor.effects, [effect]) : { ok: true as const, effects: [...actor.effects, effect] };
  if (!fit.ok) throw effectsFull(fit);
  let next = { ...actor, effects: fit.effects };
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
  const byClass = playerLimitsOps(tx.env.opVersion);
  const next: Effect = { ...current };
  // Hiding or editing the automatic Unconscious makes it an ordinary condition under the fresh id the op brings, so
  // none hidden or edited ever holds the automatic id.
  if (byClass && current.id === ZERO_HP_UNCONSCIOUS_ID) {
    if (op.as === undefined) throw invalid(AUTOMATIC_NEEDS_ID);
    if (resolved.actor.effects.some((e) => e.id === op.as)) throw invalid("effect already exists");
    next.id = op.as;
  } else if (op.as !== undefined) throw invalid("only the automatic Unconscious takes a new id");
  const p = op.patch;
  if (p.hiddenFromPlayers !== undefined) next.hiddenFromPlayers = p.hiddenFromPlayers;
  if (p.triggerShown !== undefined) next.triggerShown = p.triggerShown;
  for (const field of ["label", "glyph", "color", "level", "spell"] as const) {
    const value = p[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else (next as Record<string, unknown>)[field] = value;
  }
  // An effect lasts a count of turns or a length of time, never both, and `null` takes away either.
  if (p.duration === null) {
    delete next.duration;
    delete next.ends;
  } else if (p.duration?.mode === "span") {
    delete next.duration;
    next.ends = spanEnds(tx, p.duration.seconds);
  } else if (p.duration !== undefined) {
    checkAnchor(tx, p.duration);
    next.duration = resolveDuration(tx.state, p.duration);
    delete next.ends;
  }
  // An effect no save ends has no occurrence waiting, so a request linked to one closes (shared/reducer/rolls.ts endSaves).
  if (p.save === null) {
    delete next.save;
    delete next.due;
  } else if (p.save !== undefined) next.save = p.save;
  if (!byClass) {
    const effects = [...resolved.actor.effects];
    effects[index] = next;
    tx.putActor(resolved, { ...resolved.actor, effects });
    return;
  }
  const fit = effectsFitChanged(holderKey(resolved), resolved.actor.effects, index, next);
  if (!fit.ok) throw effectsFull(fit);
  tx.putActor(resolved, { ...resolved.actor, effects: fit.effects });
  const hides = current.hiddenFromPlayers !== true && next.hiddenFromPlayers === true;
  const shows = current.hiddenFromPlayers === true && next.hiddenFromPlayers !== true;
  if (!classChangesWriteLines(tx.env.opVersion) || (!hides && !shows)) return;
  // Players read a hide as the condition's removal and a show as its add, each in the line those would write, so a
  // hide closes the condition's open save request as the removal would (rolls.ts endSaves). The DM reads its own words
  // (shared/logText.ts).
  if (hides) {
    closeSaveRequests(tx, resolved, current);
    tx.addActorEvents(resolved, [effectEvent(current, "hide")]);
  } else tx.addActorEvents(resolved, [effectEvent(next, "show")]);
}

/**
 * Closes each open save request of an effect's occurrence on one creature,
 * as endSaves closes one whose effect is gone: no line, and the occurrence
 * left pending, so the DM may ask again. A request matches by the creature
 * its target resolves to, its effect id and its occurrence, since an
 * effect's id is unique on its creature only.
 */
function closeSaveRequests(tx: Tx, resolved: ResolvedActor, effect: Effect): void {
  const requests = Object.values(tx.state.rolls ?? {}).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const request of requests) {
    const target = request.targets[0];
    if (!request.ends || !target || request.ends.effect !== effect.id || request.ends.occurrence !== effect.due?.id) continue;
    const holder = tx.tryResolveActor(creatureRef(target));
    if (holder?.holder === resolved.holder && holder.id === resolved.id) tx.remove(keys.roll(request.id));
  }
}

/**
 * Ends every time span the current time has reached, in the op that got it
 * there (docs/design/design-v1-calendar-c2c3.md 4.3, D-261108-092). When the
 * clock appeared, changed id or its current time changed (`clockNow`, so a
 * restore of the fight's rounds alone counts too), every actor in the room
 * is read, since the clock and its spans are the room's. Any other restore
 * reads the actors it brought back, which catches an ended effect put back
 * past its end. Every other op leaves the spans as they were. After a Next
 * or a Previous the tick and the filter have already ended or left out what
 * is due, so nothing ends twice.
 */
export function endDueSpans(tx: Tx, before: Pick<RoomState, "clock" | "encounter">, op: Op): void {
  const clock = tx.state.clock;
  if (!clock) return;
  const now = clockNow(clock, tx.state.encounter);
  const was = before.clock;
  const moved = !was || was.id !== clock.id || clockNow(was, before.encounter) !== now;
  const actors = moved ? tx.actors() : op.t === "sys.restore" ? restoredActors(tx) : [];
  for (const resolved of actors) {
    const ending = resolved.actor.effects.filter((e) => endsDue(e, clock, now));
    if (ending.length === 0) continue;
    tx.putActor(resolved, { ...resolved.actor, effects: resolved.actor.effects.filter((e) => !ending.includes(e)) });
    tx.addActorEvents(resolved, ending.map((e) => effectEvent(e, "expire")));
  }
}

/** The actors a restore wrote, each once: its characters and its tokens' own actors, by id as Tx.actors orders them. */
function restoredActors(tx: Tx): ResolvedActor[] {
  const out: ResolvedActor[] = [];
  for (const key of tx.touched()) {
    const parsed = parseKey(key);
    if (parsed?.kind === "character") {
      if (ownEntry(tx.state.characters, parsed.id)) out.push(tx.resolveActor({ characterId: parsed.id }));
    } else if (parsed?.kind === "token") {
      const token = ownEntry(tx.state.tokens, parsed.id);
      if (token && "inline" in token.actor) out.push(tx.resolveActor({ tokenId: parsed.id }));
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function effectRemove(tx: Tx, op: OpOf<"actor.effect.remove">): void {
  const resolved = tx.resolveActor(op.target);
  const effect = resolved.actor.effects.find((e) => e.id === op.effectId);
  if (!effect) throw gone("effect");
  tx.putActor(resolved, { ...resolved.actor, effects: resolved.actor.effects.filter((e) => e.id !== op.effectId) });
  tx.addActorEvents(resolved, [effectEvent(effect, "remove")]);
}
