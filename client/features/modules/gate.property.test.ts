import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { DM, P1 } from "#shared/testutil.ts";

/*
 * The gating property (docs/design/design-v1-features.md 14, D-261127-125):
 * for random roles, choices (unknown ids included) and claim conditions
 * drawn both ways, the hidden set is closed over `needs` and keeps own
 * choices, every registry holds no entry of a hidden part and every other
 * entry as under Everything, and a Show turns on every unmet need. The
 * registries are the panels, the tools and the canvas's active tool, the
 * keys and the sheet, the search index, the top bar's parts and the
 * builder's modes.
 */

const { claimShown, EVERYTHING, hiddenModules, moduleShown, ownerOf, searchKey, toolShown } = await import("./gate.ts");
const { MODULE_IDS, MODULES, modulesFor, needsOf } = await import("./registry.ts");
const { NO_CHOICES, ownShown, withShow } = await import("./store.ts");
const { PANELS, panelsFor } = await import("../panels.ts");
const { TOOLS, activeTool, toolsFor } = await import("../tools.ts");
const { BEHAVIORS, SHORTCUTS, SURFACES, VIEW_BEHAVIORS, VIEW_SHORTCUTS, sheetSections, shortcutsFor } = await import("../../state/shortcuts.ts");
const { GATED_TOP_BAR_PARTS, shownBar } = await import("../../pages/topBarFit.ts");
const { BUILD_MODES } = await import("../builder/store.ts");
const { buildIndex } = await import("../search/index.ts");
const { DM_CATALOGS, PLAYER_CATALOGS, keysOf, seededRoom, towerRoom, towerView, viewOf } = await import("../search/search.testutil.ts");

type Role = "dm" | "player";
type FeatureChoices = import("./store.ts").FeatureChoices;

const role = fc.constantFrom<Role>("dm", "player");
const roleChoices = fc.dictionary(fc.constantFrom(...MODULE_IDS, "futurePart", "olderPart"), fc.boolean(), { maxKeys: 12 });
const choices: fc.Arbitrary<FeatureChoices> = fc.record({ dm: roleChoices, player: roleChoices });
const RUNS = { numRuns: 300 };

/** The entries a hidden part claims, by the gate's own owner map, under the conditions drawn. */
function claimedHidden(kind: Parameters<typeof ownerOf>[0], id: string, r: Role, c: FeatureChoices, oneFloor: boolean): boolean {
  const owner = ownerOf(kind, id);
  if (!owner || moduleShown(owner.module, r, c)) return false;
  return owner.when === undefined || (owner.when === "oneFloor" && oneFloor);
}

