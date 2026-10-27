import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { lineAudience } from "./logRings.ts";
import type { RoomState, Viewer } from "./model.ts";
import { opSchema } from "./protocol.ts";
import { hash128, projectState, stableStringify, type ProjectedState } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { seenWhole } from "./rules/path.ts";
import { DM, P1, P2, env, randomOp, randomState, rng } from "./testutil.ts";

/**
 * Whole-party scenes are byte for byte as before per-player vision
 * (docs/design-v1-per-player-vision.md section 9, rule 12): random rooms,
 * none of whose scenes is per player, go through random ops, and every
 * state the reducer leaves, every answer it gives and every viewer's
 * projection hash as they did on the build before per-player vision. The
 * fixture holds those hashes, one per seed, beside a hash of the inputs.
 *
 * The inputs come from testutil.ts's generators. When those change, the
 * inputs' hash no longer matches and the test says so: write the fixture
 * again on the parent of the change that moved the generators, with
 * PV_GOLDEN=write, so it records what the code did before.
 */

const FIXTURE = new URL("./pervision.golden.fixture.json", import.meta.url);
const SEEDS = 150;
const OPS = 40;
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const VIEWS: readonly [Viewer, string][] = [
  [DM, "s1"],
  [DM, "s2"],
  [P1, "s1"],
  [P2, "s1"],
  [DISPLAY, "s1"],
];

/*
 * The collections per-player vision and map discovery add hold nothing on
 * these rooms, and so say nothing the build before held. The played marks
 * a move of the players writes are bookkeeping no build before wrote, so
 * they are left out with their keys (docs/design-v1-map-discovery.md 5.5).
 */
function stored(state: RoomState): string {
  const room = { ...state } as Record<string, unknown>;
  delete room.playedScenes;
  room.log = withReminders(state, state.log);
  if (state.reminded) room.reminded = remindedBefore(state, state.reminded);
  for (const field of ["holders", "exploredBy", "memory", "memoryBy", "memoryShared"]) {
    const value = room[field];
    if (value !== undefined && Object.keys(value as object).length === 0) delete room[field];
  }
  return stableStringify(room);
}

/*
 * What map discovery changed in a player's copy of a scene with fog on, by
 * design, left out of its hash: the chunks they hold and the scene copy's
 * automatic walls rule (docs/design-v1-map-discovery.md 5.2), the route
 * corners of a private leg on a scene with vision (decision 12), and which
 * area reminders there they read (onFoggedArea). Legs seen whole keep their
 * corners. Scenes with fog off stay byte for byte, and so does everything
 * else on those with it.
 */
function seenBy(state: RoomState, viewer: Viewer, view: ProjectedState): string {
  if (viewer.role === "dm") return stableStringify({ ...view, log: withReminders(state, view.log) });
  const fogged = (sceneId: string) => state.scenes[sceneId]?.fogEnabled === true;
  const out = { ...view, log: view.log.filter((line) => !onFoggedArea(state, line)) } as Record<string, unknown>;
  out.buildChunks = Object.fromEntries(Object.entries(view.buildChunks).filter(([, chunk]) => !fogged(chunk.sceneId)));
  out.scenes = Object.fromEntries(
    Object.entries(view.scenes).map(([id, scene]) => {
      if (!fogged(id)) return [id, scene];
      const { autoWalls: _autoWalls, ...rest } = scene as Record<string, unknown>;
      return [id, rest];
    }),
  );
  out.tokens = Object.fromEntries(
    Object.entries(view.tokens).map(([id, token]) => {
      const path = token.path;
      if (!path || !fogged(token.sceneId) || state.scenes[token.sceneId]?.vision?.on !== true) return [id, token];
      const real = state.tokens[id]?.path?.stops;
      return [id, { ...token, path: { ...path, stops: path.stops.map((stop, k) => (real && seenWhole(real, k, true) ? stop : (({ via: _via, ...rest }) => rest)(stop))) } }];
    }),
  );
  return stableStringify(out);
}

/*
 * An area's reminder about a creature on a scene with fog on, or one no
 * longer in the room: map discovery reads its rays against each player's
 * live ground (docs/design-v1-map-discovery.md decision 13), so whom it is
 * for may change by design, and with that how many copies are written (one
 * for those who saw it, one for the DM alone) and the numbers they take.
 * Such lines are kept as the reminders they give, each once, without ids
 * or audience (withReminders), and a player's copy leaves them out, since
 * there whether they hold one is whom it is for.
 */
function onFoggedArea(state: RoomState, line: RoomState["log"][number]): boolean {
  return line.data?.type === "area" && foggedCreature(state, line.data.tokenId);
}

