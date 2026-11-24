import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { SEALED_IDS_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { FALL_RIDERS_MOST, type RoomState, type TrapDue } from "#shared/model.ts";
import { actor, member, room, scene, token, trap } from "#shared/testutil.ts";
import { ReidPlan, renamedState } from "./reid.ts";
import { remapState } from "./remap.ts";

/*
 * One room stored before SEALED_IDS_SNAPSHOT_VERSION, upgraded in place
 * (reid.ts renamedState) or exported and imported (remap.ts remapState).
 * Each of its creatures takes the same new id both ways, and the new ids
 * sort in the reverse of the order the DM made the creatures, so only a
 * list sorted again by them reads alike. A list cut at its cap by the old
 * ids goes both ways, and the DM's cards name the same creatures in the
 * same order, with the same counts (client/features/traps/desk.ts whoLines
 * and fallRead read no more of them).
 */

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;
const AT = "2026-10-01T13:00:00.000Z";
const NAMES = Array.from({ length: FALL_RIDERS_MOST + 1 }, (_, i) => `Imp ${String.fromCharCode(65 + i)}`);

/** The room before the update: an imp for each name, made in that order and shown to no player, a trap with a cut and a whole occurrence, and a full and a short fall card. */
function oldRoom(): { state: RoomState; imps: string[] } {
  const dm = member(uuidv7(T0), "dm");
  const p1 = member(uuidv7(T0 + 1));
  const mat = uuidv7(T0 + 2);
  const imps = NAMES.map((_, i) => uuidv7(T0 + (10 + i) * MINUTE));
  const s = room({ members: { [dm.id]: dm, [p1.id]: p1 }, scenes: { [mat]: scene(mat, { name: "Battle mat" }) }, playedScenes: { [mat]: { sceneId: mat, rev: 0 } } });
  s.meta.playerSceneId = mat;
  s.tokens = Object.fromEntries(imps.map((id, i) => [id, token(id, { sceneId: mat, kind: "monster", name: NAMES[i]!, visibility: "dm", x: i, y: 2, actor: { inline: actor({ hp: { cur: 9, max: 9, temp: 0 } }) } })]));
  const trapId = uuidv7(T0 + 100 * MINUTE);
  const base = trap(trapId);
  const [a, b, c, d, e, f] = imps as [string, string, string, string, string, string];
  const due: TrapDue[] = [
    { id: "5:0", at: AT, how: "enter", by: [a, b], more: 3, hits: [a, b, c], hitsMore: 2 },
    { id: "6:0", at: AT, how: "enter", by: [d, e], hits: [d, e, f], hidden: true },
  ];
  s.traps = { [trapId]: { ...base, name: "Spike Hall", sceneId: mat, rig: { ...base.rig!, due } } };
  s.falls = {
    "8:0": { id: "8:0", rev: 0, tokenId: imps[FALL_RIDERS_MOST]!, riders: imps.slice(0, FALL_RIDERS_MOST), sceneId: mat, from: mat, ft: 10, made: 8 },
    "9:0": { id: "9:0", rev: 0, tokenId: f, riders: [c, d, e], sceneId: mat, from: mat, ft: 10, made: 9 },
  };
  return { state: s, imps };
}

/** New ids counting down, so each sorts before every one made earlier. */
function countingDown(): () => string {
  let n = 99_999_999;
  return () => `${String(n--).padStart(8, "0")}-0000-8000-8000-000000000000`;
}

/** What the DM's cards name: each occurrence's creatures that set it off and that it hits, each count of the rest, and each fall card's creatures. */
function cards(state: RoomState): string[] {
  const name = (id: string) => state.tokens[id]?.name ?? "?";
  const out: string[] = [];
  for (const due of Object.values(state.traps).find((t) => t.name === "Spike Hall")!.rig!.due!) {
    out.push(`by ${[...due.by.map(name), `${due.more ?? 0} more`].join(", ")}; hits ${[...due.hits.map(name), `${due.hitsMore ?? 0} more`].join(", ")}`);
  }
  for (const card of Object.values(state.falls ?? {}).sort((x, y) => x.made - y.made)) out.push(`fell ${[card.tokenId, ...(card.riders ?? [])].map(name).join(", ")}`);
  return out;
}

describe("an import of an export from before sealed ids (remap.ts, idLists.ts)", () => {
  test("gives the DM the same cards as the same room upgraded in place: cut lists go and the rest follow the new ids", () => {
    const { state, imps } = oldRoom();
    const imported = remapState(state, { assets: new Map(), newId: countingDown(), schemaVersion: SEALED_IDS_SNAPSHOT_VERSION - 1 });
    const importedId = new Map(imps.map((id, i) => [id, Object.values(imported.tokens).find((t) => t.name === NAMES[i])!.id]));
    let other = 0;
    const renames = new Map([...new ReidPlan(state).renames(() => "").keys()].map((old) => [old, importedId.get(old) ?? `${String(other++).padStart(8, "0")}-1111-8000-8000-000000000000`] as const));
    assert.ok(imps.every((id) => renames.has(id)), "the first load renames every imp, which no player holds");
    const upgraded = renamedState(state, renames);
    assert.deepEqual(cards(imported), cards(upgraded));
    assert.deepEqual(cards(imported), [
      "by 5 more; hits 5 more",
      "by Imp E, Imp D, 0 more; hits Imp F, Imp E, Imp D, 0 more",
      `fell Imp ${String.fromCharCode(65 + FALL_RIDERS_MOST)}`,
      "fell Imp F, Imp E, Imp D, Imp C",
    ]);
  });

  test("a file at today's format keeps its lists as they came, under the new ids", () => {
    const { state, imps } = oldRoom();
    const imported = remapState(state, { assets: new Map(), newId: countingDown(), schemaVersion: SEALED_IDS_SNAPSHOT_VERSION });
    const id = (old: string) => Object.values(imported.tokens).find((t) => t.name === NAMES[imps.indexOf(old)])!.id;
    const [cut, whole] = Object.values(imported.traps)[0]!.rig!.due!;
    assert.deepEqual([cut!.hits, cut!.hitsMore, whole!.hits], [imps.slice(0, 3).map(id), 2, imps.slice(3, 6).map(id)]);
    assert.equal(imported.falls!["8:0"]!.riders!.length, FALL_RIDERS_MOST);
  });
});
