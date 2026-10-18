import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, actor, room, token } from "#shared/testutil.ts";
import { vitals } from "./statSummary.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { QuickNumbers } = await import("./QuickNumbers.tsx");

/**
 * The quick numbers under a token's name (docs/design-v1-token-panel-groups.md 3),
 * from each viewer's own copy of the room, as the panel reads it: what
 * `vitals()` gives that viewer, initiative by the same rule, and each unit
 * named in full.
 */
function numbersFor(viewer: typeof DM, t: Token): { names: string[]; markup: string } {
  const state = room();
  state.tokens[t.id] = t;
  const view = projectState(state, viewer, { sceneId: "s1" });
  const seen = view.tokens[t.id] as Token;
  const a = ("inline" in seen.actor ? seen.actor.inline : undefined) as Partial<Actor> | undefined;
  const full = viewer.role === "dm" || (seen.ownerIds ?? []).includes(viewer.memberId);
  const items = vitals({ actor: a, token: seen, fullAccess: full, place: "panel" });
  const markup = renderToStaticMarkup(createElement(QuickNumbers, { items, actor: a, token: seen }));
  return { names: [...markup.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]!), markup };
}

describe("the quick numbers under a token's name", () => {
  test("the DM reads AC, speed, Passive Perception, initiative, the elevation and the sheet link, each named in full", () => {
    const t = token("g", { elevation: 20, actor: { inline: actor({ ac: 15, speeds: { walk: 30, fly: 60 }, passivePerception: 14, initBonus: 2, sheetUrl: "https://www.dndbeyond.com/characters/12345" }) } });
    const { names, markup } = numbersFor(DM, t);
    assert.deepEqual(names, ["Armor Class 15", "Speed 30 ft, Fly 60 ft", "Passive Perception 14", "Initiative +2", "Elevation 20 ft", "Open the sheet"]);
    assert.match(markup, />PP<\/span><strong>14<\/strong>/, "a short word beside the number, read at once on a phone");
    assert.match(markup, /href="https:\/\/www\.dndbeyond\.com\/characters\/12345" target="_blank" rel="noopener noreferrer"/);
  });

  test("a player looking at a monster reads only what their copy holds: its elevation", () => {
    const t = token("g", { elevation: -10, actor: { inline: actor({ ac: 15, passivePerception: 14, initBonus: -1, sheetUrl: "https://www.dndbeyond.com/characters/12345" }) } });
    const { names } = numbersFor(P1, t);
    assert.deepEqual(names, ["Elevation -10 ft"]);
  });

  test("an owner reads their own creature's numbers, a negative initiative signed", () => {
    const t = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ ac: 12, initBonus: -1 }) } });
    const { names } = numbersFor(P1, t);
    assert.ok(names.includes("Initiative −1"));
    assert.ok(names.includes("Armor Class 12"));
  });

  test("an object has no speed, Passive Perception or initiative, and nothing draws when there is nothing to say", () => {
    const chest = token("o", { kind: "object", actor: { inline: actor({ ac: 0, passivePerception: undefined, initBonus: 3 }) } });
    const { names, markup } = numbersFor(DM, chest);
    assert.equal(names.some((n) => /Speed|Passive|Initiative/.test(n)), false);
    if (names.length === 0) assert.equal(markup, "");
  });
});
