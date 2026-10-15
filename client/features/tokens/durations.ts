import type { DurationAnchor, Effect, RoomState } from "#shared/model.ts";
import type { DurationInput } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";

/**
 * The duration form for effects (design section 9.5): "until the start of
 * X's next turn", "until the end of X's next turn", or "N rounds", with X
 * picked from the encounter or the creature itself. The reducer turns the
 * choice into boundary crossings (shared/rules/durations.ts), so the client
 * only builds the input and later describes what was stored.
 */

export type DurationMode = "none" | "turnStart" | "turnEnd" | "rounds";

export type DurationForm = { mode: DurationMode; rounds: number; anchorKey: string };

export type AnchorOption = { key: string; label: string; anchor: DurationAnchor };

/** The creature the effect is on: its token on the map, or its character card. */
export type SelfRef = { tokenId: string } | { characterId: string };

export const SELF_KEY = "self";
export const MAX_ROUNDS = 1_000;

type View = Pick<RoomState, "tokens" | "characters" | "encounter">;

export const DURATION_MODES: readonly { mode: DurationMode; label: string }[] = [
  { mode: "none", label: "No duration" },
  { mode: "turnStart", label: "Until the start of X’s next turn" },
  { mode: "turnEnd", label: "Until the end of X’s next turn" },
  { mode: "rounds", label: "N rounds" },
];

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
  const options: AnchorOption[] = [{ key: SELF_KEY, label: `${selfLabel} (this creature)`, anchor: self }];
  if (!view?.encounter) return options;
  for (const entry of view.encounter.entries) {
    if (entryIsSelf(view, entry, self)) continue;
    options.push({ key: `entry:${entry.id}`, label: anchorName(view, { entryId: entry.id }), anchor: { entryId: entry.id } });
  }
  return options;
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
  return { mode: "none", rounds: 10, anchorKey: defaultAnchorKey(view, options) };
}

/** The op's duration input, or null for "No duration". An unknown anchor falls back to the creature itself. */
export function durationInput(form: DurationForm, options: AnchorOption[]): DurationInput | null {
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
    text = r <= 1 ? `Until the start of ${who}’s next turn` : `${r} rounds left, ending at the start of ${who}’s turn`;
  } else if (r <= 1) {
    text = active ? `Until the end of ${who}’s current turn` : `Until the end of ${who}’s next turn`;
  } else if (r === 2 && active) {
    text = `Until the end of ${who}’s next turn`;
  } else {
    text = `Ends after ${r} more of ${who}’s turns`;
  }
  return isPaused(duration) ? `${text}, paused (outside combat)` : text;
}
