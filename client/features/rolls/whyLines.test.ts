import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_CHROME, freeArea, MIN_BAR_HEIGHT } from "../../canvas/barDock.ts";
import { footFold, measureWhy, NO_WHY, WHY_QUIET_ATTR, type WhyLines } from "./whyLines.ts";

/*
 * Why a player's Roll waits keeps to screen readers only where its line
 * would squeeze a held strip (B53-SOL-04, B53-OPUS-9): the fold reads the
 * card's last measure alone, and credits only lines the card has.
 */

const viewport = { width: 375, height: 667 };
const chrome = DEFAULT_CHROME;
const fold = (foot: number, why: WhyLines, held = true) => footFold({ viewport, chrome, foot, held, atFoot: true, why });
/** The tallest card the strip still fits beside at 375 x 667. */
const LAST_FIT = freeArea(viewport, chrome, 0).height - MIN_BAR_HEIGHT;

describe("the waiting reason and a held strip", () => {
  test("a card with no reason line folds at the strip's minimum, with nothing credited for a line it does not have", () => {
    assert.deepEqual(fold(LAST_FIT, NO_WHY), { quietWhy: false, squeezed: false });
    assert.deepEqual(fold(LAST_FIT + 1, NO_WHY), { quietWhy: false, squeezed: true });
    // A known bonus: the card measured with no line at all.
    assert.deepEqual(fold(400, { id: "r1", inFlow: 0, shown: 0, content: 0 }), { quietWhy: false, squeezed: true }, "400 px leaves 139 px for the bar");
  });

  test("a line that would squeeze the strip keeps to screen readers, and the card stands without it", () => {
    const shown = { id: "r1", inFlow: 20, shown: 20, content: 0 };
    assert.deepEqual(fold(LAST_FIT + 10, shown), { quietWhy: true, squeezed: false });
    // Measured again with the line kept back, the answer holds, so the line never comes straight back.
    assert.deepEqual(fold(LAST_FIT - 10, { id: "r1", inFlow: 0, shown: 20, content: 0 }), { quietWhy: true, squeezed: false });
    // A card too tall even without its line still folds.
    assert.deepEqual(fold(LAST_FIT + 30, shown), { quietWhy: true, squeezed: true });
    // A line that fits stays shown.
    assert.deepEqual(fold(LAST_FIT, shown), { quietWhy: false, squeezed: false });
  });

  test("the first render, before any measure, neither keeps the line back nor folds, and the measure decides", () => {
    assert.deepEqual(fold(0, NO_WHY), { quietWhy: false, squeezed: false });
    assert.deepEqual(fold(LAST_FIT + 10, { id: "r1", inFlow: 20, shown: 20, content: 0 }), { quietWhy: true, squeezed: false });
  });

  test("a line a short screen's rule takes out credits nothing, and without a held strip or chrome nothing changes", () => {
    assert.deepEqual(fold(LAST_FIT + 10, { id: "r1", inFlow: 0, shown: 0, content: 0 }), { quietWhy: false, squeezed: true });
    assert.deepEqual(fold(LAST_FIT + 10, { id: "r1", inFlow: 20, shown: 20, content: 0 }, false), { quietWhy: false, squeezed: false });
    assert.deepEqual(footFold({ viewport, chrome: null, foot: 900, held: true, atFoot: true, why: { id: "r1", inFlow: 20, shown: 20, content: 0 } }), { quietWhy: false, squeezed: false });
  });
});

