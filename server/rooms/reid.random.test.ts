import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isUuidv7 } from "#shared/ids.ts";
import { SEALED_IDS_SNAPSHOT_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectArchivedLog, projectState } from "#shared/project.ts";
import { character, drawing, member, rng, room, scene, template, token } from "#shared/testutil.ts";
import { loadRoom } from "./persistence.ts";
import { ReidPlan, renamedState, renamedText, v7IdsIn, type ArchivedLine } from "./reid.ts";
import { parseRoomState } from "./stateSchema.ts";
import { storedActor, StoredRoomDb, type StoredRow } from "./undoScopeTesting.ts";

/**
 * Random rooms through the first load's new ids (reid.ts): things on
 * scenes players stand on or not, shown to all or the DM alone, owned or
 * not, records of showings, and archived lines of every stream, some
 * without their access rows. For every player and the table display, the
 * copy and the log page are byte-equal before and after, no renamed id is
 * left anywhere, an id is renamed exactly when no player reads it and no
 * record or kind keeps it, and the room still parses. Through the load
 * itself, a room whose replay fails at its tail renames and stores nothing.
 */

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const at = "2026-10-01T13:00:00.000Z";
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");

/** A version 7 id made at `t`, its random bits from `r`, so a seed gives the same room every run. */
function v7(r: () => number, t: number): string {
  const h = t.toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8)}-7${hex(r, 3)}-${pick(r, ["8", "9", "a", "b"])}${hex(r, 3)}-${hex(r, 12)}`;
}

type Built = { state: RoomState; lines: ArchivedLine[]; things: string[] };

function randomRoom(seed: number): Built {
  const r = rng(seed);
  let t = T0 + 10 * 60_000;
  const made = () => v7(r, (t += int(r, 1, 600_000)));
  const dm = member(v7(r, T0), "dm");
  const p1 = member(v7(r, T0 + 60_000));
  const p2 = member(v7(r, T0 + 120_000));
  const players = [p1.id, p2.id];
  const mat = v7(r, T0 + 3);
  const others = Array.from({ length: int(r, 1, 3) }, made);
  const scenes = [mat, ...others];
  const s = room({
    members: { [dm.id]: dm, [p1.id]: p1, [p2.id]: p2 },
    scenes: Object.fromEntries(scenes.map((id, i) => [id, scene(id, { order: i, fogEnabled: r() < 0.5 })])),
    numbering: { rev: 0, groups: 1 },
  });
  const played = scenes.filter((id) => id === mat || r() < 0.4);
  s.playedScenes = Object.fromEntries(played.map((id) => [id, { sceneId: id, rev: 0 }]));
  s.meta.playerSceneId = pick(r, played);
  const things: string[] = [];
  const add = (id: string) => (things.push(id), id);
  for (let i = int(r, 2, 10); i > 0; i--) {
    const id = add(made());
    const kind = pick(r, ["monster", "monster", "npc", "object", "pc"] as const);
    s.tokens[id] = token(id, {
      sceneId: pick(r, scenes),
      kind,
      name: kind === "pc" ? "Hero" : pick(r, ["Goblin", "Wolf"]),
      visibility: pick(r, ["all", "dm", "dm"] as const),
      ownerIds: pick(r, [[], [], [p1.id], [p2.id]]),
      x: int(r, 0, 20),
      y: int(r, 0, 20),
      ...(r() < 0.2 ? { met: 1 } : {}),
    });
  }
  for (let i = int(r, 0, 3); i > 0; i--) {
    const id = add(made());
    s.stamps[id] = { id, rev: 0, sceneId: pick(r, scenes), art: { key: "barrel" }, x: int(r, 1, 20), y: int(r, 1, 20), w: 1, h: 1, rotation: 0, z: 0, visibility: pick(r, ["all", "dm"] as const) };
    if (r() < 0.4) {
      const stamp = s.stamps[id]!;
      // Remembered as players saw it then, though the DM may have changed it since.
      s.memory![`${stamp.sceneId}:0,0`] = { sceneId: stamp.sceneId, cx: 0, cy: 0, rev: 0, stamps: { [id]: { ...stamp, visibility: "all" } } } as never;
    }
  }
  for (let i = int(r, 0, 3); i > 0; i--) {
    const id = add(made());
    s.drawings[id] = drawing(id, { sceneId: pick(r, scenes), ownerId: pick(r, [dm.id, p1.id]), visibility: pick(r, ["all", "dm"] as const) });
  }
  for (let i = int(r, 0, 2); i > 0; i--) {
    const id = add(made());
    s.templates[id] = template(id, { sceneId: pick(r, scenes), ownerId: pick(r, [dm.id, p2.id]), visibility: pick(r, ["all", "dm"] as const) });
  }
  for (let i = int(r, 0, 2); i > 0; i--) {
    const id = add(made());
    s.characters[id] = character(id, { name: `Hero ${i}`, ownerIds: pick(r, [[], [p1.id], [p2.id]]), resources: [{ id: add(made()), name: "Rage", max: 2, used: 0, reset: "long" }] });
  }
  if (r() < 0.5) {
    const page = made();
    s.saveOutcomes = { [page]: { memberId: dm.id, plan: made(), revision: 1, state: "applied", firstAppliedAt: at, seq: 1 } };
  }
  const named = () => (things.length > 0 && r() < 0.8 ? pick(r, things) : made());
  const lines: ArchivedLine[] = [];
  for (let i = 0; i < int(r, 3, 14); i++) {
    const seq = i + 1;
    const complete = r() < 0.7;
    const kind = int(r, 0, 4);
    const who = pick(r, players);
    let entry: LogEntry;
    if (kind === 0) entry = { id: `${seq}:0`, at, kind: "whisper", from: who, to: [dm.id], text: `What of ${named()}?` };
    else if (kind === 1) entry = { id: `${seq}:0`, at, kind: "event", data: { type: "member", memberId: named(), action: "join" } };
    else if (kind === 2) entry = { id: `${seq}:1`, at, kind: "event", to: [who], data: { type: "member", memberId: named(), action: "join" } };
    else if (kind === 3) entry = { id: `${seq}:900000`, at, kind: "event", data: { type: "teleport", tokenId: named(), past: "wall" } };
    else entry = { id: `${seq}:0`, at, kind: "event", data: { type: "dice", tag: made(), part: 0, by: who, to: pick(r, ["all", "dm"] as const), rolls: [] } };
    lines.push({ entry, complete });
  }
  return { state: s, lines, things };
}

const viewers = (s: RoomState): Viewer[] => [...Object.values(s.members).flatMap((m) => (m.kind === "player" ? [{ memberId: m.id, role: "player" as const }] : [])), { memberId: "display:000000000000", role: "player" }];
const copies = (s: RoomState) => viewers(s).map((v) => JSON.stringify(projectState(s, v, { sceneId: null })));
const pages = (s: RoomState, lines: readonly LogEntry[]) => viewers(s).map((v) => JSON.stringify(projectArchivedLog(s, lines, v, { sceneId: null })));

/** Why an id keeps its own, read apart from the plan: a player reads it, a record shows it, or its kind keeps it. */
function keptReasons(b: Built): Set<string> {
  const s = b.state;
  const out = new Set<string>();
  for (const text of [...copies(s), ...pages(s, b.lines.map((l) => l.entry)), ...pages(s, s.log)]) v7IdsIn(text, out);
  v7IdsIn(JSON.stringify([s.playedScenes, s.openFloors ?? {}, s.memory, s.memoryBy, s.trapSeen, s.handouts]), out);
  for (const tok of Object.values(s.tokens)) if (tok.met !== undefined) out.add(tok.id);
  for (const id of Object.keys(s.members)) out.add(id);
  for (const [page, rec] of Object.entries(s.saveOutcomes ?? {})) out.add(page).add(rec.plan);
  for (const l of b.lines) if (l.entry.data?.type === "dice" && l.entry.data.tag) out.add(l.entry.data.tag);
  out.add(s.scenes[Object.keys(s.scenes)[0]!]!.id);
  return out;
}

const SEEDS = 300;

describe("random rooms through the first load's new ids", () => {
  test(`${SEEDS} rooms: byte-equal copies and log pages for every player, no renamed id left, renamed exactly where nothing keeps it, and the room parses`, () => {
    let renamedAll = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const b = randomRoom(seed);
      const label = `seed ${seed}`;
      const first = parseRoomState(b.state);
      assert.ok(first.ok, `${label}: the room parses before: ${first.ok ? "" : first.message}`);
      const plan = new ReidPlan(b.state);
      plan.addLines(b.lines);
      let n = 0;
      const renames = plan.renames(() => `00000000-0000-8000-8000-${(++n).toString(16).padStart(12, "0")}`);
      renamedAll += renames.size;
      const after = renamedState(b.state, renames);
      const rewritten = b.lines.map((l) => JSON.parse(renamedText(JSON.stringify(l.entry), renames)) as LogEntry);
      assert.deepEqual(copies(after), copies(b.state), `${label}: every copy`);
      assert.deepEqual(pages(after, rewritten), pages(b.state, b.lines.map((l) => l.entry)), `${label}: every log page`);
      const text = JSON.stringify([after, rewritten]);
      for (const id of renames.keys()) assert.ok(!text.includes(id), `${label}: ${id} is gone`);
      const kept = keptReasons(b);
      const every = v7IdsIn(JSON.stringify([b.state, b.lines.map((l) => l.entry)]));
      for (const id of every) assert.equal(renames.has(id), !kept.has(id), `${label}: ${id} renamed exactly when nothing keeps it`);
      const parsed = parseRoomState(after);
      assert.ok(parsed.ok, `${label}: ${parsed.ok ? "" : parsed.message}`);
      assert.ok([...v7IdsIn(text)].every((id) => kept.has(id)), `${label}: the only version 7 ids left are kept ones`);
    }
    assert.ok(renamedAll > SEEDS, `the rooms renamed ${renamedAll} ids in all`);
  });

  test("rooms loaded through the actor: a whole replay renames and stores at today's version, and a failed tail renames and stores nothing", async (t) => {
    for (let seed = 1; seed <= 40; seed++) {
      const b = randomRoom(1_000 + seed);
      const dm = Object.values(b.state.members).find((m) => m.kind === "dm")!;
      const failed = seed % 3 === 0;
      const rows: StoredRow[] = [{ seq: 2, at, actorMemberId: dm.id, actorRole: "dm", op: { t: "log.chat", text: "back" }, opVersion: 65, pub: 2 }];
      if (failed) rows.push({ seq: 3, at, actorMemberId: dm.id, actorRole: "dm", op: { t: "token.update", tokenId: "no-such-token", patch: { x: 1 } }, opVersion: 65, pub: 3 });
      const db = new StoredRoomDb(b.state, { version: SEALED_IDS_SNAPSHOT_VERSION - 1, seq: 1, rows });
      const before = (await loadRoom(db.pool(), "UNDOSCOPE"))!;
      const h = await storedActor(t, db, { idGate: false });
      const state = h.actor.committed.state;
      assert.equal(h.actor.replayFailed, failed);
      assert.deepEqual(copies(state), copies(before.state), `seed ${seed}: every copy`);
      const unkept = b.things.filter((id) => !keptReasons({ ...b, state: before.state, lines: [] }).has(id));
      if (failed) {
        assert.deepEqual(state, before.state, `seed ${seed}: nothing renamed`);
        assert.deepEqual([db.snapshotWrites, db.snapshot.version], [0, SEALED_IDS_SNAPSHOT_VERSION - 1], `seed ${seed}: nothing stored`);
      } else {
        for (const id of unkept) assert.ok(!JSON.stringify(state).includes(id), `seed ${seed}: ${id} renamed`);
        assert.deepEqual([db.snapshotWrites, db.snapshot.version], [1, SNAPSHOT_VERSION], `seed ${seed}: stored once at today's version`);
        assert.ok([...v7IdsIn(JSON.stringify(state))].every((id) => isUuidv7(id)));
      }
      await h.actor.shutdown({ code: 1012, snapshot: false });
    }
  });
});
