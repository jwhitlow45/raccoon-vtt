import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { token } from "#shared/testutil.ts";
import { RoomScope, RoomScopeProvider } from "../../state/scope.ts";
import { PreviewContext } from "../dm/previewContext.ts";
import {
  computerLayout,
  createDiceFolds,
  CREATURE_GROUPS,
  DICE_FOLD_KEYS,
  DICE_FOLDS_KEY,
  diceFoldsSlot,
  diceFoldStarts,
  foldKey,
  foldKind,
  FOLD_KINDS,
  resolveDiceFolds,
  severalKey,
  writeDiceFold,
  useDiceFolds,
  type DiceFoldKey,
  type DiceFolds,
} from "./diceFolds.ts";

/** A device's localStorage, or one that throws as a private window's or blocked site data's does. */
function storage(initial: string | null = null, throws = false) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(DICE_FOLDS_KEY, initial);
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

const PHONE = { width: 390, height: 844 };
const COMPUTER = { width: 1440, height: 900 };
const ticked = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/** The starts as the design's table lists them (6.2), for one kind at each layout. */
const CREATURE_STARTS = {
  computer: { saves: true, skills: false, traits: false, actions: true, bonusActions: true, reactions: true, legendaryActions: true, spells: true },
  phone: { saves: false, skills: false, traits: false, actions: true, bonusActions: true, reactions: true, legendaryActions: true, spells: true },
};

function startsAt(computer: boolean): DiceFolds {
  const out: Record<string, boolean> = { "group.saves": true, "group.skills": false, "group.sharedAttacks": true, recent: true };
  for (const kind of ["pc", "companion", "monster"]) {
    for (const [group, open] of Object.entries(computer ? CREATURE_STARTS.computer : CREATURE_STARTS.phone)) out[`${kind}.${group}`] = open;
  }
  return out as DiceFolds;
}

describe("the dice folds' keys (6.3)", () => {
  test("each kind's groups, several selected's, and one Recent rolls", () => {
    assert.deepEqual(FOLD_KINDS, ["pc", "companion", "monster"]);
    assert.deepEqual(CREATURE_GROUPS, ["saves", "skills", "traits", "actions", "bonusActions", "reactions", "legendaryActions", "spells"]);
    assert.equal(foldKey("companion", "legendaryActions"), "companion.legendaryActions");
    assert.equal(severalKey("sharedAttacks"), "group.sharedAttacks");
    assert.equal(DICE_FOLD_KEYS.length, 3 * 8 + 3 + 1);
    assert.equal(new Set(DICE_FOLD_KEYS).size, DICE_FOLD_KEYS.length, "no key twice");
    assert.deepEqual(DICE_FOLD_KEYS.slice(0, 8), CREATURE_GROUPS.map((g) => `pc.${g}`));
    assert.deepEqual(DICE_FOLD_KEYS.slice(-4), ["group.saves", "group.skills", "group.sharedAttacks", "recent"]);
    assert.equal(DICE_FOLDS_KEY, "rvtt.diceFolds");
  });

  test("the e2e harness stores every one of them open", () => {
    const harness = readFileSync(new URL("../../../e2e/harness.ts", import.meta.url), "utf8");
    const list = /const DICE_FOLD_KEYS = \[([^\]]*)\]/.exec(harness);
    assert.ok(list, "the harness lists the keys");
    const listed = [...list[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...listed].sort(), [...DICE_FOLD_KEYS].sort());
    assert.match(harness, new RegExp(`"${DICE_FOLDS_KEY.replace(".", "\\.")}"`), "under the folds' storage key");
  });
});