describe("a card at its cap (B53-SOL-05)", () => {
  // Several targets, four reason lines of 85.6 px in all, on a card capped at 466.9 px whose content scrolls.
  const lines = 85.6;
  test("a card whose content still passes its cap once its lines keep back folds, since keeping them back frees no height", () => {
    const capped = { id: "r1", inFlow: lines, shown: lines, content: 600 };
    assert.ok(freeArea(viewport, chrome, 466.9).height < MIN_BAR_HEIGHT, "72 px for the bar at the cap");
    assert.deepEqual(fold(466.9, capped), { quietWhy: true, squeezed: true });
    // Measured again with the lines kept back, the card is still at its cap and still folds.
    assert.deepEqual(fold(466.9, { ...capped, inFlow: 0, content: 600 - lines }), { quietWhy: true, squeezed: true });
  });

  test("a card that falls under its cap once its lines keep back stands, with the lines kept back", () => {
    const capped = { id: "r1", inFlow: lines, shown: lines, content: 420 };
    assert.deepEqual(fold(400, capped), { quietWhy: true, squeezed: false });
    // Kept back, the card stands at its content's height, and showing the lines again would put it back at its cap.
    assert.deepEqual(fold(420 - lines, { ...capped, inFlow: 0, content: 420 - lines }), { quietWhy: true, squeezed: false });
  });
});

describe("measuring the reason lines", () => {
  type Line = { quiet: boolean; position: string; height: number; gap: string };
  /** The card's box: its drawn height, and its layout heights with what scrolls. None stands for a card not laid out. */
  type Box = { drawn: number; offset: number; client: number; scroll: number };
  const NO_BOX: Box = { drawn: 0, offset: 0, client: 0, scroll: 0 };
  const card = (lines: Line[], box: Box = NO_BOX) =>
    ({
      getBoundingClientRect: () => ({ height: box.drawn }),
      offsetHeight: box.offset,
      clientHeight: box.client,
      scrollHeight: box.scroll,
      querySelectorAll: () =>
        lines.map((l) => ({
          hasAttribute: (name: string) => name === WHY_QUIET_ATTR && l.quiet,
          getBoundingClientRect: () => ({ height: l.height }),
          parentElement: { gap: l.gap },
          position: l.position,
        })),
    }) as unknown as HTMLElement;
  const styled = <T,>(run: () => T): T => {
    const g = globalThis as unknown as { getComputedStyle?: unknown };
    const before = g.getComputedStyle;
    g.getComputedStyle = (el: { position?: string; gap?: string }) => ({ position: el.position ?? "static", rowGap: el.gap ?? "normal" });
    try {
      return run();
    } finally {
      g.getComputedStyle = before;
    }
  };
  const shownLine = { quiet: false, position: "static", height: 16, gap: "8px" };

  test("a shown line counts its drawn height at the card's own scale and its grid's gap, and the content takes in what scrolls and the borders (B53-SOL-06)", () => {
    // A 20 px drawn line at 200% is 10 px, and its 4 px gap is in the card's own pixels already. The card stands 400 px with 2 px of borders and 518 px of content inside them.
    const box = { drawn: 800, offset: 400, client: 398, scroll: 518 };
    assert.deepEqual(styled(() => measureWhy(card([{ ...shownLine, height: 20, gap: "4px" }], box), "r1", 2, NO_WHY)), { id: "r1", inFlow: 14, shown: 14, content: 520 });
  });

  test("no line, or one a short screen's rule takes out of the flow, counts nothing", () => {
    assert.deepEqual(styled(() => measureWhy(card([]), "r1", 1, { id: "r1", inFlow: 24, shown: 24, content: 0 })), { id: "r1", inFlow: 0, shown: 0, content: 0 });
    assert.deepEqual(styled(() => measureWhy(card([{ ...shownLine, position: "absolute", height: 1 }]), "r1", 1, NO_WHY)), { id: "r1", inFlow: 0, shown: 0, content: 0 });
  });

  test("a line kept back keeps the height it showed at for the same request only, and an unchanged measure is the same object", () => {
    const was = { id: "r1", inFlow: 24, shown: 24, content: 0 };
    const quiet = { ...shownLine, quiet: true, position: "absolute", height: 1 };
    assert.deepEqual(styled(() => measureWhy(card([quiet]), "r1", 1, was)), { id: "r1", inFlow: 0, shown: 24, content: 0 });
    assert.deepEqual(styled(() => measureWhy(card([quiet]), "r2", 1, was)), { id: "r2", inFlow: 0, shown: 0, content: 0 });
    const same = { id: "r1", inFlow: 24, shown: 24, content: 0 };
    assert.equal(styled(() => measureWhy(card([shownLine]), "r1", 1, same)), same);
  });
});
