import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AreaTemplate, RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { creaturesInArea, type AreaContext, type AreaToken } from "#shared/rules/aoe.ts";
import { describeMove, type MovedToken } from "#shared/rules/moveLeg.ts";
import { pieceReach, type RoutePoint } from "#shared/rules/route.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, chance, env, int, pick, rng, template, token } from "#shared/testutil.ts";
import { raised, world } from "../movement/testing.ts";

/**
 * The areas a committed walk reminds a creature of, against an oracle that
 * reads each walk's footprint by the rule itself (docs/design-v1-attach.md
 * 9, reviews AT-SOL-4, AT-ASTRA-23 and AT-O-29): a creature that walks on
 * its own is squeezed only on its walk's first piece short of its end, as it
 * started, a creature a holder drags is never squeezed on the way, and the
 * walk's end is the token as the move left it. Random Large and Huge
 * creatures, squeezed or not, walk random routes and straight legs on their
 * own or dragged by a holder, over raised ground, past random areas that
 * hit on entering. The oracle samples every walk eight times as densely as
 * the reducer sweeps it, at the same progress for every token the move
 * takes. At the reducer's own points it must find exactly the reminders the
 * log has, and a creature it finds inside an area for a run of samples
 * longer than the sweep's step is reminded.
 */

const DENSER = 8;
const SWEEP_STEP = 0.5;
const MAX_SWEEP_POINTS = 600;

type Case = { state: RoomState; op: Op };

function randomCase(r: () => number): Case {
  const size = pick(r, ["large", "huge"] as const);
  const side = size === "huge" ? 3 : 2;
  const heights: Record<string, number> = {};
  for (let i = int(r, 0, 3); i > 0; i--) {
    const x = int(r, 4, 22);
    const y = int(r, 4, 22);
    Object.assign(heights, raised(x, y, x + int(r, 1, 4), y + int(r, 1, 4), pick(r, [5, 10])));
  }
  const squeeze = chance(r, 0.6);
  const tokens: Token[] = [token("gob", { name: "Goblin", x: 28, y: 28 })];
  const drags = chance(r, 0.5);
  let mover: Token;
  if (drags) {
    mover = token("pc", { name: "Pc", kind: "pc", x: int(r, 8, 20), y: int(r, 8, 20) });
    tokens.push(mover, token("brute", { name: "Brute", size, x: mover.x - side, y: mover.y - int(r, 0, side - 1), ...(squeeze ? { squeeze: true as const } : {}), attached: { to: "pc", kind: "drag" } }));
    if (chance(r, 0.3)) tokens.push(token("imp", { name: "Imp", size: "small", x: mover.x + 1, y: mover.y, attached: { to: "pc", kind: "drag" } }));
  } else {
    mover = token("brute", { name: "Brute", size, x: int(r, 8, 20) + pick(r, [0, 0.5]), y: int(r, 8, 20) + pick(r, [0, 0.5]), ...(squeeze ? { squeeze: true as const } : {}) });
    tokens.push(mover);
  }
  let state = world({ blockMovement: chance(r, 0.5), heights, tokens });
  for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "e1", tokenId: mover.id, value: 20 }, { id: "e2", tokenId: "gob", value: 5 }] }, { t: "encounter.next" }] as Op[]).entries()) {
    const out = applyOp(state, op, DM, env(i + 1));
    assert.ok(out.ok);
    state = out.state;
  }
  // A route of one to four pieces, or now and then a straight leg.
  const step = (p: { x: number; y: number }) => ({ x: Math.max(0, Math.min(26, p.x + int(r, -4, 4))), y: Math.max(0, Math.min(26, p.y + int(r, -4, 4))) });
  const ends: { x: number; y: number }[] = [];
  let at: { x: number; y: number } = mover;
  for (let i = int(r, 1, 4); i > 0; i--) {
    const next = step(at);
    if (next.x === at.x && next.y === at.y) continue;
    ends.push(next);
    at = next;
  }
  const end = ends.at(-1) ?? { x: Math.min(26, mover.x + 3), y: mover.y };
  const routed = ends.length > 0 && chance(r, 0.75);
  const op: Op = {
    t: "token.move",
    tokenId: mover.id,
    x: end.x,
    y: end.y,
    ...(routed ? { route: ends.map((p): [number, number, number, 0 | 1] => [p.x, p.y, 0, 0]) } : {}),
    ...(!drags && chance(r, 0.2) ? { squeeze: true } : {}),
  };
  // Areas near the walk: each about a random spot of it, at a random height.
  const path = [{ x: mover.x, y: mover.y }, ...(routed ? ends : [end])];
  for (let i = int(r, 3, 5); i > 0; i--) {
    const k = int(r, 1, path.length - 1);
    const f = r();
    const a = path[k - 1]!;
    const b = path[k]!;
    const origin = { x: a.x + (b.x - a.x) * f + int(r, -3, 3) / 2 + side / 2, y: a.y + (b.y - a.y) * f + int(r, -3, 3) / 2 + side / 2, z: pick(r, [0, 0, 5, 10]) };
    state.templates[`a${i}`] = template(`a${i}`, { shape: pick(r, ["sphere", "cube", "cylinder"] as const), size: pick(r, [5, 5, 10, 15]), origin, triggers: ["enter"] });
  }
  return { state, op };
}

function lerp(a: RoutePoint, b: RoutePoint, f: number): RoutePoint {
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, elevation: a.elevation + (b.elevation - a.elevation) * f };
}