describe("a creature's fold kind (6.3)", () => {
  const view = {
    tokens: {
      thorn: token("thorn", { kind: "pc", actor: { ref: "c1" } }),
      wolf: token("wolf", { kind: "monster", companion: { of: "c1", turn: "own" } }),
      ogre: token("ogre", { kind: "monster" }),
      npc: token("npc", { kind: "npc", ownerIds: ["p1"] }),
      beast: token("beast", { kind: "monster", ownerIds: ["p1"] }),
      crate: token("crate", { kind: "object" }),
      loose: token("loose", { kind: "pc" }),
      kept: token("kept", { kind: "npc", actor: { ref: "c2" } }),
    },
  };

  test("a character a player picks is a pc, and a player character's token, with a character or without", () => {
    assert.equal(foldKind(view, { characterId: "c1" }), "pc");
    assert.equal(foldKind(view, { tokenId: "thorn" }), "pc");
    assert.equal(foldKind(view, { tokenId: "loose" }), "pc");
  });

  test("a companion's token is a companion, whatever its kind", () => {
    assert.equal(foldKind(view, { tokenId: "wolf" }), "companion");
  });

  test("monsters, NPCs, objects, an NPC or beast a player owns, the DM's NPC kept as a character, and a token gone, all fold with the monsters", () => {
    for (const id of ["ogre", "npc", "beast", "crate", "kept", "gone"]) assert.equal(foldKind(view, { tokenId: id }), "monster", id);
  });
});

describe("where the groups start (6.2)", () => {
  test("a computer is 900 px wide and 600 tall, and a phone held sideways is a phone", () => {
    assert.equal(computerLayout({ width: 900, height: 600 }), true);
    assert.equal(computerLayout({ width: 899, height: 600 }), false);
    assert.equal(computerLayout({ width: 900, height: 599 }), false);
    assert.equal(computerLayout({ width: 932, height: 430 }), false);
  });

  test("every kind starts alike, Saves and checks open on a computer only, Skills and Traits folded everywhere", () => {
    assert.deepEqual(diceFoldStarts(COMPUTER), startsAt(true));
    assert.deepEqual(diceFoldStarts(PHONE), startsAt(false));
    assert.deepEqual(diceFoldStarts({ width: 1024, height: 768 }), startsAt(true));
    assert.deepEqual(diceFoldStarts({ width: 440, height: 956 }), startsAt(false));
  });
});

describe("reading and writing the folds", () => {
  test("a stored boolean wins, and the rest follow the starts at the layout", () => {
    const value = JSON.stringify({ "monster.saves": true, "pc.actions": false, recent: false });
    for (const layout of [PHONE, COMPUTER]) {
      const computer = layout === COMPUTER;
      assert.deepEqual(resolveDiceFolds(storage(value), layout), { ...startsAt(computer), "monster.saves": true, "pc.actions": false, recent: false });
    }
  });

  test("a missing key, bad JSON, a non-boolean, an array and storage that throws read as the starts", () => {
    for (const s of [storage(), storage("{not json"), storage(JSON.stringify({ "pc.saves": "yes", recent: 0 })), storage(JSON.stringify([true])), storage("null"), storage(null, true), null]) {
      assert.deepEqual(resolveDiceFolds(s, PHONE), startsAt(false));
      assert.deepEqual(resolveDiceFolds(s, COMPUTER), startsAt(true));
    }
  });

  test("a write keeps the other stored folds, drops what is no fold, and survives storage that throws", () => {
    const s = storage(JSON.stringify({ "pc.skills": true, junk: 3, "pc.junk": false }));
    writeDiceFold(s, "monster.saves", false);
    assert.deepEqual(JSON.parse(s.items.get(DICE_FOLDS_KEY)!), { "pc.skills": true, "monster.saves": false });
    writeDiceFold(s, "pc.skills", false);
    assert.deepEqual(JSON.parse(s.items.get(DICE_FOLDS_KEY)!), { "pc.skills": false, "monster.saves": false });
    assert.doesNotThrow(() => writeDiceFold(storage(null, true), "recent", true));
    assert.doesNotThrow(() => writeDiceFold(null, "recent", true));
  });
});

