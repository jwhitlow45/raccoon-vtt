import { stripSqueezed, type Chrome } from "../../canvas/barDock.ts";
import type { Size } from "../../lib/camera.ts";

/*
 * Why a player's Roll waits, under the roll row (PlayerRolls.tsx
 * CreatureAnswer), keeps to screen readers where its line would leave a
 * held strip too little room (canvas/barDock.ts stripSqueezed): the card
 * would fold for the strip, and the dock's Roll asked would bring nothing.
 * Plain functions, so the arithmetic runs under node --test.
 */

/**
 * The waiting-reason lines of the card at a phone's foot, as its last
 * measure found them: the px they took in its height then (`inFlow`), and
 * the px they take shown (`shown`). Both are 0 where the card has none and
 * where a short screen's rule (globals.css, rvtt-roll-why) already takes
 * them out of the flow. `id` is the request the card answers.
 */
export type WhyLines = { id: string | null; inFlow: number; shown: number };

export const NO_WHY: WhyLines = { id: null, inFlow: 0, shown: 0 };

/** The attribute a line kept back for a held strip carries, so a measure tells it from one a short screen's rule takes out. */
export const WHY_QUIET_ATTR = "data-why-quiet";

/**
 * Whether the card keeps its lines to screen readers (`quietWhy`) and
 * whether it folds for the strip (`squeezed`), in one pass from the last
 * measure. Both read the card's height with its lines shown, so keeping
 * them back, which frees the room, never brings them straight back, and a
 * card that folded with its lines showing comes back without them. Only
 * lines the card has count: one with none gains nothing by keeping quiet.
 */
export function footFold(input: { viewport: Size; chrome: Chrome | null; foot: number; held: boolean; atFoot: boolean; why: WhyLines }): { quietWhy: boolean; squeezed: boolean } {
  const { viewport, chrome, held, why } = input;
  if (chrome === null) return { quietWhy: false, squeezed: false };
  const bare = input.foot - why.inFlow;
  const whole = bare + why.shown;
  const quietWhy = input.atFoot && why.shown > 0 && stripSqueezed({ viewport, chrome, foot: whole, held });
  return { quietWhy, squeezed: stripSqueezed({ viewport, chrome, foot: quietWhy ? bare : whole, held }) };
}

/**
 * The card's lines as laid out now, in its own pixels (`zoom` taken out,
 * as its height is). A line kept back for the strip keeps the height it
 * showed at for the same request, and one a short screen's rule takes out
 * of the flow counts nothing. Returns `was` itself when nothing changed, so
 * a state holding it renders nothing new.
 */
export function measureWhy(card: HTMLElement, id: string, zoom: number, was: WhyLines): WhyLines {
  let inFlow = 0;
  let quiet = false;
  for (const el of card.querySelectorAll<HTMLElement>(".rvtt-roll-why")) {
    if (el.hasAttribute(WHY_QUIET_ATTR)) {
      quiet = true;
      continue;
    }
    if (getComputedStyle(el).position === "absolute") continue;
    // A line takes its height and the gap of the grid it stands in.
    inFlow += el.getBoundingClientRect().height + (parseFloat(getComputedStyle(el.parentElement ?? el).rowGap) || 0);
  }
  inFlow /= zoom;
  const shown = quiet ? (was.id === id ? was.shown : 0) : inFlow;
  return was.id === id && was.inFlow === inFlow && was.shown === shown ? was : { id, inFlow, shown };
}
