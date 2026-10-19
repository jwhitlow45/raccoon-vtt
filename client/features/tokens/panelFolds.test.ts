import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "../../state/scope.ts";
import { createPanelFolds, FOLD_KEYS, FOLDS_KEY, foldDefaults, overrideAfterSelect, PAGE_FOLD_KEYS, relationKey, resolveFolds, statBlockOpen, statBlockOpenedSlot, writeFold, type Folds } from "./panelFolds.ts";
import { openStatBlock } from "./statBlockOpen.ts";

/** A device's localStorage, or one that throws as a private window's or blocked site data's does. */
function storage(initial: string | null = null, throws = false) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(FOLDS_KEY, initial);
  let writes = 0;
  return {
    items,
    writes: () => writes,
    getItem(key: string) {
      if (throws) throw new Error("blocked");
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (throws) throw new Error("blocked");
      writes++;
      items.set(key, value);
    },
  };
}

const NARROW = { width: 899, height: 844 };
const WIDE = { width: 900, height: 800 };
const FOLDED: Folds = {
  statBlock: false,
  stats: false,
  settings: false,
  companion: false,
  owners: false,
  combat: true,
  notes: false,
  position: false,
  image: false,
  "other.statBlock": false,
  "other.combat": true,
  "other.notes": true,
  "page.combat": true,
  "page.companions": true,
  "page.notes": false,
  "page.image": false,
  "page.stats": false,
  "page.owners": false,
};

describe("the folds' defaults", () => {
  test("the stat block opens at 900 px wide and 600 tall, and folds below either", () => {
    assert.equal(foldDefaults({ width: 900, height: 600 }).statBlock, true);
    assert.equal(foldDefaults({ width: 899, height: 600 }).statBlock, false);
    assert.equal(foldDefaults({ width: 900, height: 599 }).statBlock, false);
    assert.equal(foldDefaults({ width: 932, height: 430 }).statBlock, false, "a large phone held sideways in the wide layout");
  });

  test("Combat starts open and every other section folded, everywhere, another creature's Notes open, and a character's page's Combat and Companions", () => {
    for (const layout of [NARROW, WIDE]) {
      const { statBlock, combat, "other.statBlock": otherBlock, "other.combat": otherCombat, "other.notes": otherNotes, "page.combat": pageCombat, "page.companions": pageCompanions, ...rest } = foldDefaults(layout);
      assert.equal(combat, true);
      assert.equal(pageCombat, true, "a character's page opens on Combat");
      assert.equal(pageCompanions, true, "and on its companions");
      assert.equal(otherCombat, true);
      assert.equal(otherNotes, true, "it shows only with the DM's note for everyone, the reason to open it");
      assert.equal(otherBlock, statBlock, "a block folds by the same layout rule for any creature");
      assert.ok(Object.values(rest).every((open) => !open));
    }
  });
});

describe("reading the folds", () => {
  test("a valid value, at 899 and 900", () => {
    const value = JSON.stringify({ statBlock: false, stats: true, settings: true, companion: false, owners: true });
    for (const layout of [NARROW, WIDE]) {
      assert.deepEqual(resolveFolds(storage(value), layout), { ...FOLDED, stats: true, settings: true, owners: true, "other.statBlock": layout === WIDE });
    }
  });

  test("a missing key, bad JSON, a non-boolean and storage that throws read as each section's default, at 899 and 900", () => {
    for (const s of [storage(), storage("{not json"), storage(JSON.stringify({ statBlock: "yes", stats: 1 })), storage(JSON.stringify([true])), storage(null, true)]) {
      assert.deepEqual(resolveFolds(s, NARROW), FOLDED);
      assert.deepEqual(resolveFolds(s, WIDE), { ...FOLDED, statBlock: true, "other.statBlock": true });
    }
    assert.deepEqual(resolveFolds(storage(JSON.stringify({ stats: true })), WIDE), { ...FOLDED, statBlock: true, "other.statBlock": true, stats: true }, "one stored value, the rest by default");
    assert.deepEqual(resolveFolds(null, WIDE), { ...FOLDED, statBlock: true, "other.statBlock": true });
  });
});

