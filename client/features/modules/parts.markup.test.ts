import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, describe, test } from "node:test";

/*
 * The parts markup test (docs/design/design-v1-features.md 14, checks 1 to
 * 4, D-261127-307, 390, 399, 424). Each drawn surface of surfaces.ts is
 * drawn to markup in the states that show its controls, as each role that
 * has it, once with every part shown and once with each of the role's
 * parts hidden alone:
 * 1. a hidden part leaves no `data-part` of its own and no anchor it claims,
 * 2. every other control and anchor draws as it does with every part shown,
 * 3. every control drawn with every part shown is in controls.golden.json
 *    under its surface, with its owner: the nearest `data-part`, else core,
 * 4. each surface's drawings hold a `data-part` of every part it covers,
 * and each home a drawing stands holds its Hidden on this device line, a
 * Show for each part hidden there (design section 6). The fixtures and the
 * markup reader are parts.markup.testutil.ts.
 *
 * A render to markup runs no effect and has no browser, so a few shims
 * stand in before React loads. A store's server snapshot is its client one,
 * since several device stores have none. A portal draws in place, so a
 * dialog's controls read with the surface that opened it. The page has a
 * window, a document and storage that hold nothing.
 */

const require = createRequire(import.meta.url);
const react = require("react") as { useSyncExternalStore(subscribe: unknown, get: unknown, server?: unknown): unknown; useEffect(run: () => unknown, deps?: unknown): void; useLayoutEffect(run: () => unknown, deps?: unknown): void };
const sync = react.useSyncExternalStore;
react.useSyncExternalStore = (subscribe, get) => sync(subscribe, get, get);
// A press that waits on an effect to hand out its setter runs that effect as it is declared (parts.markup.testutil.ts effectsNow).
const effects = { on: false };
(globalThis as Record<symbol, unknown>)[Symbol.for("parts.markup.effects")] = effects;
const effect = react.useEffect;
react.useEffect = (run, deps) => (effects.on ? void run() : effect(run, deps));
// A controller's layout effects, run the same way for the probes that ask (gates read off a surface's element tree), apart from the presses so no fixture's drawing changes.
const layoutEffects = { on: false };
const layoutEffect = react.useLayoutEffect;
react.useLayoutEffect = (run, deps) => (layoutEffects.on ? void run() : layoutEffect(run, deps));
(require("react-dom") as { createPortal(children: unknown): unknown }).createPortal = (children) => children;

const noop = () => {};
const media = { matches: false, addEventListener: noop, removeEventListener: noop };
const items = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) },
  // A computer's window, where setup groups start open (lib/folds.ts), so a drawing holds the most controls.
  window: { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop, matchMedia: () => media },
  document: { body: {}, activeElement: null, visibilityState: "visible", addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
  matchMedia: () => media,
  // Classes a control's handlers test against, never met in a render to markup.
  HTMLElement: class {},
  Element: class {},
  // The weather's frame task asks for a message port, which would hold the test's process open (weather/store.ts browserAfterFrame).
  MessageChannel: undefined,
});

const { FIXTURES, disposeDrawn, draw, ownPart, readDrawing, soundOn, tableRoom } = await import("./parts.markup.testutil.ts");
type Drawing = import("./parts.markup.testutil.ts").Drawing;
type Fixture = import("./parts.markup.testutil.ts").Fixture;
type InnerOwner = import("./parts.markup.testutil.ts").InnerOwner;
const { SURFACES } = await import("./surfaces.ts");
const { moduleById, modulesFor } = await import("./registry.ts");
type ModuleId = import("./registry.ts").ModuleId;
type Role = import("./registry.ts").Role;
type Home = import("./registry.ts").Home;
const { hiddenAt, hiddenModules, showLabel } = await import("./gate.ts");
const { featureChoices, resetAllFeatures, setModuleShown } = await import("./store.ts");

