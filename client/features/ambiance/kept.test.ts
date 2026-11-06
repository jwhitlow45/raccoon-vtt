import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { keptSections, NO_SECTIONS, shownSections, type AmbianceSections } from "./kept.ts";

/*
 * A player's Ambiance (docs/design/design-v1-panel-groups.md 5, D-261102-755
 * and 762): Time while the view holds the clock, Sound while something plays
 * they receive, each kept once shown until Ambiance closes, and the empty
 * line when an Ambiance open with nothing to show draws neither.
 */

describe("a player's kept sections", () => {
  test("a section shown while open stays after its reason stops, until Ambiance closes", () => {
    let kept = keptSections(NO_SECTIONS, { open: true, clock: true, sound: false });
    assert.deepEqual(kept, { time: true, sound: false });
    kept = keptSections(kept, { open: true, clock: false, sound: false });
    assert.deepEqual(shownSections(kept, { clock: false, sound: false }), { time: true, sound: false }, "the DM stopped sharing: Time stays, saying so");
    kept = keptSections(kept, { open: true, clock: false, sound: true });
    assert.deepEqual(shownSections(kept, { clock: false, sound: true }), { time: true, sound: true }, "music starts while open: Sound comes under Time");
    kept = keptSections(kept, { open: false, clock: false, sound: true });
    assert.deepEqual(kept, NO_SECTIONS, "closing lets every kept section go");
  });

  test("closed, nothing is kept, whatever plays", () => {
    assert.deepEqual(keptSections({ time: true, sound: true }, { open: false, clock: true, sound: true }), NO_SECTIONS);
  });

  test("opened with nothing to show, such as a restored split or an old id, draws neither section: the empty line", () => {
    const kept = keptSections(NO_SECTIONS, { open: true, clock: false, sound: false });
    assert.deepEqual(shownSections(kept, { clock: false, sound: false }), { time: false, sound: false });
  });

  test("the same object back while nothing changes, so the store holding it never wakes its readers for nothing", () => {
    const kept = keptSections(NO_SECTIONS, { open: true, clock: true, sound: false });
    assert.equal(keptSections(kept, { open: true, clock: true, sound: false }), kept);
    assert.equal(keptSections(NO_SECTIONS, { open: false, clock: true, sound: true }), NO_SECTIONS);
  });

  test("1,000 random runs of opening, closing, restoring and the clock and sound coming and going keep the rules", () => {
    type Step = { t: "open" } | { t: "close" } | { t: "restore" } | { t: "clock"; on: boolean } | { t: "sound"; on: boolean };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.constant({ t: "open" } as const),
      fc.constant({ t: "close" } as const),
      // A restored split or rvtt.reopen opens Ambiance with whatever the view holds then, as an open does.
      fc.constant({ t: "restore" } as const),
      fc.boolean().map((on) => ({ t: "clock", on }) as const),
      fc.boolean().map((on) => ({ t: "sound", on }) as const),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        let open = false;
        let clock = false;
        let sound = false;
        let kept: AmbianceSections = NO_SECTIONS;
        // What a correct Ambiance must keep: each section that showed since it last opened.
        let since = { time: false, sound: false };
        for (const s of steps) {
          if (s.t === "open" || s.t === "restore") open = true;
          else if (s.t === "close") open = false;
          else if (s.t === "clock") clock = s.on;
          else sound = s.on;
          if (!open) since = { time: false, sound: false };
          else since = { time: since.time || clock, sound: since.sound || sound };
          kept = keptSections(kept, { open, clock, sound });
          const shown = shownSections(kept, { clock, sound });
          // A section shows only while its condition holds or since it was kept while open.
          if (open) assert.deepEqual(shown, since);
          // Closing clears every kept section.
          if (!open) assert.deepEqual(kept, NO_SECTIONS);
          // An open Ambiance shows a section or, with neither, its empty line: never a section it has no reason for.
          if (open && (shown.time || shown.sound)) assert.ok((shown.time && since.time) || (shown.sound && since.sound));
          if (shown.time && open) assert.ok(clock || since.time);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