function foggedCreature(state: RoomState, tokenId: string): boolean {
  const token = state.tokens[tokenId];
  return !token || state.scenes[token.sceneId]?.fogEnabled === true;
}

/* Lines with those reminders taken out and put after them as a sorted set of what each says, its marks of who saw it left out. */
function withReminders(state: RoomState, lines: readonly RoomState["log"][number][]): unknown[] {
  return [...lines.filter((line) => !onFoggedArea(state, line)), ...reminders(state, lines)];
}

function reminders(state: RoomState, lines: readonly RoomState["log"][number][]): string[] {
  const said = new Set<string>();
  for (const line of lines) {
    if (!onFoggedArea(state, line) || line.data?.type !== "area") continue;
    const { seen: _seen, seenBy: _seenBy, hidden: _hidden, ...data } = line.data;
    said.add(stableStringify({ at: line.at, kind: line.kind, data }));
  }
  return [...said].sort();
}

/*
 * The record of who read which reminders this turn, its pairs about such
 * creatures gathered from every audience into one, so it keeps which
 * reminders were given but not to whom.
 */
function remindedBefore(state: RoomState, reminded: NonNullable<RoomState["reminded"]>): unknown {
  const masked: Record<string, Record<string, number>> = {};
  const pairs = (p: Record<string, Record<string, number>> | undefined) => {
    if (!p) return undefined;
    const out: Record<string, Record<string, number>> = {};
    for (const [area, byToken] of Object.entries(p)) {
      for (const [tokenId, mask] of Object.entries(byToken)) {
        const into = foggedCreature(state, tokenId) ? masked : out;
        into[area] = { ...into[area], [tokenId]: (into[area]?.[tokenId] ?? 0) | mask };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const shared = pairs(reminded.shared);
  const players = Object.fromEntries(Object.entries(reminded.players ?? {}).flatMap(([id, p]) => (pairs(p) ? [[id, pairs(p)]] : [])));
  const dm = pairs(reminded.dm);
  return { shared, players: Object.keys(players).length > 0 ? players : undefined, dm, masked: Object.keys(masked).length > 0 ? masked : undefined };
}

/*
 * The keys a step touched, in its order, but the played marks and the log
 * keys of those reminders, before or after it: a copy for an audience may
 * now be written or not, or numbered for the DM at once rather than settled
 * there, so those keys differ by design. So do those of no line before or
 * after the step, numbers a reminder took and gave back as it settled.
 */
function touchedBefore(touched: readonly string[], before: RoomState, after: RoomState): string {
  const lines = [...before.log, ...after.log];
  const area = new Set(lines.filter((line) => onFoggedArea(after, line) || onFoggedArea(before, line)).map((line) => `log:${line.id}`));
  const held = new Set(lines.map((line) => `log:${line.id}`));
  return touched.filter((key) => !key.startsWith("played:") && !(key.startsWith("log:") && (area.has(key) || !held.has(key)))).join(",");
}

function run(seed: number): { input: string; output: string } {
  const r = rng(seed);
  let state = randomState(r);
  const inputs: string[] = [stored(state)];
  const outputs: string[] = [];
  for (let i = 0; i < OPS; i++) {
    const who = i % 5 === 4 ? (i % 2 === 0 ? P1 : P2) : DM;
    const op = opSchema.parse(randomOp(r, state, who));
    inputs.push(stableStringify(op));
    const result = applyOp(state, op, who, env(100 + i));
    if (!result.ok) {
      outputs.push(`refused ${result.code}: ${result.message}`);
      continue;
    }
    const before = state;
    state = result.state;
    outputs.push(hash128(stored(state)), String(result.global), touchedBefore(result.touched, before, state));
    for (const line of result.log) if (!onFoggedArea(state, line)) outputs.push(`${line.id} ${lineAudience(line)}`);
    outputs.push(...reminders(state, result.log));
    for (const [viewer, sceneId] of VIEWS) outputs.push(hash128(seenBy(state, viewer, projectState(state, viewer, { sceneId }))));
  }
  return { input: hash128(inputs.join("\n")), output: hash128(outputs.join("\n")) };
}

describe("whole-party scenes as before per-player vision", () => {
  test("random rooms and ops leave the same states, answers and projections", () => {
    const got = Array.from({ length: SEEDS }, (_, i) => run(i + 1));
    if (process.env.PV_GOLDEN === "write") {
      writeFileSync(FIXTURE, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as { input: string; output: string }[];
    assert.equal(want.length, SEEDS);
    for (const [i, w] of want.entries()) {
      assert.equal(got[i]!.input, w.input, `seed ${i + 1}: the generators changed, so the fixture compares other rooms (see the note above)`);
      assert.equal(got[i]!.output, w.output, `seed ${i + 1}: a whole-party room changed`);
    }
  });
});