describe("the Room's dice folds", () => {
  test("are resolved once, so a crossing of 900 px either way refolds nothing", () => {
    for (const make of [() => storage(), () => storage("{bad"), () => storage(null, true)]) {
      const phone = createDiceFolds(make());
      assert.equal(phone.get(PHONE)["pc.saves"], false);
      assert.equal(phone.get(COMPUTER)["pc.saves"], false, "resolved on a phone, read on a computer");
      const computer = createDiceFolds(make());
      assert.equal(computer.get(COMPUTER)["pc.saves"], true);
      assert.equal(computer.get(PHONE)["pc.saves"], true, "resolved on a computer, read on a phone");
    }
  });

  test("a tap is stored for its own kind only, and its listeners hear it at once", () => {
    const s = storage();
    const folds = createDiceFolds(s);
    folds.get(COMPUTER);
    let heard = 0;
    folds.subscribe(() => heard++);
    folds.tap("monster.saves", false, true);
    assert.equal(heard, 1);
    assert.equal(folds.get(COMPUTER)["monster.saves"], false);
    assert.equal(folds.get(COMPUTER)["pc.saves"], true, "a character's Saves and checks stay open");
    assert.equal(folds.get(COMPUTER)["companion.saves"], true);
    assert.deepEqual(JSON.parse(s.items.get(DICE_FOLDS_KEY)!), { "monster.saves": false });
    assert.equal(resolveDiceFolds(s, COMPUTER)["monster.saves"], false, "and so after a reload");
  });

  test("a tap in \"view as a player\" shows for the preview and is never stored", () => {
    const s = storage(JSON.stringify({ "pc.skills": true }));
    const preview = createDiceFolds(s);
    assert.equal(preview.get(PHONE)["pc.skills"], true);
    preview.tap("pc.skills", false, false);
    assert.equal(preview.get(PHONE)["pc.skills"], false);
    assert.equal(s.writes(), 0);
  });

  test("blocked storage keeps a tap for the page", () => {
    const folds = createDiceFolds(storage(null, true));
    folds.get(PHONE);
    folds.tap("pc.skills", true, true);
    assert.equal(folds.get(PHONE)["pc.skills"], true);
  });

  test("a tap before the panel reads its folds starts from the phone's starts", () => {
    const folds = createDiceFolds(storage());
    folds.tap("recent", false, true);
    assert.deepEqual(folds.get(COMPUTER), { ...startsAt(false), recent: false });
  });
});

describe("the app's openings (6.4)", () => {
  test("an opening shows the group for the page, never writes storage, and its listeners hear it after the render", async () => {
    const s = storage(JSON.stringify({ recent: false }));
    const folds = createDiceFolds(s);
    folds.get(PHONE);
    let heard = 0;
    folds.subscribe(() => heard++);
    assert.equal(folds.open("recent"), true, "it was folded");
    assert.equal(folds.get(PHONE).recent, true);
    assert.equal(heard, 0, "not during the render that opened it");
    await ticked();
    assert.equal(heard, 1);
    assert.equal(folds.open("recent"), false, "already open");
    await ticked();
    assert.equal(heard, 1, "nothing changed, nothing heard");
    assert.equal(s.writes(), 0);
    assert.deepEqual(JSON.parse(s.items.get(DICE_FOLDS_KEY)!), { recent: false });
    // The viewer folds it again, and a second tap on the sticky line opens it again.
    folds.tap("recent", false, true);
    assert.equal(folds.open("recent"), true);
    assert.equal(folds.get(PHONE).recent, true);
  });

  test("a new ask opens its group once, and the viewer may fold it after", () => {
    const s = storage();
    const folds = createDiceFolds(s);
    folds.get(PHONE);
    assert.equal(folds.openForNew("pc.saves", ["ask1"]), true);
    assert.equal(folds.get(PHONE)["pc.saves"], true);
    folds.tap("pc.saves", false, true);
    assert.equal(folds.openForNew("pc.saves", ["ask1"]), false, "seen");
    assert.equal(folds.get(PHONE)["pc.saves"], false, "it stays folded");
    assert.equal(folds.openForNew("pc.saves", ["ask1", "ask2"]), true, "a second ask is new");
    assert.equal(folds.get(PHONE)["pc.saves"], true);
    assert.equal(folds.openForNew("pc.saves", []), false);
    assert.equal(s.writes(), 1, "only the tap was stored");
  });

  test("a quiet id is only marked seen: it opens nothing, then or when it comes again as an ask", () => {
    const folds = createDiceFolds(storage());
    folds.get(PHONE);
    folds.openForNew("pc.spells", ["open:1"]);
    folds.tap("pc.spells", false, false);
    assert.equal(folds.openForNew("pc.spells", ["open:1"], ["k2"]), false, "a block's retry");
    assert.equal(folds.get(PHONE)["pc.spells"], false);
    assert.equal(folds.openForNew("pc.spells", ["k2"]), false, "the retry's ask in the view");
    assert.equal(folds.openForNew("pc.spells", ["k2", "k3"], ["k3"]), false, "marked seen before the ids are read");
    assert.equal(folds.get(PHONE)["pc.spells"], false);
  });

  test("an id is seen per group, so one ask may open Saves and checks and Skills, and another kind's", () => {
    const folds = createDiceFolds(storage());
    folds.get(PHONE);
    assert.equal(folds.openForNew("pc.saves", ["ask1"]), true);
    assert.equal(folds.openForNew("pc.skills", ["ask1"]), true);
    assert.equal(folds.openForNew("monster.saves", ["ask1"]), true, "an NPC lent to the same player, asked in the same request");
    const now = folds.get(PHONE);
    assert.deepEqual(
      DICE_FOLD_KEYS.filter((k) => now[k] !== startsAt(false)[k]),
      ["pc.saves", "pc.skills", "monster.saves"] satisfies DiceFoldKey[],
    );
  });

  test("the ids seen live in the Room scope, so the options remounting never opens a folded group again", () => {
    const scope = new RoomScope();
    const first = scope.get(diceFoldsSlot);
    first.get(PHONE);
    first.openForNew("pc.spells", ["cast:1"]);
    first.tap("pc.spells", false, false);
    // A tab pick remounts the body, which reads the same Room's slot.
    const again = scope.get(diceFoldsSlot);
    assert.equal(again, first);
    assert.equal(again.openForNew("pc.spells", ["cast:1"]), false);
    assert.equal(again.get(PHONE)["pc.spells"], false);
    assert.notEqual(new RoomScope().get(diceFoldsSlot), first, "another Room, such as a preview, keeps its own");
  });
});

