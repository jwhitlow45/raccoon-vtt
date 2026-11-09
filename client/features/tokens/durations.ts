import { clockNow, DAY_SECONDS, dateText, fightStarted, ROUND_SECONDS, timeText } from "#shared/calendar.ts";
import { LIMITS } from "#shared/limits.ts";
import type { DurationAnchor, Effect, EffectEnds, RoomClock, RoomState } from "#shared/model.ts";
import type { DurationInput } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";

/**
 * The duration form for effects (design section 9.5): "Start of X's next
 * turn", "End of X's next turn", or "N rounds", with X picked from the
 * encounter or the creature itself, or a time span, which counts the room's
 * clock and names no creature (docs/design/design-v1-calendar-c2c3.md 3.1).
 * The reducer turns a turn choice into boundary crossings
 * (shared/rules/durations.ts) and a span into an end on the clock, so the
 * client only builds the input and later describes what was stored.
 */

/** The fixed time spans are modes of their own, named by their seconds, so the Duration select lists them in one run (docs/design/design-v1-calendar-c2c3.md 3.1). */
export type SpanMode = "span60" | "span600" | "span3600" | "span28800" | "span86400" | "spanOther";
/** "keep" is only offered on an effect that already has a count or an end: it leaves that alone, so No duration is a real change away from it. */
export type DurationMode = "keep" | "none" | "turnStart" | "turnEnd" | "rounds" | SpanMode;
export type SpanUnit = "minutes" | "hours" | "days";

export type DurationForm = {
  mode: DurationMode;
  rounds: number;
  anchorKey: string;
  /** Other length of time: the number as typed, and its unit. */
  length: string;
  unit: SpanUnit;
};

export type AnchorOption = { key: string; label: string; anchor: DurationAnchor };

/** The creature the effect is on: its token on the map, or its character card. */
export type SelfRef = { tokenId: string } | { characterId: string };

export const SELF_KEY = "self";
export const MAX_ROUNDS = 1_000;

type View = Pick<RoomState, "tokens" | "characters" | "encounter">;

export const DURATION_MODES: readonly { mode: DurationMode; label: string }[] = [
  { mode: "none", label: "No duration" },
  { mode: "turnStart", label: "Start of X's next turn" },
  { mode: "turnEnd", label: "End of X's next turn" },
  { mode: "rounds", label: "N rounds" },
];

/** The time spans, listed after the turn choices while the viewer's room view holds a clock. */
export const SPAN_MODES: readonly { mode: SpanMode; label: string; seconds: number }[] = [
  { mode: "span60", label: "1 minute", seconds: 60 },
  { mode: "span600", label: "10 minutes", seconds: 600 },
  { mode: "span3600", label: "1 hour", seconds: 3_600 },
  { mode: "span28800", label: "8 hours", seconds: 28_800 },
  { mode: "span86400", label: "24 hours", seconds: DAY_SECONDS },
  { mode: "spanOther", label: "Other length of time", seconds: 0 },
];

export function isSpanMode(mode: DurationMode): mode is SpanMode {
  return mode.startsWith("span");
}

export const SPAN_UNITS: readonly { value: SpanUnit; label: string; seconds: number }[] = [
  { value: "minutes", label: "Minutes", seconds: 60 },
  { value: "hours", label: "Hours", seconds: 3_600 },
  { value: "days", label: "Days", seconds: DAY_SECONDS },
];

export const SPAN_RANGE = "Pick a length from 1 minute to 365 days.";

/** Other length of time: the seconds a count of a unit makes, or why it is not a time span. */
export function spanLength(text: string, unit: SpanUnit): { ok: true; seconds: number } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return { ok: false, reason: SPAN_RANGE };
  const seconds = Number(trimmed) * SPAN_UNITS.find((u) => u.value === unit)!.seconds;
  return seconds >= 60 && seconds <= LIMITS.effectSpanMax ? { ok: true, seconds } : { ok: false, reason: SPAN_RANGE };
}

/** What the form's time span asks for, or null while the form holds a turn choice. */
export function spanSeconds(form: DurationForm): ReturnType<typeof spanLength> | null {
  if (!isSpanMode(form.mode)) return null;
  if (form.mode === "spanOther") return spanLength(form.length, form.unit);
  return { ok: true, seconds: SPAN_MODES.find((m) => m.mode === form.mode)!.seconds };
}

