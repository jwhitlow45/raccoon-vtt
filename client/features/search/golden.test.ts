import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DM, entry, P1 } from "#shared/testutil.ts";
import type { SearchEntry } from "./entry.ts";
import { searchResults } from "./index.ts";
import { recordPick } from "./recent.ts";
import { DM_VIEW, indexOf, PAT_VIEW, rowsOf, seededRoom, viewOf } from "./search.testutil.ts";

/**
 * The golden queries (designs/qol/search.md 5.10 point 3 and section 7):
 * each query of the case table, by role, with what it must list first, on
 * the seeded room. The catalogs here are search.testutil.ts's stand-ins
 * until lanes S2a and S2b write the real ones. Those lanes point this file
 * at the real catalogs and keep every expectation, so the best bets on
 * their entries are held here too.
 */

const row = (e: SearchEntry) => `${e.kind}:${e.title}${e.mark ? ` (${e.mark})` : ""}${e.where ? ` · ${e.where}` : ""}${e.value ? `: ${e.value}` : ""}`;
const first = (rows: SearchEntry[], n: number) => rows.slice(0, n).map(row);

describe("golden queries, the DM", () => {
  const dm = indexOf(DM_VIEW());

  test("init: Initiative first, Start a fight second, then the Combat settings", () => {
    const rows = rowsOf(dm, "init");
    assert.deepEqual(first(rows, 2), ["panel:Initiative", "action:Start a fight · Initiative"]);
    assert.ok(rows.slice(2).every((e) => e.where.includes("Combat") || e.title === "Combat"), rows.map(row).join("\n"));
    assert.ok(rows.length >= 3);
  });

  test("long rest and rest: Long Rest for the party first, then each character's Long Rest", () => {
    for (const text of ["long rest", "rest", "lr"]) {
      assert.deepEqual(first(rowsOf(dm, text), 3), ["action:Long Rest for the party · Characters", "field:Long Rest · Bree", "field:Long Rest · Kel"], text);
    }
  });

  test("goblin: Goblin 1, Goblin 2, Goblin Boss (Hidden), Goblin cave, Goblin war drums, then the SRD goblins", () => {
    assert.deepEqual(first(rowsOf(dm, "goblin"), 8), [
      "token:Goblin 1 · Monster on Battle mat",
      "token:Goblin 2 · Monster on Battle mat",
      "token:Goblin Boss (Hidden) · Monster on Battle mat",
      "scene:Goblin cave",
      "playlist:Goblin war drums · 1 track",
      "monster:Goblin Boss · CR 1 · Fey (Goblinoid)",
      "monster:Goblin Minion · CR 1/8 · Fey (Goblinoid)",
      "monster:Goblin Warrior · CR 1/4 · Fey (Goblinoid)",
    ]);
  });

  test("darkvision or dv: the Senses of characters with Darkvision, value shown", () => {
    for (const text of ["darkvision", "dv"]) assert.deepEqual(first(rowsOf(dm, text), 1), ["field:Senses · Bree: Darkvision 60 ft."], text);
  });

  test("music: Sound on Now playing first", () => {
    assert.deepEqual(first(rowsOf(dm, "music"), 1), ["section:Now playing · Sound"]);
  });

  test("the best bets on their entries", () => {
    assert.equal(row(rowsOf(dm, "pause")[0]!), "action:Black out players' screens · DM menu · Players' screens");
    assert.equal(row(rowsOf(dm, "blackout")[0]!), "action:Black out players' screens · DM menu · Players' screens");
    assert.equal(row(rowsOf(dm, "dark")[0]!), "setting:Light level · Scenes · Light and weather");
    assert.equal(row(rowsOf(dm, "fight")[0]!), "action:Start a fight · Initiative");
  });

  test("a hidden name's public one finds the token by its true name", () => {
    assert.deepEqual(first(rowsOf(dm, "hooded"), 1), ["token:Count Varo · NPC on Battle mat"]);
  });

  test("2d6+3: Roll 2d6+3 first", () => {
    assert.deepEqual(first(rowsOf(dm, "2d6+3"), 1), ["dice:Roll 2d6+3 · Dice"]);
    assert.deepEqual(first(rowsOf(dm, "d20"), 1), ["dice:Roll 1d20 · Dice"]);
  });

  test("a result picked ten times on this device, then a typed query: the same order as on a fresh device", () => {
    for (const text of ["goblin", "rest", "init", "senses", "music"]) {
      const fresh = rowsOf(dm, text);
      let recent: string[] = [];
      for (let i = 0; i < 10; i++) recent = recordPick(recent, fresh.at(-1)!.id);
      assert.deepEqual(rowsOf(dm, text, recent), fresh, text);
    }
  });
});

