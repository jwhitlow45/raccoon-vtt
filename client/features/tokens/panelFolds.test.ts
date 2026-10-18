import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "../../state/scope.ts";
import { createPanelFolds, FOLDS_KEY, foldDefaults, overrideAfterSelect, relationKey, resolveFolds, statBlockOpen, statBlockOpenedSlot, writeFold, type Folds } from "./panelFolds.ts";
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
const FOLDED: Folds = { statBlock: false, stats: false, settings: false, companion: false, owners: false, combat: true, notes: false, position: false, image: false, "other.statBlock": false, "other.combat": true, "other.notes": true };

describe("the folds' defaults", () => {
  test("the stat block opens at 900 px wide and 600 tall, and folds below either", () => {
    assert.equal(foldDefaults({ width: 900, height: 600 }).statBlock, true);
    assert.equal(foldDefaults({ width: 899, height: 600 }).statBlock, false);
    assert.equal(foldDefaults({ width: 900, height: 599 }).statBlock, false);
    assert.equal(foldDefaults({ width: 932, height: 430 }).statBlock, false, "a large phone held sideways in the wide layout");
  });

  test("Combat starts open and every other section folded, everywhere, and another creature's Notes open", () => {
    for (const layout of [NARROW, WIDE]) {
      const { statBlock, combat, "other.statBlock": otherBlock, "other.combat": otherCombat, "other.notes": otherNotes, ...rest } = foldDefaults(layout);
      assert.equal(combat, true);
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
      assert.deepEqual(resolveFolds(storage(value), layout), { statBlock: false, stats: true, settings: true, companion: false, owners: true, combat: true, notes: false, position: false, image: false, "other.statBlock": layout === WIDE, "other.combat": true, "other.notes": true });
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
    assert.deepEqual(folds.get(WIDE), { statBlock: true, stats: false, settings: true, companion: false, owners: true, combat: true, notes: false, position: false, image: false, "other.statBlock": true, "other.combat": true, "other.notes": true });
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