describe("the gating property", () => {
  test("the hidden set is closed over needs and keeps every own choice", () => {
    fc.assert(
      fc.property(role, choices, (r, c) => {
        const hidden = hiddenModules(r, c);
        for (const m of modulesFor(r)) {
          const expect = !ownShown(c, r, m.id) || needsOf(m.id).some((n) => !ownShown(c, r, n));
          assert.equal(hidden.has(m.id), expect, m.id);
          for (const n of needsOf(m.id)) if (hidden.has(n)) assert.ok(hidden.has(m.id), `${m.id} shows while its need ${n} hides`);
        }
        for (const id of hidden) assert.ok(modulesFor(r).some((m) => m.id === id), `${id} is not a ${r} part`);
      }),
      RUNS,
    );
  });

  test("a Show turns on every unmet need, and changes no other choice", () => {
    fc.assert(
      fc.property(role, choices, fc.constantFrom(...MODULE_IDS), (r, c, id) => {
        if (!modulesFor(r).some((m) => m.id === id)) return;
        const next = withShow(c, r, id);
        assert.ok(moduleShown(id, r, next), `${id} still hidden`);
        const touched = new Set<string>([id, ...needsOf(id)]);
        for (const key of new Set([...Object.keys(c[r]), ...Object.keys(next[r])])) if (!touched.has(key)) assert.equal(next[r][key], c[r][key], key);
        const other = r === "dm" ? "player" : "dm";
        assert.deepEqual(next[other], c[other]);
      }),
      RUNS,
    );
  });

  test("panels, tools and the canvas's tool hold no entry of a hidden part and every other one", () => {
    fc.assert(
      fc.property(role, choices, fc.boolean(), (r, c, wide) => {
        const base = panelsFor(r, wide, { choices: EVERYTHING, clock: true, sound: true }).map((p) => p.id);
        const got = panelsFor(r, wide, { choices: c, clock: true, sound: true }).map((p) => p.id);
        assert.deepEqual(got, base.filter((id) => !claimedHidden("panel", id, r, c, false)));
        const tools = toolsFor(r, undefined, c).map((t) => t.id);
        assert.deepEqual(tools, toolsFor(r, undefined, EVERYTHING).map((t) => t.id).filter((id) => !claimedHidden("tool", id, r, c, false)));
        for (const t of TOOLS) {
          const everything = activeTool(t.id, r, EVERYTHING).id;
          assert.equal(activeTool(t.id, r, c).id, claimedHidden("tool", t.id, r, c, false) ? "select" : everything, t.id);
          assert.equal(activeTool(t.id, r, c, true).id, everything, `${t.id} borrowed`);
          assert.equal(toolShown(t.id, r, c), !claimedHidden("tool", t.id, r, c, false));
        }
        for (const p of PANELS) assert.equal(claimShown("panel", p.id, r, c), !claimedHidden("panel", p.id, r, c, false));
      }),
      RUNS,
    );
  });

  test("the keys and the sheet hold no row of a hidden part and every other one", () => {
    fc.assert(
      fc.property(role, choices, (r, c) => {
        assert.deepEqual(
          shortcutsFor(r, c).map((s) => s.id),
          shortcutsFor(r, EVERYTHING).map((s) => s.id).filter((id) => !claimedHidden("shortcut", id, r, c, false)),
        );
        const device = { mouse: true, android: true };
        const rows = (cc: FeatureChoices) => sheetSections(r, device, undefined, cc).map((s) => [s.title, s.rows.map((row) => row.id)] as const);
        const hiddenRow = (id: string) => claimedHidden("shortcut", id, r, c, false) || claimedHidden("behavior", id, r, c, false);
        const expected = rows(EVERYTHING)
          .filter(([title]) => !(SURFACES as readonly string[]).includes(title) || !claimedHidden("surface", title, r, c, false))
          .map(([title, ids]) => [title, ids.filter((id) => !hiddenRow(id))] as const)
          .filter(([, ids]) => ids.length > 0);
        assert.deepEqual(rows(c), expected);
      }),
      RUNS,
    );
    // Every claimed key, row and surface is one the tables hold, so a renamed row cannot leave its claim behind.
    for (const m of MODULES) {
      for (const cl of m.claims) {
        if (cl.kind === "shortcut") assert.ok([...SHORTCUTS, ...VIEW_SHORTCUTS].some((s) => s.id === cl.id), `${m.id} ${cl.id}`);
        if (cl.kind === "behavior") assert.ok([...BEHAVIORS, ...VIEW_BEHAVIORS].some((b) => b.id === cl.id), `${m.id} ${cl.id}`);
        if (cl.kind === "surface") assert.ok((SURFACES as readonly string[]).includes(cl.id), `${m.id} ${cl.id}`);
        if (cl.kind === "tool") assert.ok(TOOLS.some((t) => t.id === cl.id), `${m.id} ${cl.id}`);
        if (cl.kind === "panel") assert.ok(PANELS.some((p) => p.id === cl.id), `${m.id} ${cl.id}`);
        if (cl.kind === "builderMode") assert.ok(BUILD_MODES.some((b) => b.value === cl.id), `${m.id} ${cl.id}`);
        if (cl.kind === "topBar") assert.ok((GATED_TOP_BAR_PARTS as readonly string[]).includes(cl.id), `${m.id} ${cl.id}`);
      }
    }
  });

  test("the search index holds no entry of a hidden part and every other one, Floors' by its condition both ways", () => {
    const rooms = [
      { view: (r: Role) => viewOf(seededRoom(), r === "dm" ? DM : P1), oneFloor: true },
      { view: (r: Role) => towerView(towerRoom(), r === "dm" ? DM : P1, "ground", ["ground", "upper", "attic"]), oneFloor: false },
    ];
    fc.assert(
      fc.property(role, choices, fc.constantFrom(0, 1), (r, c, which) => {
        const at = rooms[which]!;
        const state = at.view(r);
        const index = (cc: FeatureChoices) => buildIndex({ state, wide: true, keys: keysOf(state), catalogs: r === "dm" ? DM_CATALOGS : PLAYER_CATALOGS, monsters: null, soundFiles: true, choices: cc }).items.map((i) => i.entry.id);
        const hiddenEntry = (id: string) =>
          claimedHidden("search", searchKey(id), r, c, at.oneFloor) ||
          (id.startsWith("panel:") && claimedHidden("panel", id.slice(6), r, c, false)) ||
          (id.startsWith("key:") && claimedHidden("shortcut", id.slice(4), r, c, false));
        assert.deepEqual(index(c), index(EVERYTHING).filter((id) => !hiddenEntry(id)));
      }),
      { numRuns: 120 },
    );
  });

  test("the top bar and the builder's modes leave out exactly a hidden part's", () => {
    const content = { phone: false, role: "dm" as Role, search: true, nowPlaying: true, clock: true, blackout: false, fullscreen: true, phase: false, gaps: true, view: true, volume: true, floor: false, strip: "none" as const, faces: 0, timerOver: false, yourTurn: false, words: [] as string[] };
    fc.assert(
      fc.property(role, choices, (r, c) => {
        const bar = shownBar({ ...content, role: r }, c);
        for (const part of GATED_TOP_BAR_PARTS) assert.equal(bar[part], !claimedHidden("topBar", part, r, c, false), part);
        for (const mode of BUILD_MODES) assert.equal(claimShown("builderMode", mode.value, "dm", c), !claimedHidden("builderMode", mode.value, "dm", c, false), mode.value);
      }),
      RUNS,
    );
  });

  test("no choices hide nothing anywhere", () => {
    for (const r of ["dm", "player"] as const) assert.equal(hiddenModules(r, NO_CHOICES).size, 0);
  });
});