describe("golden queries, a player (Pat, who plays Bree)", () => {
  const pat = indexOf(PAT_VIEW());

  test("long rest: their own character's Long Rest first", () => {
    assert.deepEqual(first(rowsOf(pat, "long rest"), 1), ["field:Long Rest · Bree"]);
  });

  test("goblin: only the goblins their map draws", () => {
    assert.deepEqual(rowsOf(pat, "goblin").map(row), ["token:Goblin 1 · Monster on Battle mat", "token:Goblin 2 · Monster on Battle mat"]);
  });

  test("music: This device's sound settings, nothing of the library", () => {
    const rows = rowsOf(pat, "music");
    assert.equal(row(rows[0]!), "setting:Music volume · Menu · This device · Sounds");
    assert.ok(rows.every((e) => e.where.startsWith("Menu · This device")), rows.map(row).join("\n"));
  });

  test("a hidden token's name, a hidden name's true name, a DM page's title, a playlist's name, a DM setting: no match", () => {
    for (const text of ["count varo", "villain", "boss", "goblin war drums", "tavern song", "players see the party", "goblin cave", "belak"]) {
      assert.deepEqual(rowsOf(pat, text), [], text);
    }
    assert.deepEqual(first(rowsOf(pat, "hooded"), 1), ["token:Hooded figure · NPC on Battle mat"]);
  });

  test("darkvision: their character's Senses, value shown", () => {
    assert.deepEqual(first(rowsOf(pat, "darkvision"), 1), ["field:Senses · Bree: Darkvision 60 ft."]);
  });
});

describe("the empty field (search.md 5.2)", () => {
  test("a DM outside a fight: Start a fight, Show a handout…, Black out players' screens, Long Rest for the party, Sound", () => {
    const out = searchResults(indexOf(DM_VIEW()), "", []);
    assert.equal(out.t, "empty");
    assert.deepEqual(out.t === "empty" && out.suggested.map((e) => e.title), ["Start a fight", "Show a handout…", "Black out players' screens", "Long Rest for the party", "Sound"]);
  });

  test("in a fight Next turn comes first, and Start a fight is not offered", () => {
    const room = seededRoom();
    room.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "g1", value: 12 })] };
    const out = searchResults(indexOf(viewOf(room, DM)), "", []);
    assert.deepEqual(out.t === "empty" && out.suggested.map((e) => e.title), ["Next turn", "Show a handout…", "Black out players' screens", "Long Rest for the party", "Sound"]);
  });

  test("a player: their character's page, Dice, the X-card", () => {
    const out = searchResults(indexOf(viewOf(seededRoom(), P1)), "", []);
    assert.deepEqual(out.t === "empty" && out.suggested.map((e) => e.title), ["Bree", "Dice", "X-card…"]);
  });

  test("Recent first, newest first, and Suggested without what Recent shows", () => {
    const dm = indexOf(DM_VIEW());
    const out = searchResults(dm, "  ", ["panel:sound", "token:g1", "gone:1"]);
    assert.equal(out.t, "empty");
    if (out.t !== "empty") return;
    assert.deepEqual(out.recent.map((e) => e.title), ["Sound", "Goblin 1"]);
    assert.ok(!out.suggested.some((e) => e.id === "panel:sound"));
  });
});