/** A token at a point of its walk with the footprint the rule gives it there, read from the walk's points and its start, never its trace. */
function oracleAt(walk: MovedToken, before: Token, after: Token, routed: boolean, piece: number, f: number): Token {
  const points = walk.route;
  const last = points.length - 1;
  const [spot, p, end] = !routed ? [lerp(points[0]!, points[last]!, f), 0, f >= 1] : piece > last ? [points[last]!, last - 1, true] : [lerp(points[piece - 1]!, points[piece]!, f), piece - 1, f >= 1];
  if ((end ? p + 1 : p) >= last) return after;
  const { squeeze: _squeeze, ...rest } = after;
  const squeezed = walk.carriedBy === undefined && before.squeeze === true && p === 0 && !end;
  return { ...rest, x: spot.x, y: spot.y, elevation: spot.elevation, ...(squeezed ? { squeeze: true as const } : {}) };
}

/** The progress points of the move at the reducer's density times `denser`, each marked when the reducer samples it, ending with the move's end. */
function progress(walks: readonly MovedToken[], routed: boolean, fpc: number, denser: number): { piece: number; f: number; swept: boolean }[] {
  const named = walks.filter((w) => w.carriedBy === undefined);
  const out: { piece: number; f: number; swept: boolean }[] = [];
  if (routed) {
    const lead = named[0]!.route;
    for (let i = 1; i < lead.length; i++) {
      const n = Math.max(1, Math.ceil(pieceReach(lead[i - 1]!, lead[i]!, fpc) / SWEEP_STEP)) * denser;
      for (let j = 1; j <= n; j++) out.push({ piece: i, f: j / n, swept: j % denser === 0 });
    }
  } else {
    const reach = Math.max(0, ...named.map((w) => pieceReach(w.from, w.to, fpc)));
    const n = Math.min(MAX_SWEEP_POINTS, Math.max(1, Math.ceil(reach / SWEEP_STEP))) * denser;
    for (let j = 1; j <= n; j++) out.push({ piece: 1, f: j / n, swept: j % denser === 0 });
  }
  return out;
}

function inArea(area: AreaTemplate, t: Token, ctx: AreaContext): boolean {
  return creaturesInArea(area, [t as AreaToken], ctx).length > 0;
}

describe("a walk reminds a creature of every area its walk's footprint enters (docs/design-v1-attach.md 9)", () => {
  test("random squeezed and full size creatures walking on their own or dragged, past random areas", () => {
    let cases = 0;
    let reminders = 0;
    let squeezedOwn = 0;
    let squeezedDragged = 0;
    let runs = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const c = randomCase(r);
      const where = `seed ${seed}: ${JSON.stringify(c.op)}`;
      if (!canApply(c.op, DM, c.state, { canUseAsset: () => true }).ok) continue;
      const applied = applyOp(c.state, c.op, DM, env(9));
      if (!applied.ok) continue;
      const before = c.state;
      const after = applied.state;
      const routed = c.op.t === "token.move" && c.op.route !== undefined;
      const walks = describeMove(c.op, before, after, DM, env(9)).filter((w) => {
        const a = before.tokens[w.tokenId]!;
        const b = after.tokens[w.tokenId]!;
        return a.x !== b.x || a.y !== b.y || a.elevation !== b.elevation;
      });
      if (walks.length === 0) continue;
      cases++;
      const scene = after.scenes.s1!;
      const ctx = (state: RoomState): AreaContext => ({ settings: state.meta.settings, bounds: scene.bounds, walls: sceneWalls(scene, state.buildChunks), tokens: state.tokens as Readonly<Record<string, AreaToken>> });
      const beforeCtx = ctx(before);
      const afterCtx = ctx(after);
      const fine = progress(walks, routed, after.meta.settings.feetPerCell, DENSER);
      const logged = new Set(applied.log.flatMap((e) => (e.data?.type === "area" && e.data.trigger === "enter" ? [`${e.data.templateId}/${e.data.tokenId}`] : [])));
      for (const area of Object.values(after.templates)) {
        for (const walk of walks) {
          const was = before.tokens[walk.tokenId]!;
          const now = after.tokens[walk.tokenId]!;
          const reminded = logged.has(`${area.id}/${walk.tokenId}`);
          if (inArea(before.templates[area.id]!, was, beforeCtx)) {
            assert.equal(reminded, false, `${where}: ${walk.tokenId} was in ${area.id} before it moved`);
            continue;
          }
          const hits = fine.map((p) => inArea(area, oracleAt(walk, was, now, routed, p.piece, p.f), afterCtx));
          const sweptHit = hits.some((h, i) => h && fine[i]!.swept);
          let run = 0;
          let longest = 0;
          for (const h of hits) longest = Math.max(longest, (run = h ? run + 1 : 0));
          const what = `${where}: ${walk.tokenId} and ${area.id} ${JSON.stringify(area.origin)} ${area.shape} ${area.size}, the walk ${JSON.stringify(walk.route)}`;
          assert.equal(reminded, sweptHit, `${what}: reminded ${reminded}, the oracle at the reducer's points ${sweptHit}`);
          if (longest >= DENSER) {
            assert.ok(reminded, `${what}: inside for ${longest} samples of the dense sweep and never reminded`);
            runs++;
          }
          if (!reminded) continue;
          reminders++;
          if (walk.carriedBy === undefined && was.squeeze) squeezedOwn++;
          if (walk.carriedBy !== undefined && was.squeeze) squeezedDragged++;
        }
      }
    }
    // A run with few reminders, or none of a creature that starts squeezed, on its own or dragged, tests nothing.
    assert.ok(cases > 250 && reminders > 150 && squeezedOwn > 30 && squeezedDragged > 30 && runs > 100, JSON.stringify({ cases, reminders, squeezedOwn, squeezedDragged, runs }));
  });
});
