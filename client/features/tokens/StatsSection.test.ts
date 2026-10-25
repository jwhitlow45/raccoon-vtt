import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { StatsFields, foldedSpeeds } = await import("./StatsSection.tsx");

/** Stats as a viewer who may set speeds, or one who may not, sees them. */
function stats(speeds: Parameters<typeof foldedSpeeds>[0], canEdit: boolean): string {
  return renderToStaticMarkup(createElement(StatsFields, { actor: actor({ speeds }), canEdit: () => canEdit, onPatch() {}, dm: canEdit }));
}

describe("other speeds fold under Walk (docs/design-v1-look-pass.md 3.1, L14)", () => {
  test("a walker's Stats: Walk, then Other speeds folded, with no row of none", () => {
    const html = stats({ walk: 30 }, true);
    assert.match(html, /aria-label="Walk Speed"/);
    for (const speed of ["Fly", "Swim", "Climb", "Burrow"]) assert.doesNotMatch(html, new RegExp(`${speed} Speed`), `${speed} is folded away`);
    assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>.*Other speeds/);
    assert.doesNotMatch(html, /Hovers/, "Hovers is in the fold");
  });

  test("a speed that is set gets its own row after Walk, and the fold holds the rest", () => {
    const html = stats({ walk: 30, fly: 60 }, true);
    const walk = html.indexOf('aria-label="Walk Speed"');
    const fly = html.indexOf('aria-label="Fly Speed"');
    const fold = html.indexOf("Other speeds");
    assert.ok(walk >= 0 && walk < fly && fly < fold, "Walk, Fly, then the fold");
    assert.deepEqual(foldedSpeeds({ walk: 30, fly: 60 }, null), ["swim", "climb", "burrow"]);
  });

  test("folded, the fold names Hovers when it is on", () => {
    assert.match(stats({ walk: 30, hover: true }, true), /Other speeds.*Hovers/);
  });

  test("open, the fold keeps what it held as it opened, so a speed typed there stays put", () => {
    assert.deepEqual(foldedSpeeds({ walk: 30, swim: 20 }, ["fly", "swim", "climb", "burrow"]), ["fly", "swim", "climb", "burrow"]);
  });

  test("a viewer who may not set speeds reads the ones that are set, and no fold", () => {
    const html = stats({ walk: 30, climb: 20, hover: true }, false);
    assert.match(html, /Walk Speed/);
    assert.match(html, /Climb Speed/);
    assert.doesNotMatch(html, /Fly Speed|Other speeds/);
    assert.match(html, /Hovers\./);
  });
});

describe("the legendary maxima (docs/design-v1-token-sections.md 3.1)", () => {
  test("the DM's Stats sets how many a round and a day, and leaves how many are used to the pips in Uses", () => {
    const legendary = { actionsMax: 3, actionsUsed: 1, resistMax: 3, resistUsed: 0 };
    const html = renderToStaticMarkup(createElement(StatsFields, { actor: actor({ legendary }), canEdit: () => true, onPatch() {}, dm: true }));
    assert.match(html, /Legendary Actions per round/);
    assert.match(html, /Legendary Resistance per day/);
    assert.doesNotMatch(html, /Legendary Actions used|Legendary Resistance used|Actions used|Resistances used/);
  });
});
