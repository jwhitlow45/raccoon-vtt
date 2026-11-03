import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { lift, paint, wall } from "./discoveryTestutil.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import { visionRules } from "./ruleHooks.ts";
import type { RoomState, Token, Viewer } from "./model.ts";
import { canApply, touchLanding, type PermissionDeps } from "./permissions.ts";
import { gridOfToken, projectState, stableStringify } from "./project.ts";
import { opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { linkHolds } from "./rules/attach.ts";
import { footprintRect } from "./rules/footprint.ts";
import { SQUARES } from "./rules/grid.ts";
import { nudgeValid } from "./rules/nudge.ts";
import { DM, P1, P2, chance, env, int, member, pick, rng, room, scene, token, trap } from "./testutil.ts";

/**
 * The rules are blind to where a token is drawn (docs/design/design-v1-snap-off.md
 * section 10, D-261102-438). Random runs of moves, group moves, placements
 * in place and Snap to grid, facing, height, size, scene and place edits,
 * rides and drags, a trap that stops walks, walls a walk can be landed
 * short of by the touch rule, switches of the scene to hexes and back, and
 * the DM's undo of the last step, by the DM and by a player, each played
 * twice: as generated, and stripped of every `drawnAt`, with an op left as
 * an empty patch dropped. After every step:
 * - N1: both runs took or refused the op alike, and a player's refused move
 *   landed alike by the touch rule.
 * - N2: the two rooms are equal but for tokens' revs and nudges.
 * - N3: so is every viewer's copy, the DM's, each player's and a table display's.
 * - N4: every stored nudge holds where its token stands (rules/nudge.ts nudgeValid).
 * - N5: a nudge is never more than its bound off the box its token would snap to from where it is drawn.
 * It covers the shared reducer, permissions and projection only. The
 * client's reads are the rendering and drag-boundary tests' (lanes B and C).
 */

const deps: PermissionDeps = { canUseAsset: () => true };
const DISPLAY: Viewer = { role: "player", memberId: "display:abcdefghijkl" };
const SEEDS = Number(process.env.NUDGE_SEEDS ?? 70);
const TOKENS = ["bree", "horse", "gob", "ogre", "cat", "box", "statue", "shade"] as const;

function start(r: () => number): RoomState {
  const s = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") },
    // Dark and fogged with the party's ground explored west of the wall, so a walk into it is landed short by the touch rule.
    scenes: { s1: scene("s1", { bounds: { w: 20, h: 12 }, blockMovement: true, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "dark" } }), s2: scene("s2", { bounds: { w: 20, h: 12 } }), hx: scene("hx", { bounds: { w: 20, h: 12 }, gridShape: "hexRows" }) },
  });
  s.buildChunks = {};
  paint(s, { x: 0, y: 0, w: 20, h: 12 });
  lift(s, "party", { x: 0, y: 0, w: 10, h: 12 });
  wall(s, "nudgewall0001", [10, 0], [10, 5]);
  wall(s, "nudgewall0002", [10, 7], [10, 12]);
  s.tokens.bree = token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 2, y: 2 });
  s.tokens.horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", ownerIds: ["p1"], x: 4, y: 6 });
  s.tokens.gob = token("gob", { name: "Goblin", x: 4, y: 6, attached: { to: "horse", kind: "ride", steer: true } });
  s.tokens.ogre = token("ogre", { name: "Ogre", size: "large", x: 14, y: 3 });
  s.tokens.cat = token("cat", { name: "Cat", kind: "npc", size: "tiny", ownerIds: ["p1"], x: 2.5, y: 2.5, attached: { to: "bree", kind: "carry" } });
  s.tokens.box = token("box", { name: "Crate", kind: "object", size: "custom", w: 1.75, h: 1.75, x: 6, y: 2 });
  s.tokens.statue = token("statue", { name: "Statue", kind: "npc", ownerIds: ["p1"], x: 8, y: 9, locked: true });
  s.tokens.shade = token("shade", { name: "Shade", x: 12, y: 9, visibility: "dm" });
  // Every link holds at the start, as every op leaves a room (reducer/attach.ts linkPass).
  for (const t of Object.values(s.tokens)) if (t.attached) assert.ok(linkHolds(SQUARES, s.meta.settings, t.attached.kind, t, s.tokens[t.attached.to]!), t.id);
  s.traps.plate = trap("plate", { zone: { cells: [{ x: int(r, 3, 8), y: int(r, 1, 9), w: 1, h: 1 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } });
  return s;
}

/** A spot the token could aim at, mostly on its grid, sometimes half off it. */
function spot(r: () => number, t: Token): { x: number; y: number } {
  const step = t.size === "tiny" ? 0.5 : 1;
  const x = int(r, 0, 36) * step;
  const y = int(r, 0, 22) * step;
  return chance(r, 0.1) ? { x: x + 0.5 * step, y } : { x: Math.min(x, 18), y: Math.min(y, 10) };
}

/** Where a drop is drawn: often within the bound of the aim, sometimes past it or keeping the token's own nudge. */
function drawnAt(r: () => number, t: Token, at: { x: number; y: number }): { x: number; y: number } | undefined {
  if (chance(r, 0.3)) return undefined;
  if (t.nudge && chance(r, 0.3)) return { x: at.x + t.nudge.x / 8, y: at.y + t.nudge.y / 8 };
  return { x: at.x + int(r, -5, 5) / 8, y: at.y + int(r, -5, 5) / 8 };
}

function randomOp(r: () => number, s: RoomState, last: { both: boolean } | null): { op: Op; who: Viewer } {
  const who = chance(r, 0.4) ? P1 : DM;
  const id = pick(r, TOKENS);
  const t = s.tokens[id]!;
  const roll = r();
  if (roll < 0.3) {
    const at = spot(r, t);
    const d = drawnAt(r, t, at);
    return { op: { t: "token.move", tokenId: id, ...at, ...(d ? { drawnAt: d } : {}), ...(chance(r, 0.05) ? { squeeze: true as const } : {}) }, who };
  }
  if (roll < 0.42) {
    const ids = [...new Set([id, pick(r, TOKENS), pick(r, TOKENS)])];
    const dx = int(r, -3, 3);
    const dy = int(r, -2, 2);
    const moves = ids.map((m) => {
      const tok = s.tokens[m]!;
      const at = { x: tok.x + dx, y: tok.y + dy };
      const d = drawnAt(r, tok, at);
      return { tokenId: m, ...at, ...(d ? { drawnAt: d } : {}) };
    });
    return { op: { t: "token.moveMany", moves }, who };
  }
  if (roll < 0.6) {
    const placed = chance(r, 0.25) ? null : { x: t.x + int(r, -4, 4) / 8, y: t.y + int(r, -4, 4) / 8 };
    return { op: { t: "token.update", tokenId: id, patch: { drawnAt: placed } }, who };
  }
  if (roll < 0.72) {
    const patch = pick(r, [{ rotation: int(r, 0, 3) * 90 }, { elevation: int(r, 0, 2) * 5 }, { size: pick(r, ["tiny", "medium", "large"] as const) }, { x: t.x + int(r, -1, 1) }, { sceneId: pick(r, ["s1", "s2", "hx"]) }, { locked: chance(r, 0.5) }]);
    return { op: { t: "token.update", tokenId: id, patch }, who: "size" in patch || "rotation" in patch ? who : DM };
  }
  if (roll < 0.8) {
    const holder = pick(r, ["horse", "bree", "ogre"] as const);
    const h = s.tokens[holder]!;
    if (id === holder || chance(r, 0.4)) return { op: { t: "token.detach", tokenId: id }, who };
    const kind = holder === "horse" ? "ride" : pick(r, ["drag", "carry"] as const);
    const seat = { x: h.x + pick(r, [0, 0.5, 1]), y: h.y + pick(r, [0, 0.5, 1]) };
    return { op: { t: "token.attach", tokenId: id, to: holder, kind, ...seat, elevation: h.elevation }, who };
  }
  if (roll < 0.88) return { op: { t: "scene.update", sceneId: pick(r, ["s1", "s2"]), patch: { gridShape: chance(r, 0.5) ? "hexRows" : "squares" } }, who: DM };
  if (roll < 0.94 && last?.both) return { op: { t: "undo" } as unknown as Op, who: DM };
  return { op: { t: "token.move", tokenId: "bree", x: 14, y: s.tokens.bree!.y, drawnAt: { x: 14.25, y: s.tokens.bree!.y } }, who: P1 };
}

/** The op without `drawnAt`, or null when nothing is left of it. */
function stripped(op: Op): Op | null {
  if (op.t === "token.move") {
    const { drawnAt: _d, ...rest } = op;
    return rest;
  }
  if (op.t === "token.moveMany") return { ...op, moves: op.moves.map(({ drawnAt: _d, ...m }) => m) };
  if (op.t === "token.update" && op.patch.drawnAt !== undefined) {
    const { drawnAt: _d, ...patch } = op.patch;
    return Object.keys(patch).length === 0 ? null : { ...op, patch };
  }
  return op;
}

type Run = { state: RoomState; inverse: RestoreEntry[] | null };
type Served = { ok: boolean; landed?: Op; state: RoomState; inverse: RestoreEntry[] | null; trapped: boolean };

/** An op as the server takes it: a player's checked first and landed by the touch rule where it lands. */
function serve(state: RoomState, op: Op, who: Viewer, seq: number): Served {
  let sent = op;
  let landed: Op | undefined;
  if (who.role === "player") {
    const d = canApply(op, who, state, deps);
    if (!d.ok) {
      const touch = touchLanding(op, who, state, deps);
      if (!touch) return { ok: false, state, inverse: null, trapped: false };
      sent = landed = touch.op;
    }
  }
  const r = applyOp(state, opSchema.parse(sent), who, env(seq));
  if (!r.ok) return { ok: false, state, inverse: null, trapped: false };
  return { ok: true, ...(landed ? { landed } : {}), state: r.state, inverse: r.inverse, trapped: r.trapped === true };
}

/** A room or a copy of one with every token's rev and nudge left out. */
function blind<T extends { tokens: Record<string, object> }>(value: T): T {
  const tokens = Object.fromEntries(
    Object.entries(value.tokens).map(([id, t]) => {
      const { rev: _rev, nudge: _nudge, ...rest } = t as { rev?: number; nudge?: unknown };
      return [id, rest];
    }),
  );
  return { ...value, tokens };
}

/** Whether two rooms, or two copies, are equal but for tokens' revs and nudges, and if not, which part differs. */
function differs(a: { tokens: Record<string, object> }, b: { tokens: Record<string, object> }): string | null {
  const x = blind(a) as unknown as Record<string, unknown>;
  const y = blind(b) as unknown as Record<string, unknown>;
  if (isDeepStrictEqual(x, y)) return null;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (key === "tokens") {
      for (const id of new Set([...Object.keys(x.tokens as object), ...Object.keys(y.tokens as object)])) {
        const s = stableStringify((x.tokens as Record<string, unknown>)[id]);
        const t = stableStringify((y.tokens as Record<string, unknown>)[id]);
        if (s !== t) return `tokens.${id}: ${s} against ${t}`;
      }
    } else if (!isDeepStrictEqual(x[key], y[key])) return key;
  }
  return "?";
}

