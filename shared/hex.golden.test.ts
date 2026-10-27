import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { lineAudience } from "./logRings.ts";
import type { RoomState, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { opSchema, type Op } from "./protocol.ts";
import { hash128, projectState, stableStringify, type ProjectedState } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, env, randomOp, randomState, rng } from "./testutil.ts";

/**
 * Square scenes are byte for byte as before hex grids
 * (docs/design-v1-hex-grids.md section 10): random rooms, every scene of
 * them on squares, go through random ops, and every permission decision,
 * every state the reducer leaves, every answer it gives, every viewer's
 * projection and the undo of each step hash as they did on the build
 * before hex grids. The fixture holds those hashes, one per seed, beside
 * a hash of the inputs.
 *
 * The inputs come from testutil.ts's generators. When those change, the
 * inputs' hash no longer matches and the test says so: write the fixture
 * again on the parent of the change that moved the generators, with
 * HEX_GOLDEN=write, so it records what the code did before.
 */

const FIXTURE = new URL("./hex.golden.fixture.json", import.meta.url);
const SEEDS = 120;
const OPS = 40;
const deps = { canUseAsset: () => true };
const VIEWS: readonly [Viewer, string][] = [
  [DM, "s1"],
  [P1, "s1"],
  [P2, "s2"],
];

/*
 * Map discovery's collections hold nothing on these rooms, and so say
 * nothing the build before held. The played marks a move of the players
 * writes are bookkeeping no build before wrote, so they are left out with
 * their keys (docs/design-v1-map-discovery.md 5.5).
 */
const DISCOVERY = ["memory", "memoryBy", "memoryShared"] as const;

function stored(state: RoomState): string {
  const room = { ...state } as Record<string, unknown>;
  delete room.playedScenes;
  room.log = state.log.filter((line) => !onFoggedArea(state, line));
  if (state.reminded) room.reminded = remindedBefore(state, state.reminded);
  for (const field of DISCOVERY) if (Object.keys((room[field] as object | undefined) ?? {}).length === 0) delete room[field];
  return stableStringify(room);
}

/*
 * What map discovery changed in a player's copy of a scene with fog on, by
 * design, left out of its hash: the chunks they hold and the scene copy's
 * automatic walls rule (docs/design-v1-map-discovery.md 5.2), with vision
 * on a private leg's route corners (decision 12), and the area reminders
 * there (onFoggedArea). Scenes with fog off stay byte for byte, and so
 * does everything else on those with it.
 */
function seenBy(state: RoomState, viewer: Viewer, view: ProjectedState): string {
  if (viewer.role === "dm") return stableStringify({ ...view, log: view.log.filter((line) => !onFoggedArea(state, line)) });
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
      return [id, { ...token, path: { ...path, stops: path.stops.map(({ via: _via, ...stop }) => stop) } }];
    }),
  );
  return stableStringify(out);
}

/*
 * A player's refusal on a scene with fog on in words the touch rule may
 * change by design (docs/design-v1-map-discovery.md 6, decision 11): what
 * stopped a move or a resize, its code kept, and a door's answer, whose
 * reach it now judges before whether the door is still there. Every other
 * refusal stays.
 */
const TOUCH_WORDS = new Set(["A wall is in the way.", "A ledge is in the way.", "Something blocks the way.", "a wall is in the way", "a ledge is in the way", "something blocks the way", "No room to grow here.", "no room to grow here", "it only squeezes where an opening is too narrow for it"]);

function touchBlind(state: RoomState, who: Viewer, op: Op, code: string, message: string): string {
  const said = `${code}: ${message}`;
  if (who.role === "dm" || !Object.values(state.scenes).some((scene) => scene.fogEnabled)) return said;
  if (op.t === "door.set" && state.scenes[op.sceneId]?.fogEnabled === true) return "a door's answer";
  return TOUCH_WORDS.has(message) ? `${code}: stopped` : said;
}

/*
 * An area's reminder about a creature on a scene with fog on, or one no
 * longer in the room: map discovery reads its rays against each player's
 * live ground (docs/design-v1-map-discovery.md decision 13), so who reads
 * it, and so whether a line is written for an audience that read one this
 * turn, may change by design. Such lines are left out.
 */
