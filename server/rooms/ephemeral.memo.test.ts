import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, wallChunk } from "#shared/keys.ts";
import type { FreeWall, GridShape, RoomState, SceneVision, Token, Viewer } from "#shared/model.ts";
import { clientMessageSchema, type EphEvent, type GroupFrame } from "#shared/protocol.ts";
import { setFootprintMemoOffForTests } from "#shared/rules/footprint.ts";
import { DM, actor, member, reveal, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { routeEphemeral } from "./ephemeral.ts";

/*
 * A routing pass keeps each creature's hex sub-cells while it runs
 * (footprint.ts withFootprintMemo). These twins route the same frames with
 * the memo and without it, and every receiver must get the same bytes:
 * group frames of creatures of every size, some hidden, some squeezed,
 * moved across sight walls on scenes lit by a light, and lone frames,
 * while the room changes between passes.
 */

const PLAYERS = ["p1", "p2", "p3"];
const SIZES: Token["size"][] = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"];

type Kind = { name: string; vision: SceneVision | undefined; fog: boolean };
const KINDS: Kind[] = [
  { name: "per-player dark sight", vision: { on: true, light: "dark", perPlayer: true }, fog: true },
  { name: "party dark sight", vision: { on: true, light: "dark" }, fog: true },
  { name: "fog alone", vision: undefined, fog: true },
];

/** Free sight walls through the creatures' ground, each in the chunk its middle lies in. */
function walls(state: RoomState): void {
  const lines: FreeWall[] = [
    { id: "w00000000001", a: [6.4375, 2], b: [6.4375, 9], f: { kind: "wall" } },
    { id: "w00000000002", a: [10, 5.53125], b: [17, 5.53125], f: { kind: "wall" } },
    { id: "w00000000003", a: [14.21875, 8], b: [19.21875, 14], f: { kind: "wall" } },
  ];
  for (const wall of lines) {
    const { cx, cy } = wallChunk(wall);
    const key = chunkKey("s1", cx, cy);
    const chunk = (state.buildChunks[key] ??= { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {}, walls: [] });
    chunk.walls = [...(chunk.walls ?? []), wall];
  }
}

function build(shape: GridShape | undefined, kind: Kind): { state: RoomState; ids: string[] } {
  const state = room();
  for (const p of PLAYERS) state.members[p] = member(p);
  state.members.dm2 = member("dm2", "dm");
  state.scenes.s1 = scene("s1", { bounds: { w: 30, h: 20 }, ...(shape ? { gridShape: shape } : {}), fogEnabled: kind.fog, ...(kind.vision ? { vision: kind.vision } : {}) });
  if (kind.vision?.perPlayer) state.holders = { s1: { sceneId: "s1", rev: 0, entries: PLAYERS.map((memberId) => ({ memberId, on: true })) } };
  reveal(state, "s1", { x: 0, y: 0, w: 16, h: 20 });
  reveal(state, "s1", { x: 16, y: 0, w: 14, h: 7 });
  walls(state);
  state.lights.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 20, y: 10, bright: 15, dim: 15, on: true, walls: true };
  const dark = { inline: actor({ senses: "darkvision 30 ft" }) };
  PLAYERS.forEach((p, i) => (state.tokens[`pc${i}`] = token(`pc${i}`, { kind: "pc", ownerIds: [p], x: 3 + i * 9, y: 16 - i * 5, actor: dark })));
  const ids = Array.from({ length: 40 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`);
  ids.forEach((id, i) => {
    const size = SIZES[i % SIZES.length]!;
    state.tokens[id] = token(id, {
      size,
      ...(size === "custom" ? { w: 1 + (i % 3), h: 3 } : {}),
      ...(i % 5 === 3 && (size === "large" || size === "huge" || size === "gargantuan" || size === "custom") ? { squeeze: true } : {}),
      ...(i % 4 === 1 ? { visibility: "dm" as const } : {}),
      x: 2 + ((i * 7) % 25) + (i % 2) * 0.5,
      y: 1 + ((i * 3) % 17),
    });
  });
  return { state, ids };
}

function receiver(who: Viewer, bytes: string[]): Connection {
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => void bytes.push(text), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "ROOM0000", memberId: who.memberId, role: who.role }, "203.0.113.1", {});
  conn.held = new Map();
  conn.sceneId = "s1";
  return conn;
}

/** Every receiver's bytes from one run of the frames: a group drag of all 40 with rosters, then lone drags across the walls. */
function route(shape: GridShape | undefined, kind: Kind, memo: boolean): Record<string, string[]> {
  setFootprintMemoOffForTests(!memo);
  try {
    const { state, ids } = build(shape, kind);
    const bytes: Record<string, string[]> = {};
    const all = [DM, { memberId: "dm2", role: "dm" } as Viewer, ...PLAYERS.map((memberId): Viewer => ({ memberId, role: "player" }))].map((who) => receiver(who, (bytes[who.memberId] = [])));
    const dm = all[0]!;
    const at = (id: string) => ({ x: state.tokens[id]!.x, y: state.tokens[id]!.y });
    const roster = (dx: number) => ({ with: ids.slice(1).map((id) => ({ tokenId: id, x: at(id).x + dx, y: at(id).y })), from: { x: at(ids[0]!).x + dx, y: at(ids[0]!).y } });
    const group = (e: unknown, t: number) => {
      const frame = (clientMessageSchema.parse(JSON.parse(JSON.stringify({ t: "eph", sceneId: "s1", e }))) as { e: GroupFrame }).e;
      const version = dm.gestures.arrive(frame, t);
      routeEphemeral(state, dm, "s1", frame, all, t, version === "refused" ? null : version);
      if (version !== "refused") dm.gestures.release(version);
    };
    const lead = ids[0]!;
    group({ k: "dragStart", tokenId: lead, g: 1, ...at(lead), ...roster(0) }, 0);
    for (let step = 1; step <= 12; step++) {
      const x = at(lead).x + step * 0.75;
      const y = at(lead).y + (step % 3) * 0.5;
      if (step % 4 === 0) group({ k: "dragMove", tokenId: lead, g: 1, x, y, ...roster(step * 0.75) }, step * 33);
      else group({ k: "dragMove", tokenId: lead, g: 1, x, y, fts: ids.slice(1).map((_, i) => (i % 3 === 0 ? 5 * step : null)) }, step * 33);
      // Between passes the room changes: creatures written in place or replaced, each between fogged ground out of sight
      // and revealed ground in a character's sight, then the light and a wall moved.
      const spot = step % 2 === 1 ? { x: 26, y: 16 } : { x: 10, y: 12 };
      for (const i of [2, 6]) Object.assign(state.tokens[ids[i]!]!, spot);
      state.tokens[ids[4]!] = { ...state.tokens[ids[4]!]!, x: spot.x + 1, y: spot.y + 1 };
      if (step === 6) state.lights = { l1: { ...state.lights.l1!, x: 8, y: 4 } };
      if (step === 8) {
        const [key, chunk] = Object.entries(state.buildChunks)[0]!;
        state.buildChunks = { ...state.buildChunks, [key]: { ...chunk, walls: (chunk.walls ?? []).slice(1) } };
      }
    }
    group({ k: "groupEnd", tokenId: lead, g: 1, at: ids.map((id) => ({ x: at(id).x + 9, y: at(id).y })) }, 500);
    for (const [n, id] of ids.slice(0, 14).entries()) {
      const from = at(id);
      const lone = (e: EphEvent, t: number) => routeEphemeral(state, dm, "s1", e, all, t);
      lone({ k: "dragStart", tokenId: id, ...from }, 1_000 + n * 100);
      for (let step = 1; step <= 8; step++) lone({ k: "dragMove", tokenId: id, x: from.x + step * 1.5, y: from.y + step * 0.25 }, 1_000 + n * 100 + step * 11);
      lone({ k: "dragEnd", tokenId: id, x: from.x + 12, y: from.y + 2 }, 1_000 + n * 100 + 99);
    }
    return bytes;
  } finally {
    setFootprintMemoOffForTests(false);
  }
}

describe("a routing pass's footprint memo changes no receiver's bytes", () => {
  for (const shape of ["hexRows", "hexColumns", undefined] as const) {
    for (const kind of KINDS) {
      test(`${shape ?? "squares"}, ${kind.name}: the same frames give every receiver the same bytes with the memo and without it`, () => {
        const without = route(shape, kind, false);
        const withMemo = route(shape, kind, true);
        assert.deepEqual(withMemo, without);
        // Not vacuous: each player gets frames, and fewer than the second DM, so withholding ran both ways.
        for (const p of PLAYERS) {
          assert.ok(without[p]!.length > 0, `${p} gets frames`);
          assert.ok(without[p]!.join("").length < without.dm2!.join("").length, `${p} is withheld some`);
        }
      });
    }
  }
});