/** "1 minute", "90 minutes", "8 hours", "24 hours", "2 days": the length as the picker names it. */
export function spanWords(seconds: number): string {
  const [n, unit] =
    seconds > DAY_SECONDS && seconds % DAY_SECONDS === 0 ? [seconds / DAY_SECONDS, "day"] : seconds % 3_600 === 0 ? [seconds / 3_600, "hour"] : [seconds / 60, "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** A name for whoever an anchor points at, from this viewer's own projection. */
export function anchorName(view: View | null | undefined, anchor: DurationAnchor): string {
  if ("entryId" in anchor) {
    const entry = view?.encounter?.entries.find((e) => e.id === anchor.entryId);
    if (!entry) return "another creature";
    if (entry.tokenId !== undefined) {
      const token = view?.tokens[entry.tokenId];
      if (token) return displayName(token);
    }
    if (entry.characterId !== undefined) {
      const character = view?.characters[entry.characterId];
      if (character) return character.name;
    }
    return entry.label ?? "another creature";
  }
  if ("tokenId" in anchor) {
    const token = view?.tokens[anchor.tokenId];
    return token ? displayName(token) : "another creature";
  }
  return view?.characters[anchor.characterId]?.name ?? "another creature";
}

/** Whether an encounter row stands for the creature itself, through its token or its character. */
export function entryIsSelf(view: View, entry: { tokenId?: string; characterId?: string }, self: SelfRef): boolean {
  const selfCharacter =
    "characterId" in self ? self.characterId : (() => {
      const token = view.tokens[self.tokenId];
      return token && "ref" in token.actor ? token.actor.ref : undefined;
    })();
  if ("tokenId" in self && entry.tokenId === self.tokenId) return true;
  if (selfCharacter === undefined) return false;
  if (entry.characterId === selfCharacter) return true;
  const token = entry.tokenId !== undefined ? view.tokens[entry.tokenId] : undefined;
  return token !== undefined && "ref" in token.actor && token.actor.ref === selfCharacter;
}

/**
 * The creatures a duration can count on: the effect's own creature first,
 * then every other row of the encounter this viewer can see, in turn order.
 * The creature's own row is folded into the first option, since the reducer
 * finds that row from the token or character anyway.
 */
export function anchorOptions(view: View | null | undefined, self: SelfRef, selfLabel: string): AnchorOption[] {
  const options: AnchorOption[] = [{ key: SELF_KEY, label: `${selfLabel} (${selfWords(view, self)})`, anchor: self }];
  if (!view?.encounter) return options;
  for (const entry of view.encounter.entries) {
    if (entryIsSelf(view, entry, self)) continue;
    options.push({ key: `entry:${entry.id}`, label: anchorName(view, { entryId: entry.id }), anchor: { entryId: entry.id } });
  }
  return options;
}

/**
 * How the effect's own creature reads among the choices: "this creature",
 * or for a companion that acts on its character's turn, whose turn its
 * durations count (docs/design/design-v1-combat-flow.md 3.6.8), "on Bree's turn".
 */
function selfWords(view: View | null | undefined, self: SelfRef): string {
  const companion = "tokenId" in self ? view?.tokens[self.tokenId]?.companion : undefined;
  if (!companion || companion.turn === "own") return "this creature";
  return `on ${view?.characters[companion.of]?.name ?? "its character"}'s turn`;
}

/**
 * A new duration counts on whoever is acting, so "Bless for 10 rounds" cast
 * on the cleric's turn counts the cleric's turns. Outside combat, or when the
 * active row is hidden from this viewer, it counts on the creature itself.
 */
export function defaultAnchorKey(view: View | null | undefined, options: AnchorOption[]): string {
  const active = view?.encounter?.activeEntryId;
  if (active) {
    const key = `entry:${active}`;
    if (options.some((o) => o.key === key)) return key;
    const self = options.find((o) => o.key === SELF_KEY);
    if (self && view?.encounter?.entries.some((e) => e.id === active && entryIsSelf(view, e, self.anchor as SelfRef))) return SELF_KEY;
  }
  return SELF_KEY;
}

export function emptyForm(view: View | null | undefined, options: AnchorOption[]): DurationForm {
  return { mode: "none", rounds: 10, anchorKey: defaultAnchorKey(view, options), length: "", unit: "hours" };
}

/** The form an editor opens on: Keep current duration while the effect has a count or an end to keep. */
export function openingForm(existing: Pick<Effect, "duration" | "ends"> | undefined, view: View | null | undefined, options: AnchorOption[]): DurationForm {
  const form = emptyForm(view, options);
  return existing && (existing.duration || existing.ends) ? { ...form, mode: "keep" } : form;
}

/**
 * What an existing effect's update patch holds for `duration`: nothing until the user changed Duration, and nothing
 * while the form says Keep. The touch is tracked apart from the mode because an effect opened with no duration has no
 * Keep to rest on, and another device may add one while the editor is open.
 */
export function durationEdit(existing: Pick<Effect, "duration" | "ends">, form: DurationForm, options: AnchorOption[], touched: boolean): DurationInput | null | undefined {
  return !touched || form.mode === "keep" ? undefined : durationChange(existing, durationInput(form, options));
}

/** Whether the mode counts turns of a creature, so the form asks whose. */
export function namesCreature(mode: DurationMode): boolean {
  return mode === "turnStart" || mode === "turnEnd" || mode === "rounds";
}

/**
 * The op's duration input, or null for "No duration". An unknown anchor
 * falls back to the creature itself. An Other length that is not a time
 * span also gives null, and the form refuses it first (`spanSeconds`).
 */
export function durationInput(form: DurationForm, options: AnchorOption[]): DurationInput | null {
  if (isSpanMode(form.mode)) {
    const span = spanSeconds(form);
    return span?.ok ? { mode: "span", seconds: span.seconds } : null;
  }
  const option = options.find((o) => o.key === form.anchorKey) ?? options.find((o) => o.key === SELF_KEY);
  if (!option || form.mode === "none") return null;
  const of = option.anchor;
  switch (form.mode) {
    case "turnStart":
      return { mode: "turnStart", of };
    case "turnEnd":
      return { mode: "turnEnd", of };
    case "rounds": {
      const rounds = Math.min(MAX_ROUNDS, Math.max(1, Math.floor(Number.isFinite(form.rounds) ? form.rounds : 1)));
      return { mode: "rounds", rounds, of };
    }
  }
  return null;
}

/**
 * What the update patch's `duration` holds once the DM or owner touched
 * Duration: the new input, `null` to take away a count of turns or a time
 * span's end (No duration on a timed effect included), or undefined when
 * there was nothing to take away.
 */
export function durationChange(existing: Pick<Effect, "duration" | "ends">, input: DurationInput | null): DurationInput | null | undefined {
  if (input) return input;
  return existing.duration || existing.ends ? null : undefined;
}

export function isPaused(duration: NonNullable<Effect["duration"]>): boolean {
  return !("entryId" in duration.anchor);
}

/**
 * The stored duration in words. A duration whose creature is not in the
 * encounter is paused and says so, keeping its count for when the creature
 * joins (design 9.5).
 */
export function describeDuration(view: View | null | undefined, duration: NonNullable<Effect["duration"]>): string {
  const who = anchorName(view, duration.anchor);
  const active = "entryId" in duration.anchor && view?.encounter?.activeEntryId === duration.anchor.entryId;
  const r = duration.remaining;
  let text: string;
  if (duration.boundary === "turnStart") {
    text = r <= 1 ? `Until the start of ${who}'s next turn` : `${r} rounds left, ending at the start of ${who}'s turn`;
  } else if (r <= 1) {
    text = active ? `Until the end of ${who}'s current turn` : `Until the end of ${who}'s next turn`;
  } else if (r === 2 && active) {
    text = `Until the end of ${who}'s next turn`;
  } else {
    text = `Ends after ${r} more of ${who}'s turns`;
  }
  return isPaused(duration) ? `${text}, paused (outside combat)` : text;
}

type EndsView = { clock?: Pick<RoomClock, "id" | "t" | "calendar"> | null | undefined; encounter?: RoomState["encounter"] | null | undefined };

/** "48 minutes left": the time to the end, rounded up to the unit it reads in. */
function timeLeft(seconds: number): string {
  const [n, unit] = seconds < 3_600 ? [Math.ceil(seconds / 60), "minute"] : seconds < DAY_SECONDS ? [Math.ceil(seconds / 3_600), "hour"] : [Math.ceil(seconds / DAY_SECONDS), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} left`;
}

/**
 * A time span in words (docs/design/design-v1-calendar-c2c3.md 3.2). Outside a
 * fight it names the end and the time left, in a started fight the round it
 * ends at the start of, and a copy with no end (a player whose view holds no
 * clock) only the length. An end on a clock that stopped or was replaced
 * never comes by itself, which the DM's copy says.
 */
export function describeEnds(view: EndsView | null | undefined, ends: EffectEnds): string {
  const lasts = `Lasts ${spanWords(ends.span)}`;
  if (ends.at === undefined) return lasts;
  const clock = view?.clock;
  if (!clock || clock.id !== ends.clock) return `${lasts}, on a clock that stopped`;
  const encounter = view?.encounter;
  const now = clockNow(clock, encounter);
  if (encounter && fightStarted(encounter)) return `${lasts}, to the start of round ${encounter.round + Math.ceil((ends.at - now) / ROUND_SECONDS)}`;
  const sameDay = Math.floor(ends.at / DAY_SECONDS) === Math.floor(now / DAY_SECONDS);
  const to = sameDay ? timeText(ends.at) : `${dateText(ends.at, clock.calendar, "short")}, ${timeText(ends.at)}`;
  return `${lasts}, to ${to} (${timeLeft(Math.max(0, ends.at - now))})`;
}