describe("the Room's folds", () => {
  test("are resolved once, so a crossing of 900 px either way refolds nothing, whatever storage held", () => {
    for (const make of [() => storage(), () => storage("{bad"), () => storage(null, true)]) {
      const narrow = createPanelFolds(make());
      assert.equal(narrow.get(NARROW).statBlock, false);
      assert.equal(narrow.get(WIDE).statBlock, false, "resolved at 899, read at 900");
      const wide = createPanelFolds(make());
      assert.equal(wide.get(WIDE).statBlock, true);
      assert.equal(wide.get(NARROW).statBlock, true, "resolved at 900, read at 899");
    }
  });

  test("a tap writes the Room's folds and storage, keeping the other sections' values", () => {
    const s = storage(JSON.stringify({ owners: true }));
    const folds = createPanelFolds(s);
    folds.get(WIDE);
    let heard = 0;
    folds.subscribe(() => heard++);
    folds.tap("settings", true, true);
    assert.deepEqual(folds.get(WIDE), { ...FOLDED, statBlock: true, settings: true, owners: true, "other.statBlock": true });
    assert.deepEqual(JSON.parse(s.items.get(FOLDS_KEY)!), { owners: true, settings: true });
    assert.equal(heard, 1);
    folds.tap("statBlock", false, true);
    assert.deepEqual(JSON.parse(s.items.get(FOLDS_KEY)!), { owners: true, settings: true, statBlock: false });
  });

  test("writeFold keeps what storage held and survives storage that throws", () => {
    const s = storage(JSON.stringify({ stats: true, junk: 3 }));
    writeFold(s, "owners", true);
    assert.deepEqual(JSON.parse(s.items.get(FOLDS_KEY)!), { stats: true, owners: true });
    assert.doesNotThrow(() => writeFold(storage(null, true), "owners", true));
  });

  test("a preview's folds read storage and never write it", () => {
    const s = storage(JSON.stringify({ stats: true }));
    const preview = createPanelFolds(s);
    assert.equal(preview.get(NARROW).stats, true);
    preview.tap("stats", false, false);
    assert.equal(preview.get(NARROW).stats, false);
    assert.equal(s.writes(), 0);
    assert.deepEqual(JSON.parse(s.items.get(FOLDS_KEY)!), { stats: true });
  });
});

describe("the request's override", () => {
  const ui = { select() {}, showActions() {}, openPanel() {} };

  test("a request sets it and writes neither the folds nor storage", () => {
    const scope = new RoomScope();
    const s = storage(JSON.stringify({ statBlock: false }));
    const folds = createPanelFolds(s);
    folds.get(WIDE);
    openStatBlock(scope, ui, "g1", { layout: WIDE });
    assert.deepEqual(scope.get(statBlockOpenedSlot).getState(), { tokenId: "g1" });
    assert.equal(folds.get(WIDE).statBlock, false);
    assert.equal(s.writes(), 0);
  });

  test("with the block folded, stored or by default, a request keeps it open across a crossing of 900 px either way", () => {
    for (const [from, to] of [
      [NARROW, WIDE],
      [WIDE, NARROW],
    ] as const) {
      for (const s of [storage(JSON.stringify({ statBlock: false })), storage()]) {
        const scope = new RoomScope();
        const folds = createPanelFolds(s);
        // A device with nothing stored resolves the default where it first reads. Folded by storage, it stays folded at both.
        const resolved = folds.get(from);
        openStatBlock(scope, ui, "g1", { layout: from });
        const override = scope.get(statBlockOpenedSlot).getState();
        assert.equal(statBlockOpen(folds.get(from), override, "g1"), true);
        // The panel remounts in the other tree and reads the same Room's folds and override.
        assert.equal(statBlockOpen(folds.get(to), override, "g1"), true);
        assert.equal(folds.get(to), resolved, "nothing resolved again");
      }
    }
  });

  test("another token, letting go, or a tap on the fold clears it, and only the tap writes", () => {
    const opened = { tokenId: "g1" };
    assert.deepEqual(overrideAfterSelect(opened, "g2"), { tokenId: null });
    assert.deepEqual(overrideAfterSelect(opened, null), { tokenId: null });
    assert.equal(overrideAfterSelect(opened, "g1"), opened, "the same token keeps it");
    // The tap: the section clears the override and taps the fold to what it now shows.
    const s = storage();
    const folds = createPanelFolds(s);
    folds.get(NARROW);
    assert.equal(statBlockOpen(folds.get(NARROW), opened, "g1"), true);
    folds.tap("statBlock", !statBlockOpen(folds.get(NARROW), opened, "g1"), true);
    assert.equal(statBlockOpen(folds.get(NARROW), { tokenId: null }, "g1"), false);
    assert.equal(s.writes(), 1);
    assert.equal(statBlockOpen(folds.get(NARROW), { tokenId: null }, "g2"), false, "another monster shows its block folded");
  });
});