/** An op with its `drawnAt` left out, for comparing two runs' landings. */
function bareOp(op: Op | undefined): string {
  return op ? stableStringify(stripped(op)) : "none";
}

describe("the rules are blind to where a token is drawn (section 10)", () => {
  // Whole-cell sight, so the run stays fast and a walk in the dark meets walls the party has not seen.
  const real = { ...visionRules };
  before(() => Object.assign(visionRules, cellVision));
  after(() => Object.assign(visionRules, real));

  test("N1 to N5 over random runs played with and without drawnAt", () => {
    let kept = 0;
    let placedInPlace = 0;
    let landedFree = 0;
    let hexed = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 4241 + 17);
      const first = start(r);
      const free: Run = { state: first, inverse: null };
      const plain: Run = { state: first, inverse: null };
      let last: { both: boolean } | null = null;
      for (let stepNo = 0; stepNo < 24; stepNo++) {
        const seq = stepNo + 2;
        const at = `seed ${seed} step ${stepNo}`;
        const { op, who } = randomOp(r, free.state, last);
        if (op.t === ("undo" as string)) {
          const a = serve(free.state, { t: "sys.restore", entries: free.inverse!, from: "undo", deps: true }, DM, seq);
          const b = serve(plain.state, { t: "sys.restore", entries: plain.inverse!, from: "undo", deps: true }, DM, seq);
          assert.equal(a.ok, b.ok, `${at}: N1 undo`);
          free.state = a.state;
          plain.state = b.state;
          last = null;
        } else {
          const bare = stripped(op);
          const a = serve(free.state, op, who, seq);
          if (bare === null) {
            // A placement in place alone: the stripped run has no op, so only the placement may differ.
            if (a.ok) placedInPlace++;
            free.state = a.state;
            last = a.ok ? { both: false } : last;
          } else {
            const b = serve(plain.state, bare, who, seq);
            assert.equal(a.ok, b.ok, `${at}: N1 ${JSON.stringify(op)} by ${who.memberId}`);
            assert.equal(bareOp(a.landed), bareOp(b.landed), `${at}: N1 landing`);
            if (a.landed && "drawnAt" in a.landed) landedFree++;
            if (a.ok && op.t === "scene.update" && op.patch.gridShape === "hexRows" && Object.values(free.state.tokens).some((t) => t.sceneId === op.sceneId && t.rev > 0)) hexed++;
            assert.equal(a.trapped, b.trapped, `${at}: N1 trap mark`);
            free.state = a.state;
            plain.state = b.state;
            if (a.ok) {
              free.inverse = a.inverse;
              plain.inverse = b.inverse;
              last = a.inverse && b.inverse ? { both: true } : null;
            }
          }
        }
        assert.equal(differs(free.state, plain.state), null, `${at}: N2 after ${JSON.stringify(op)}`);
        for (const viewer of [DM, P1, P2, DISPLAY]) {
          assert.equal(differs(projectState(free.state, viewer, { sceneId: "s1" }), projectState(plain.state, viewer, { sceneId: "s1" })), null, `${at}: N3 ${viewer.memberId}`);
        }
        for (const t of Object.values(free.state.tokens)) {
          const g = gridOfToken(free.state, t);
          assert.ok(nudgeValid(g, t), `${at}: N4 ${t.id} at ${t.x}, ${t.y} with ${JSON.stringify(t.nudge)}`);
          if (!t.nudge) continue;
          kept++;
          const box = footprintRect(g, t);
          const drawn = footprintRect(g, { ...t, x: t.x + t.nudge.x / 8, y: t.y + t.nudge.y / 8 });
          assert.deepEqual([drawn.x, drawn.y], [box.x, box.y], `${at}: N5 ${t.id}`);
        }
        assert.equal(Object.values(plain.state.tokens).some((t) => t.nudge), false, `${at}: the stripped run never places`);
      }
    }
    if (process.env.NUDGE_DEBUG) console.log({ kept, placedInPlace, landedFree, hexed });
    assert.ok(kept > 200, `runs kept placements (${kept})`);
    assert.ok(landedFree > 5, `the touch rule landed free drops (${landedFree})`);
    assert.ok(hexed > 5, `scenes went to hexes under placements (${hexed})`);
    assert.ok(placedInPlace > 50, `runs placed in place (${placedInPlace})`);
  });
});