const GOLDEN = new URL("./controls.golden.json", import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const REGENERATE = "UPDATE_GOLDEN=1 node --test client/features/modules/parts.markup.test.ts";

/** DSLOTS's parts, whose surfaces FT-D draws once its classes land (design section 15, D-261127-397). */
const FTD_PARTS: ReadonlySet<ModuleId> = new Set(["spellSlots", "hitDice"]);

/**
 * Options a part takes from inside a shared control whose gate cannot mark
 * them: a Segmented draws its own radios, so the part's option has no
 * element of its own to carry `data-part`. Each is its part's while drawn.
 */
const INNER_OWNERS: readonly InnerOwner[] = [
  // Map's third choice, which makes a floor through Generate a dungeon (scenes/floorWords.ts FLOOR_MAP_OPTIONS).
  { surface: "Scene settings", key: 'input[radio] "Dungeon"', owner: "dungeon", why: "Floors' Map option Dungeon is the generator's" },
  // The Kind of scene's third choice, the builder's scene (scenes/NewScene.tsx).
  { surface: "New scene", key: 'input[radio] "Builder"', owner: "builder", why: "New scene's Builder kind is Map builder's" },
  // This device's Tab row lists the panels the registry offers (features/panels.ts panelsFor), whose guard leaves out a hidden part's panel.
  ...(
    [
      ["areas", "Areas"],
      ["sound", "Sound"],
      ["time", "Time"],
      ["journal", "Journal"],
      ["encounters", "Encounters"],
      ["outliner", "Outliner"],
    ] as const
  ).map(([owner, tab]) => ({ surface: "This device", key: `input[checkbox] "${tab}"`, owner, why: "a part's panel in the Tab row, which panelsFor leaves out while the part hides" })),
];

/**
 * Core controls that stand on a fixture only because a part's count admits
 * them, which the part's hiding takes with it by design (design section 3,
 * D-261127-394). Each is that part's on its surface. None today: Bree's
 * turn card holds her class resources and her spell slots, so hiding either
 * alone leaves the card. A Uses list that one part alone holds is drawn by
 * the class resources alone test below.
 */
const ADMITTED: readonly InnerOwner[] = [];

/**
 * A part whose gates on a surface another lane places, so checks 1, 2 and 4
 * and its home's line wait for that lane. A pair whose checks all pass
 * fails until it is taken off, so the list shrinks to empty as the gates
 * land (the scans' pending lists do the same, D-261127-458).
 */
const PENDING: readonly { surface: string; part: ModuleId; lane: "FT-B"; why: string }[] = [];

/**
 * Ways back that are a part's own switch at its home, not a Show on the
 * home's line: This device's Roll animation switch is Dice animation's
 * (design section 6, the thisDevice home, D-261127-301). The home check
 * leaves them out, and the switch's own test reads it.
 */
const SWITCH_WAYS_BACK: readonly { home: Home; part: ModuleId }[] = [{ home: "thisDevice", part: "diceAnimation" }];

const pendingHere = (surface: string, part: ModuleId) => PENDING.some((p) => p.surface === surface && p.part === part);

/** Whether a hidden part's claims hold in a fixture: a part whose every claim names a condition hides only where one holds (D-261127-311). */
function hidesHere(part: ModuleId, fixture: Fixture): boolean {
  const claims = moduleById(part).claims;
  if (claims.length === 0 || claims.some((c) => c.when === undefined)) return true;
  return claims.some((c) => c.when !== undefined && fixture.conditions?.[c.when] === true);
}

/** The anchors a part claims that hide in a fixture. */
function claimedAnchors(part: ModuleId, fixture: Fixture): string[] {
  return moduleById(part)
    .claims.filter((c) => c.kind === "anchor" && (c.when === undefined || fixture.conditions?.[c.when] === true))
    .map((c) => c.id);
}

type Hidden = { part: ModuleId; hidden: ReadonlySet<ModuleId>; drawing: Drawing; error?: undefined } | { part: ModuleId; error: string };
type Drawn = { fixture: Fixture; role: Role; everything: Drawing | null; error?: string; hidden: Hidden[] };

function drawn(fixture: Fixture, role: Role, hidden: ReadonlySet<ModuleId>): Drawing {
  const own = ownPart(fixture);
  // Room never offers a hidden part's own panel or tool.
  const html = own !== null && hidden.has(own) ? "" : draw(fixture, role);
  return readDrawing(html, fixture.surface, [...INNER_OWNERS, ...ADMITTED]);
}

const message = (err: unknown) => (err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 6).join("\n")}` : String(err));

/** A fixture drawn as a role with every part shown, then with each of the role's parts hidden alone. */
function drawAll(fixture: Fixture, role: Role): Drawn {
  resetAllFeatures();
  let everything: Drawing | null = null;
  let error: string | undefined;
  try {
    everything = drawn(fixture, role, new Set());
  } catch (err) {
    error = message(err);
  }
  const hidden: Hidden[] = [];
  if (everything) {
    for (const m of modulesFor(role)) {
      resetAllFeatures();
      setModuleShown(m.id, role, false);
      const set = hiddenModules(role, featureChoices());
      try {
        hidden.push({ part: m.id, hidden: set, drawing: drawn(fixture, role, set) });
      } catch (err) {
        hidden.push({ part: m.id, error: message(err) });
      }
    }
  }
  resetAllFeatures();
  return { fixture, role, everything, ...(error ? { error } : {}), hidden };
}

await soundOn();
const DRAWN: Drawn[] = FIXTURES.flatMap((fixture) => fixture.roles.map((role) => drawAll(fixture, role)));
disposeDrawn();
after(() => resetAllFeatures());

const where = (d: Drawn) => `${d.fixture.surface} / ${d.fixture.name} / ${d.role}`;
const base = (key: string) => key.replace(/ #\d+$/, "");

/** What a part's hiding may change in a drawing: its own controls and anchors, those inside its surfaces and those of what needs it, and the ways back. */
function rest(drawing: Drawing, hidden: ReadonlySet<ModuleId>, fixture: Fixture): string[] {
  const gone = (within: readonly string[]) => within.some((part) => hidden.has(part as ModuleId) && hidesHere(part as ModuleId, fixture));
  const claimed = new Set([...hidden].flatMap((p) => claimedAnchors(p, fixture)));
  return [
    ...drawing.controls.filter((c) => !c.wayBack && !gone(c.within)).map((c) => `control ${c.owner} ${base(c.key)}`),
    ...drawing.anchors.filter((a) => !a.wayBack && !gone(a.within) && !claimed.has(a.id)).map((a) => `anchor ${a.owner} ${a.id}`),
  ].sort();
}

/** Check 1's findings for one hidden drawing: the parts and anchors still drawn that should be gone. */
function leftOver(d: Drawn, h: Extract<Hidden, { drawing: Drawing }>): string[] {
  const out: string[] = [];
  for (const part of h.hidden) {
    if (!hidesHere(part, d.fixture)) continue;
    if (h.drawing.parts.has(part)) out.push(`data-part="${part}"`);
    const anchors = new Set(h.drawing.anchors.filter((a) => !a.wayBack).map((a) => a.id));
    for (const id of claimedAnchors(part, d.fixture)) if (anchors.has(id)) out.push(`anchor ${id}`);
    // A control the part takes from inside another's (an inner owner, or one its count admits) has no data-part to find it by.
    for (const c of h.drawing.controls) if (!c.wayBack && c.taken && c.owner === part) out.push(`control ${c.key}`);
  }
  return out;
}

/** Check 2's findings: what changed besides the hidden parts' own, as lines gone and lines added. */
function changed(d: Drawn, h: Extract<Hidden, { drawing: Drawing }>): string[] {
  const before = rest(d.everything!, h.hidden, d.fixture);
  const now = rest(h.drawing, h.hidden, d.fixture);
  const count = (list: string[]) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const a = count(before);
  const b = count(now);
  const out: string[] = [];
  for (const [k, n] of a) if ((b.get(k) ?? 0) < n) out.push(`- ${k}`);
  for (const [k, n] of b) if ((a.get(k) ?? 0) < n) out.push(`+ ${k}`);
  return out;
}

/** The home check's findings: each home the drawing stands lists a Show for each part hidden there for its creature, and nothing more. */
function lineFindings(d: Drawn, h: Extract<Hidden, { drawing: Drawing }>, choices: ReturnType<typeof featureChoices>): string[] {
  const out: string[] = [];
  for (const { home, holder } of d.fixture.homes ?? []) {
    const want = hiddenAt(home, d.role, choices, holder)
      .filter((m) => !SWITCH_WAYS_BACK.some((w) => w.home === home && w.part === m.id))
      .map((m) => showLabel(m.id, d.role, choices));
    const got = h.drawing.lines.get(home) ?? [];
    if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`${home}: wants ${JSON.stringify(want)}, draws ${JSON.stringify(got)}`);
  }
  return out;
}

/** The choices that hide one part for a role, as the drawing had them. */
function choicesHiding(part: ModuleId, role: Role) {
  resetAllFeatures();
  setModuleShown(part, role, false);
  const choices = featureChoices();
  resetAllFeatures();
  return choices;
}

const drawnSurfaces = [...new Set(SURFACES.flatMap((e) => (e.kind === "drawn" ? [e.surface] : [])))];
const coversOf = (surface: string) => new Set(SURFACES.flatMap((e) => (e.kind === "drawn" && e.surface === surface ? e.covers : [])));

/** Whether a pending pair's checks would pass now, which takes it off the list. */
const pendingPasses = new Map<string, boolean>(PENDING.map((p) => [`${p.surface} ${p.part}`, true]));
const failPending = (surface: string, part: ModuleId) => pendingPasses.set(`${surface} ${part}`, false);

describe("each drawn surface's parts (design section 14, checks 1 to 4)", () => {
  test("every drawn surface of surfaces.ts has a fixture, and every fixture draws one", () => {
    const fixtured = new Set(FIXTURES.map((f) => f.surface));
    assert.deepEqual(drawnSurfaces.filter((s) => !fixtured.has(s)), [], "a drawn surface with no fixture: add one in parts.markup.testutil.ts");
    assert.deepEqual([...fixtured].filter((s) => !drawnSurfaces.includes(s)), [], "a fixture names no drawn surface");
  });

  for (const d of DRAWN) {
    describe(where(d), () => {
      test("draws", () => {
        assert.equal(d.error, undefined, d.error);
        for (const h of d.hidden) assert.equal(h.error, undefined, `with ${h.part} hidden: ${h.error}`);
      });
      if (!d.everything) return;

      test("check 1: a hidden part leaves no data-part of its own and no anchor it claims", () => {
        const found: string[] = [];
        for (const h of d.hidden) {
          if (h.error !== undefined) continue;
          const left = leftOver(d, h);
          if (pendingHere(d.fixture.surface, h.part)) {
            if (left.length > 0) failPending(d.fixture.surface, h.part);
            continue;
          }
          for (const l of left) found.push(`${h.part} hidden: ${l}`);
        }
        assert.deepEqual(found, []);
      });

      test("check 2: every other control and anchor draws as with every part shown", () => {
        const found: string[] = [];
        for (const h of d.hidden) {
          if (h.error !== undefined) continue;
          const diff = changed(d, h);
          if (pendingHere(d.fixture.surface, h.part)) {
            if (diff.length > 0) failPending(d.fixture.surface, h.part);
            continue;
          }
          for (const l of diff) found.push(`${h.part} hidden: ${l}`);
        }
        assert.deepEqual(found, []);
      });

      test("each home it stands holds a Show for each part hidden there", () => {
        const found: string[] = [];
        for (const h of d.hidden) {
          if (h.error !== undefined) continue;
          const lines = lineFindings(d, h, choicesHiding(h.part, d.role));
          if (pendingHere(d.fixture.surface, h.part)) {
            if (lines.length > 0) failPending(d.fixture.surface, h.part);
            continue;
          }
          for (const l of lines) found.push(`${h.part} hidden: ${l}`);
        }
        const everything = d.everything!;
        assert.equal(everything.lines.size, 0, "a Hidden on this device line with every part shown");
        assert.deepEqual(found, []);
      });
    });
  }

  test("check 3: every control is in controls.golden.json under its surface, with its owner", () => {
    const now: Record<string, Record<string, string>> = {};
    for (const d of DRAWN) if (d.everything) now[where(d)] = Object.fromEntries(d.everything.controls.map((c) => [c.key, c.owner]));
    if (UPDATE) {
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Record<string, string>>;
    assert.deepEqual(now, golden, `the drawn controls or their owners changed: look over the change, then regenerate with ${REGENERATE}`);
  });

  test("check 4: each surface's drawings hold a data-part of every part it covers", () => {
    // A part with no surface of its own here, as Isometric view in the chip menus, covers it by the Show its home there draws while it hides (D-261127-632).
    const showsAt = (surface: string, part: ModuleId) =>
      DRAWN.some((d) => d.fixture.surface === surface && d.hidden.some((h) => h.part === part && h.error === undefined && [...h.drawing.lines.values()].some((line) => line.includes(showLabel(part, d.role, choicesHiding(part, d.role))))));
    const missing: string[] = [];
    for (const surface of drawnSurfaces) {
      const parts = new Set(DRAWN.filter((d) => d.fixture.surface === surface && d.everything).flatMap((d) => [...d.everything!.parts]));
      for (const part of coversOf(surface)) {
        if (FTD_PARTS.has(part) || parts.has(part) || showsAt(surface, part)) continue;
        if (pendingHere(surface, part)) failPending(surface, part);
        else missing.push(`${surface} covers ${part}, and no drawing of it holds data-part="${part}"`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test("a pending part whose checks all pass is taken off the pending list", () => {
    // Its gate has landed once its own `data-part` draws on the surface: before that an unmarked control reads as core and passes checks 1 and 2 unseen.
    const marked = (surface: string, part: ModuleId) => DRAWN.some((d) => d.fixture.surface === surface && d.everything?.parts.has(part));
    const landed = PENDING.filter((p) => pendingPasses.get(`${p.surface} ${p.part}`) === true && marked(p.surface, p.part)).map((p) => `${p.surface} ${p.part} (${p.lane}): its gates landed, take it off the pending list`);
    assert.deepEqual(landed, []);
  });
});

/*
 * The checks themselves, on drawings made to break them: each finds what it
 * is for, so a surface that passes passes for its gates and not for a
 * check that reads nothing.
 */
describe("the checks find what they are for", async () => {
  const { createElement } = await import("react");
  const { HiddenHere, Module, useModule } = await import("./Gate.tsx");
  const fixture = (name: string, body: () => ReturnType<typeof createElement>, more: Partial<Fixture> = {}): Fixture => ({ surface: "the checks", name, roles: ["dm"], draw: body, ...more });
  const withHidden = (f: Fixture, part: ModuleId) => {
    const d = drawAll(f, "dm");
    const h = d.hidden.find((x) => x.part === part);
    assert.ok(h && h.error === undefined, `${f.name} draws with ${part} hidden`);
    return { d, h: h as Extract<Hidden, { drawing: Drawing }> };
  };
  function PlayIfShown() {
    return useModule("sound") ? createElement("button", null, "Play") : null;
  }

  test("a gated, marked part with its way back passes every check", () => {
    const f = fixture("gated", () => createElement("div", null, createElement(Module, { id: "tableDisplay", children: createElement("button", null, "Show my view") }), createElement("button", null, "Save"), createElement(HiddenHere, { home: "dmPanel" })), { homes: [{ home: "dmPanel" }] });
    const { d, h } = withHidden(f, "tableDisplay");
    assert.deepEqual([leftOver(d, h), changed(d, h), lineFindings(d, h, choicesHiding("tableDisplay", "dm"))], [[], [], []]);
  });

  test("check 1 finds a part marked and never gated, and an anchor it claims left drawn", () => {
    const { d, h } = withHidden(fixture("marked only", () => createElement("div", { "data-part": "sound" }, createElement("button", null, "Play"), createElement("div", { "data-search": "scenes.sound" }))), "sound");
    assert.deepEqual(leftOver(d, h), ['data-part="sound"', "anchor scenes.sound"]);
  });

  test("check 2 finds a control that leaves with a part it is not marked for", () => {
    const { d, h } = withHidden(fixture("gated only", () => createElement("div", null, createElement(PlayIfShown), createElement("button", null, "Save"))), "sound");
    assert.deepEqual(changed(d, h), ['- control core button "Play"']);
  });

  test("the home check finds a home with no Hidden on this device line", () => {
    const { d, h } = withHidden(fixture("no line", () => createElement(Module, { id: "tableDisplay", children: createElement("button", null, "Show my view") }), { homes: [{ home: "dmPanel" }] }), "tableDisplay");
    assert.deepEqual(lineFindings(d, h, choicesHiding("tableDisplay", "dm")), ['dmPanel: wants ["Show Table display"], draws []']);
  });

  test("a part whose every claim waits on a condition stays where the condition does not hold", () => {
    const floors = (oneFloor: boolean) => fixture(`floors, one floor ${oneFloor}`, () => createElement(Module, { id: "floors", when: oneFloor, children: createElement("button", null, "Add a floor above") }), { conditions: { oneFloor } });
    const floored = withHidden(floors(false), "floors");
    assert.deepEqual([leftOver(floored.d, floored.h), changed(floored.d, floored.h)], [[], []]);
    const one = withHidden(floors(true), "floors");
    assert.deepEqual([leftOver(one.d, one.h), changed(one.d, one.h)], [[], []]);
    assert.equal(one.h.drawing.controls.length, 0, "hidden on a one-floor scene");
  });
});

/*
 * What the checks above cannot see, since it holds no control: a uses list
 * of class resources alone draws no box at all while they hide, rather than
 * an empty one taking a gap in the section around it, and her token says it
 * has no uses, so no Uses button opens empty (design section 3,
 * D-261127-394).
 */
describe("a uses list of class resources alone", () => {
  test("draws nothing while Class resources hides", async () => {
    const { createElement } = await import("react");
    const { CreatureUses, useUsesPresence } = await import("../combat/CombatUses.tsx");
    const alone = () => {
      const state = tableRoom();
      // No classes either, or her spell slots would make the list.
      const bree = { ...state.characters.bree! };
      delete bree.classes;
      state.characters.bree = { ...bree, actor: { ...bree.actor, uses: {} } };
      return state;
    };
    const list: Fixture = { surface: "Action bar Uses", name: "Bree's class resources alone", roles: ["dm"], room: alone, draw: () => createElement(CreatureUses, { target: { characterId: "bree" }, name: "Bree" }) };
    // What the token bar's Uses button and the token panel's Uses section ask of her token.
    function Presence() {
      return createElement("output", null, useUsesPresence({ tokenId: "tbree" }));
    }
    const presence: Fixture = { ...list, name: "Bree's token's uses presence", draw: () => createElement(Presence) };
    try {
      resetAllFeatures();
      assert.match(draw(list, "dm"), /data-combat-uses="list"/, "shown, her resources make the list");
      assert.equal(draw(presence, "dm"), "<output>yes</output>");
      setModuleShown("classResources", "dm", false);
      assert.doesNotMatch(draw(list, "dm"), /data-combat-uses/);
      assert.equal(draw(presence, "dm"), "<output>no</output>", "no Uses button opens on them");
    } finally {
      resetAllFeatures();
      disposeDrawn();
    }
  });
});

/*
 * Two gates the drawings cannot see, read off the element tree a surface
 * returns: the builder's mode list, whose menu a drawing leaves closed, and
 * the class resources a character's page hands its Rest, whose words a
 * drawing shows only once a rest is chosen.
 */
describe("gates read off a surface's element tree", () => {
  /** Every element in a tree that `test` picks, through children and every other prop, as slots and menus take elements in theirs. */
  function findAll(node: unknown, test: (type: unknown, props: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = [], seen = new Set<unknown>()): Record<string, unknown>[] {
    if (node === null || typeof node !== "object" || seen.has(node)) return out;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, test, out, seen);
      return out;
    }
    const element = node as { $$typeof?: unknown; type?: unknown; props?: Record<string, unknown> };
    if (element.$$typeof !== undefined && element.props) {
      if (test(element.type, element.props)) out.push(element.props);
      for (const value of Object.values(element.props)) findAll(value, test, out, seen);
    } else if (!element.$$typeof) {
      for (const value of Object.values(node)) findAll(value, test, out, seen);
    }
    return out;
  }

  /** The elements themselves that `test` picks, through children alone, for a component to run in place. */
  function findElements(node: unknown, test: (type: unknown) => boolean): { type: unknown; props: Record<string, unknown> }[] {
    if (Array.isArray(node)) return node.flatMap((child) => findElements(child, test));
    const element = node as { $$typeof?: unknown; type?: unknown; props?: Record<string, unknown> } | null;
    if (!element || typeof element !== "object" || element.$$typeof === undefined || !element.props) return [];
    return [...(test(element.type) ? [{ type: element.type, props: element.props }] : []), ...findElements(element.props.children, test)];
  }

  /** The tree a component returns, drawn in a fixture's room as a role. */
  async function treeOf(component: () => unknown, more: Partial<Fixture> = {}): Promise<unknown> {
    const { createElement } = await import("react");
    let tree: unknown = null;
    function Probe() {
      tree = component();
      return null;
    }
    draw({ surface: "the element tree", name: "probe", roles: ["dm"], draw: () => createElement(Probe), ...more }, "dm");
    return tree;
  }

  test("the builder's mode list leaves out Add a wing while Dungeon generator hides (D-261127-395)", async () => {
    const { default: BuilderOptions } = await import("../builder/Options.tsx");
    const modes = async () => {
      const tree = await treeOf(() => (BuilderOptions as () => unknown)(), { local: { tool: "build" } });
      const chips = findAll(tree, (_type, p) => p.label === "Builder mode" && Array.isArray(p.options));
      return [...new Set(chips.flatMap((p) => (p.options as { key?: string; value?: string }[]).map((o) => o.key ?? o.value)))];
    };
    try {
      resetAllFeatures();
      assert.ok((await modes()).includes("wing"));
      setModuleShown("dungeon", "dm", false);
      const hidden = await modes();
      assert.ok(hidden.length > 0 && !hidden.includes("wing"), hidden.join(" "));
    } finally {
      resetAllFeatures();
      disposeDrawn();
    }
  });

  test("a character's page hands its Rest no class resources while they hide, so the rest's words leave them out", async () => {
    const { CharacterPage } = await import("../tokens/CharacterCard.tsx");
    const { RestSection } = await import("../tokens/RestSection.tsx");
    const noop = () => {};
    const restResources = async () => {
      const tree = await treeOf(() => (CharacterPage as (p: object) => unknown)({ character: tableRoom().characters.bree!, close: noop, onAddCompanion: noop, onBlocks: noop, onDelete: () => null }));
      const rests = findAll(tree, (type) => type === RestSection);
      assert.equal(rests.length, 1, "the page draws its Rest");
      return rests[0]!.resources as readonly unknown[] | undefined;
    };
    try {
      resetAllFeatures();
      assert.equal((await restResources())?.length, 2, "shown, Rage and Lay on Hands");
      setModuleShown("classResources", "dm", false);
      assert.equal(await restResources(), undefined);
    } finally {
      resetAllFeatures();
      disposeDrawn();
    }
  });

  test("her token's panel does the same", async () => {
    const { default: TokenPanel } = await import("../../panels/TokenPanel.tsx");
    const { RestSection } = await import("../tokens/RestSection.tsx");
    const restResources = async () => {
      // The panel draws the token's details as a component of their own, which runs here inside the probe's one render.
      const tree = await treeOf(
        () => {
          const outer = (TokenPanel as (p: object) => unknown)({ close: () => {}, selectedTokenId: "tbree" }) as { props: { children?: unknown } };
          const details = findElements(outer, (type) => typeof type === "function" && type.name === "TokenDetails")[0]!;
          return (details.type as (p: object) => unknown)(details.props);
        },
        { local: { selectedId: "tbree", selectedIds: ["tbree"] } },
      );
      const rests = findAll(tree, (type) => type === RestSection);
      assert.equal(rests.length, 1, "the panel draws its Rest");
      return rests[0]!.resources as readonly unknown[] | undefined;
    };
    try {
      resetAllFeatures();
      assert.equal((await restResources())?.length, 2);
      setModuleShown("classResources", "dm", false);
      assert.equal(await restResources(), undefined);
    } finally {
      resetAllFeatures();
      disposeDrawn();
    }
  });

  test("the weather draws Off and mounts no layer while Weather hides, and draws again once it shows", async () => {
    const { createElement } = await import("react");
    const { WeatherController } = await import("../weather/WeatherController.tsx");
    const { weatherSlot } = await import("../weather/store.ts");
    const { useScoped } = await import("../../state/scope.ts");
    const scene = { ...tableRoom().scenes.s1!, weather: { kind: "rain", heavy: true, wind: "strong" } };
    const weather = async () => {
      let shown: { mounted: boolean; effective: string } | null = null;
      function Probe() {
        const room = useScoped(weatherSlot);
        layoutEffects.on = true;
        try {
          (WeatherController as (p: object) => unknown)({ scene, role: "dm" });
        } finally {
          layoutEffects.on = false;
        }
        const { mounted, effective } = room.state.getState();
        shown = { mounted, effective };
        return null;
      }
      draw({ surface: "the element tree", name: "the weather's controller", roles: ["dm"], draw: () => createElement(Probe) }, "dm");
      return shown;
    };
    try {
      resetAllFeatures();
      assert.deepEqual(await weather(), { mounted: true, effective: "moving" });
      setModuleShown("weather", "dm", false);
      assert.deepEqual(await weather(), { mounted: false, effective: "off" }, "this device's Moving draws Off");
    } finally {
      resetAllFeatures();
      disposeDrawn();
    }
  });

  test("the board's view takes Top-down while Isometric view hides, and the pick stays stored", async () => {
    const { useRoomViewChoice } = await import("../view/ViewMenu.tsx");
    const { pickView } = await import("../view/store.ts");
    const choice = async () => {
      const state = (await treeOf(() => {
        const { key, stored, wanted } = useRoomViewChoice();
        return { key, pick: stored.pick, wanted };
      })) as { key: string; pick: string | null; wanted: string };
      return state;
    };
    const { key } = await choice();
    try {
      resetAllFeatures();
      pickView(key, "isometric");
      assert.deepEqual(await choice(), { key, pick: "isometric", wanted: "isometric" });
      setModuleShown("isometric", "dm", false);
      assert.deepEqual(await choice(), { key, pick: "topDown", wanted: "topDown" }, "drawn Top-down");
      resetAllFeatures();
      assert.equal((await choice()).pick, "isometric", "shown again, the pick it had");
    } finally {
      pickView(key, null);
      resetAllFeatures();
      disposeDrawn();
    }
  });

  test("the party's Long Rest card leaves class resources out of its words while they hide", async () => {
    const { PartyLongRest } = await import("../tokens/CharactersPanel.tsx");
    /** Every string a tree holds, through element children alone. */
    const text = (node: unknown): string => {
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(text).join("");
      const props = (node as { props?: { children?: unknown } } | null)?.props;
      return props ? text(props.children) : "";
    };
    const card = async () => {
      let asked = false;
      const tree = await treeOf(() => {
        const drawn = (PartyLongRest as (p: object) => unknown)({ characters: [tableRoom().characters.bree!] });
        // The card opens from its own button, pressed once inside the first render.
        if (!asked) {
          asked = true;
          const open = findAll(drawn, (_type, p) => p.children === "Long Rest for the party")[0]!;
          (open.onClick as () => void)();
        }
        return drawn;
      });
      return text(tree);
    };
    try {
      resetAllFeatures();
      assert.match(await card(), /all HP back, lose Temporary HP and one Exhaustion level\. It also restores every class resource\./, "shown, Bree's spent Rage comes back");
      setModuleShown("classResources", "dm", false);
      const hidden = await card();
      assert.match(hidden, /one Exhaustion level\./, "the card opens");
      assert.doesNotMatch(hidden, /class resource/);
    } finally {
      resetAllFeatures();
      disposeDrawn();
    }
  });

  test("This device's Roll animation switch is Dice animation's way back, off while it hides for each role", () => {
    const fixture = FIXTURES.find((f) => f.surface === "This device")!;
    const roll = (role: Role) => /<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*data-search="menu\.this-device\.rolls\.animation"/.exec(draw(fixture, role))?.[1];
    try {
      for (const role of ["dm", "player"] as const) {
        resetAllFeatures();
        assert.equal(roll(role), "true", role);
        setModuleShown("diceAnimation", role, false);
        assert.equal(roll(role), "false", `${role}: hidden, the switch is off`);
        resetAllFeatures();
        setModuleShown("diceAnimation", role === "dm" ? "player" : "dm", false);
        assert.equal(roll(role), "true", `${role}: the other role's choice is not this one's`);
      }
    } finally {
      resetAllFeatures();
      disposeDrawn();
    }
  });
});