describe("the folds by relation (docs/design-v1-token-panel-groups.md 5)", () => {
  test("a tap on another creature's Notes, Combat or block never folds the viewer's own, and the other way round", () => {
    const s = storage();
    const folds = createPanelFolds(s);
    folds.get(WIDE);
    for (const key of ["notes", "combat", "statBlock"] as const) {
      const own = relationKey(key, "own");
      const other = relationKey(key, "other");
      assert.equal(own, key);
      assert.equal(other, `other.${key}`);
      const before = folds.get(WIDE)[own];
      folds.tap(other, !folds.get(WIDE)[other], true);
      assert.equal(folds.get(WIDE)[own], before, `${key}: the viewer's own stays as it was`);
      const otherNow = folds.get(WIDE)[other];
      folds.tap(own, !folds.get(WIDE)[own], true);
      assert.equal(folds.get(WIDE)[other], otherNow, `${key}: and the others' stay as they were`);
    }
    assert.deepEqual(Object.keys(JSON.parse(s.items.get(FOLDS_KEY)!)).sort(), ["combat", "notes", "other.combat", "other.notes", "other.statBlock", "statBlock"]);
  });

  test("the stat block reads the fold of the viewer's relation, and a request opens either", () => {
    const folds = { ...FOLDED, statBlock: true, "other.statBlock": false };
    assert.equal(statBlockOpen(folds, { tokenId: null }, "g1", "own"), true);
    assert.equal(statBlockOpen(folds, { tokenId: null }, "g1", "other"), false);
    assert.equal(statBlockOpen(folds, { tokenId: "g1" }, "g1", "other"), true);
  });
});

describe("a character's page's folds (docs/design-v1-look-pass.md 3.1)", () => {
  test("its groups have keys of their own, Combat and Companions open, the rest folded, on every layout", () => {
    for (const layout of [NARROW, WIDE]) {
      const d = foldDefaults(layout);
      assert.deepEqual(
        Object.fromEntries(PAGE_FOLD_KEYS.map((k) => [k, d[k]])),
        { "page.combat": true, "page.companions": true, "page.notes": false, "page.image": false, "page.stats": false, "page.owners": false },
      );
    }
    for (const key of PAGE_FOLD_KEYS) assert.ok((FOLD_KEYS as readonly string[]).includes(key), `${key} is stored as the token panel's are`);
  });

  test("folding the page's Combat leaves the token panel's Combat, a monster's included, as it was", () => {
    const s = storage();
    const folds = createPanelFolds(s);
    folds.get(NARROW);
    folds.tap("page.combat", false, true);
    const now = folds.get(NARROW);
    assert.equal(now["page.combat"], false);
    assert.equal(now.combat, true, "the DM's own creatures' Combat, every monster's");
    assert.equal(now["other.combat"], true);
    assert.deepEqual(JSON.parse(s.items.get(FOLDS_KEY)!), { "page.combat": false }, "only the page's key is stored");
    assert.equal(resolveFolds(s, NARROW).combat, true, "and so after a reload");
  });

  test("the stat block is the one fold both read: the own relation's statBlock", () => {
    const folds = createPanelFolds(storage());
    folds.get(NARROW);
    // The page folds and opens its block through "statBlock", as the token panel does for its own creatures.
    folds.tap("statBlock", true, true);
    assert.equal(statBlockOpen(folds.get(NARROW), { tokenId: null }, "t1", "own"), true, "the token panel opens the character's block too");
    assert.equal(folds.get(NARROW)["other.statBlock"], false, "another creature's block keeps its own fold");
    assert.ok(!PAGE_FOLD_KEYS.some((k) => k.endsWith("statBlock")), "the page has no stat block fold of its own");
  });
});