function onFoggedArea(state: RoomState, line: RoomState["log"][number]): boolean {
  return line.data?.type === "area" && foggedCreature(state, line.data.tokenId);
}

function foggedCreature(state: RoomState, tokenId: string): boolean {
  const token = state.tokens[tokenId];
  return !token || state.scenes[token.sceneId]?.fogEnabled === true;
}

/* The record of who read which reminders this turn, but those about such creatures, and any audience left with none. */
function remindedBefore(state: RoomState, reminded: NonNullable<RoomState["reminded"]>): unknown {
  const pairs = (p: Record<string, Record<string, number>> | undefined) => {
    if (!p) return undefined;
    const out = Object.fromEntries(
      Object.entries(p)
        .map(([area, byToken]) => [area, Object.fromEntries(Object.entries(byToken).filter(([tokenId]) => !foggedCreature(state, tokenId)))] as const)
        .filter(([, byToken]) => Object.keys(byToken).length > 0),
    );
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const players = Object.fromEntries(Object.entries(reminded.players ?? {}).flatMap(([id, p]) => (pairs(p) ? [[id, pairs(p)]] : [])));
  return { shared: pairs(reminded.shared), players: Object.keys(players).length > 0 ? players : undefined, dm: pairs(reminded.dm) };
}

/* The keys a step touched, as a set, but the lines left out (onFoggedArea). */
function touchedBefore(touched: readonly string[], state: RoomState, lines: RoomState["log"]): string {
  const left = new Set(lines.filter((line) => onFoggedArea(state, line)).map((line) => `log:${line.id}`));
  return touched
    .filter((key) => !key.startsWith("played:") && !left.has(key))
    .sort()
    .join(",");
}

function answer(result: ReturnType<typeof applyOp>): string[] {
  if (!result.ok) return [`refused ${result.code}: ${result.message}`];
  const out = [hash128(stored(result.state)), String(result.global), touchedBefore(result.touched, result.state, result.log)];
  for (const line of result.log) if (!onFoggedArea(result.state, line)) out.push(`${line.id} ${lineAudience(line)}`);
  return out;
}

function run(seed: number): { input: string; output: string } {
  const r = rng(seed);
  let state: RoomState = randomState(r);
  const inputs: string[] = [stored(state)];
  const outputs: string[] = [];
  for (let i = 0; i < OPS; i++) {
    // Every fourth op is a player's, the two taking turns.
    const who = i % 4 === 3 ? (Math.floor(i / 4) % 2 === 0 ? P1 : P2) : DM;
    const op = opSchema.parse(randomOp(r, state, who));
    inputs.push(stableStringify(op));
    const decision = canApply(op, who, state, deps);
    outputs.push(decision.ok ? "allowed" : touchBlind(state, who, op, decision.code, decision.message));
    const result = applyOp(state, op, who, env(100 + i));
    outputs.push(...answer(result));
    if (!result.ok) continue;
    const inverse = result.inverse;
    outputs.push(inverse === null ? "no undo" : hash128(stableStringify(inverse)));
    if (inverse !== null && i % 3 === 0) {
      // The step's undo, as the server builds it: through the same restore every undo and redo takes.
      const undo: Op = { t: "sys.restore", entries: inverse, from: "undo", deps: true };
      outputs.push(...answer(applyOp(result.state, undo, DM, env(1_000 + i))));
    }
    state = result.state;
    for (const [viewer, sceneId] of VIEWS) outputs.push(hash128(seenBy(state, viewer, projectState(state, viewer, { sceneId }))));
  }
  return { input: hash128(inputs.join("\n")), output: hash128(outputs.join("\n")) };
}

describe("square scenes as before hex grids", () => {
  test("random rooms and ops get the same decisions, states, answers, projections and undos", () => {
    const got = Array.from({ length: SEEDS }, (_, i) => run(i + 1));
    if (process.env.HEX_GOLDEN === "write") {
      writeFileSync(FIXTURE, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as { input: string; output: string }[];
    assert.equal(want.length, SEEDS);
    for (const [i, w] of want.entries()) {
      assert.equal(got[i]!.input, w.input, `seed ${i + 1}: the generators changed, so the fixture compares other rooms (see the note above)`);
      assert.equal(got[i]!.output, w.output, `seed ${i + 1}: a square room changed`);
    }
  });
});