describe("useDiceFolds", () => {
  type Seen = { value?: ReturnType<typeof useDiceFolds>; saves?: boolean };

  /** Renders a component that reads the folds, with this device's storage, as the Room page or its "view as a player" preview. */
  function renderFolds(device: ReturnType<typeof storage>, preview: boolean, opens: readonly string[] = []): Seen {
    const seen: Seen = {};
    function Probe() {
      const value = useDiceFolds();
      value.store.openForNew("pc.saves", opens);
      seen.value = value;
      seen.saves = value.fold("pc.saves").open;
      return null;
    }
    const global = globalThis as { localStorage?: unknown };
    global.localStorage = device;
    try {
      const tree = createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(Probe) });
      renderToStaticMarkup(preview ? createElement(PreviewContext.Provider, { value: { memberId: "p1", name: "Pat" } }, tree) : tree);
    } finally {
      delete global.localStorage;
    }
    return seen;
  }

  test("a render with no window reads the phone's starts, and a group opened in that render shows open", () => {
    const seen = renderFolds(storage(), false, ["ask1"]);
    assert.equal(seen.value?.folds["pc.saves"], false, "the snapshot read before the opening");
    assert.equal(seen.saves, true, "fold reads the folds as they are now");
    assert.equal(seen.value?.folds["pc.skills"], false);
  });

  test("a tap is stored, and in \"view as a player\" it shows and is never stored", () => {
    const own = storage();
    const page = renderFolds(own, false);
    page.value!.fold("pc.skills").onToggle();
    assert.equal(page.value!.fold("pc.skills").open, true);
    assert.deepEqual(JSON.parse(own.items.get(DICE_FOLDS_KEY)!), { "pc.skills": true });
    page.value!.fold("pc.skills").onToggle();
    assert.deepEqual(JSON.parse(own.items.get(DICE_FOLDS_KEY)!), { "pc.skills": false }, "each tap flips what shows now");
    const previewed = storage(JSON.stringify({ "pc.skills": true }));
    const preview = renderFolds(previewed, true);
    assert.equal(preview.value!.fold("pc.skills").open, true, "the preview reads what is stored");
    preview.value!.fold("pc.skills").onToggle();
    assert.equal(preview.value!.fold("pc.skills").open, false);
    assert.equal(previewed.writes(), 0);
  });
});
