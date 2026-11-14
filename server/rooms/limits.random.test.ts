import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { seatCounts, type SeatCounts } from "#shared/limits.ts";
import type { InitEntry, RoomState, Token } from "#shared/model.ts";
import { projectState, seatView, type ProjectedState } from "#shared/project.ts";
import { opSchema, type Op } from "#shared/protocol.ts";
import { AYLA, BREE, idAt, limitsRoom, OGRE, STAIRS_DOWN, STAIRS_UP, withUpper } from "#shared/privTestutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, AT, character, chance, DM, entry, int, P1, P2, pick, rng, token } from "#shared/testutil.ts";

/**
 * Random runs of the player limits: DM, P1 and P2 ops drawn from one
 * seed on the limits room with an Upper floor, P1's second character
 * Cade, and P1's seats nearly full from the start.
 *
 * - I2: after every op, each of P1's seat counts in every scope equals the
 *   count over P1's own copy of the room (shared/project.ts projectState),
 *   so what a seat reads is what P1's device holds.
 */

const RUNS = Number(process.env.LIMITS_RANDOM_RUNS ?? 40);
const STEPS = Number(process.env.LIMITS_RANDOM_STEPS ?? 120);
const T0 = Date.parse(AT);
const CADE = "cade";
const SCENES = ["s1", "up"] as const;

/** The run's room: the limits room with an Upper floor, Cade, a companion of Bree's, and P1's areas and lines already near their seats. */
function start(r: () => number): RoomState {
  const s = withUpper(limitsRoom());
  s.characters[CADE] = character(CADE, { name: "Cade", ownerIds: ["p1"] });
  s.tokens[CADE] = token(CADE, { kind: "pc", name: "Cade", disposition: "ally", x: 5, y: 3, actor: { ref: CADE } });
  s.tokens.owl = token("owl", { kind: "npc", name: "Owl", disposition: "ally", x: 4, y: 7, companion: { of: BREE, turn: "shared" }, actor: { inline: actor({ dmNotes: "" }) } });
  s.tokens.shade = token("shade", { name: "Shade", visibility: "dm", x: 6, y: 5 });
  for (let i = 0; i < int(r, 0, 19); i++) {
    const id = `0199f0a0-0000-7000-8000-0000000a${String(i).padStart(4, "0")}`;
    s.templates[id] = { id, rev: 0, sceneId: "s1", shape: "sphere", size: 5, origin: { x: 3.5, y: 3.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "p1", visibility: "all", ...(chance(r, 0.5) ? { attachedTo: pick(r, [AYLA, OGRE, BREE, "owl"]) } : {}) };
  }
  if (chance(r, 0.5)) s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-ayla", { tokenId: AYLA }), entry("e-shade", { tokenId: "shade", hidden: true }), entry("e-bree", { tokenId: BREE })] };
  return s;
}

type Who = "dm" | "p1" | "p2";
const VIEWERS = { dm: DM, p1: P1, p2: P2 } as const;

/** Every token P1 or P2 might name, seen or not. */
function names(state: RoomState): string[] {
  return Object.keys(state.tokens).sort();
}

function cellIn(r: () => number, room: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: int(r, room.x, room.x + room.w - 1), y: int(r, room.y, room.y + room.h - 1) };
}

const R = { x: 2, y: 2, w: 10, h: 8 };
const F = { x: 24, y: 2, w: 10, h: 8 };

/** One drawn op for a member, on the state as it stands. */
function draw(r: () => number, state: RoomState, who: Who, mint: () => string): Op {
  const own = (memberId: string) => Object.values(state.templates).filter((t) => t.ownerId === memberId).map((t) => t.id).sort();
  const on = (id: string) => state.tokens[id]?.sceneId ?? "s1";
  if (who === "dm") {
    const kind = int(r, 0, 9);
    if (kind === 0) return { t: "token.update", tokenId: pick(r, [OGRE, BREE, "owl", "shade"]), patch: { visibility: chance(r, 0.5) ? "dm" : "all" } } as Op;
    if (kind === 1) return { t: "token.move", tokenId: pick(r, [OGRE, BREE, "owl", "shade"]), ...cellIn(r, chance(r, 0.5) ? R : F) } as Op;
    if (kind === 2) return { t: "character.update", characterId: CADE, patch: { ownerIds: chance(r, 0.5) ? ["p2"] : ["p1"] } } as Op;
    if (kind === 3) return { t: "room.setPlayerScene", sceneId: chance(r, 0.8) ? "s1" : "s2" };
    if (kind === 4) return { t: "view.blackout", blackout: chance(r, 0.4) } as Op;
    if (kind === 5) {
      const id = pick(r, names(state));
      return state.tokens[id] && id !== AYLA && id !== CADE ? { t: "token.delete", tokenId: id } : { t: "log.chat", text: "nothing" };
    }
    if (kind === 6) return { t: "token.create", token: { id: mint(), sceneId: "s1", kind: "monster", name: "Wolf", size: "medium", ...cellIn(r, R), visibility: chance(r, 0.5) ? "dm" : "all", actor: { inline: actor() } } } as Op;
    if (kind === 7) {
      const id = pick(r, [AYLA, CADE, BREE, OGRE]);
      return { t: "token.update", tokenId: id, patch: { x: 3, y: 3 } } as Op;
    }
    if (kind === 8 && state.encounter) {
      const row = pick(r, state.encounter.entries);
      return { t: "encounter.update", entryId: row.id, patch: { hidden: chance(r, 0.5) } } as Op;
    }
    const mover = pick(r, [BREE, OGRE]);
    return { t: "token.climb", tokenId: mover, linkId: on(mover) === "up" ? STAIRS_DOWN : STAIRS_UP } as Op;
  }
  const member = who;
  const mine = who === "p1" ? [AYLA, CADE] : [BREE];
  const self = pick(r, mine);
  const scene = on(self);
  const kind = int(r, 0, 9);
  if (kind <= 1) {
    const rides = chance(r, 0.6) ? pick(r, names(state)) : undefined;
    return {
      t: "template.create",
      template: { id: mint(), sceneId: rides ? on(rides) : scene, shape: "sphere", size: 5, origin: { x: 4.5, y: 4.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: member, visibility: "all", ...(rides ? { attachedTo: rides } : {}) },
    } as Op;
  }
  if (kind === 2) {
    const area = own(member);
    if (area.length === 0) return { t: "log.chat", text: "no area" };
    return { t: "template.update", templateId: pick(r, area), patch: { attachedTo: chance(r, 0.5) ? pick(r, names(state)) : null } } as Op;
  }
  if (kind === 3) {
    const anchored = chance(r, 0.5) ? pick(r, names(state)) : null;
    return {
      t: "drawing.create",
      drawing: { id: mint(), sceneId: scene, kind: anchored ? "ruler" : "line", points: [3.5, 3.5, 6.5, 4.5], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: member, visibility: "all", ...(anchored ? { anchors: [self, anchored] } : {}) },
    } as Op;
  }
  if (kind === 4) return { t: "drawing.clear", sceneId: scene, scope: "own" };
  if (kind === 5) return { t: "token.move", tokenId: self, ...cellIn(r, chance(r, 0.8) ? R : F) } as Op;
  if (kind === 6) return { t: "token.climb", tokenId: self, linkId: scene === "up" ? STAIRS_DOWN : STAIRS_UP } as Op;
  if (kind === 7) {
    const area = own(member);
    return area.length === 0 ? { t: "log.chat", text: "no area" } : { t: "template.delete", templateId: pick(r, area) };
  }
  if (kind === 8 && state.encounter) return { t: "encounter.add", entries: [{ id: mint(), tokenId: self }] } as Op;
  const near = state.tokens[self];
  return {
    t: "token.create",
    token: { id: mint(), sceneId: scene, kind: "npc", name: "Wolf", size: "medium", layer: "token", x: (near?.x ?? 4) + 1, y: near?.y ?? 3, actor: { inline: actor({ dmNotes: "" }) }, companion: { of: who === "p1" ? (self === CADE ? CADE : AYLA) : BREE, turn: "shared" } },
  } as Op;
}

/** Whether a row in P1's copy is P1's own: of a creature or character P1's copy says P1 plays. */
function ownRow(copy: ProjectedState, memberId: string, row: Pick<InitEntry, "tokenId" | "characterId">): boolean {
  const plays = (characterId: string | undefined) => characterId !== undefined && (copy.characters[characterId]?.ownerIds?.includes(memberId) ?? false);
  if (plays(row.characterId)) return true;
  if (row.tokenId === undefined) return false;
  const t = copy.tokens[row.tokenId] as Partial<Token> | undefined;
  if (!t) return false;
  const of = t.companion?.of ?? (t.actor && "ref" in t.actor ? t.actor.ref : undefined);
  return (t.ownerIds?.includes(memberId) ?? false) || plays(of);
}

/** P1's seat counts read straight off P1's copy, in the scopes seatCounts reads. */
function copyCounts(copy: ProjectedState, memberId: string, sceneId: string): SeatCounts {
  const group = new Set(SCENES.filter((id) => copy.scenes[id]));
  group.add(sceneId as "s1");
  const counts: SeatCounts = { tokens: 0, ridingAreas: 0, freeAreas: 0, drawings: 0, pointValues: 0, rows: 0 };
  for (const row of copy.encounter?.entries ?? []) if (ownRow(copy, memberId, row)) counts.rows++;
  for (const raw of Object.values(copy.tokens)) {
    const t = raw as Partial<Token>;
    if (!group.has(t.sceneId as "s1")) continue;
    const of = t.companion?.of ?? (t.actor && "ref" in t.actor ? t.actor.ref : undefined);
    if (of !== undefined && (copy.characters[of]?.ownerIds?.includes(memberId) ?? false)) counts.tokens++;
  }
  for (const a of Object.values(copy.templates)) {
    if (a.ownerId !== memberId) continue;
    if (a.attachedTo !== undefined) {
      if (group.has(a.sceneId as "s1")) counts.ridingAreas++;
    } else if (a.sceneId === sceneId) counts.freeAreas++;
  }
  for (const d of Object.values(copy.drawings)) {
    if (d.ownerId !== memberId || d.sceneId !== sceneId) continue;
    counts.drawings++;
    counts.pointValues += d.points.length;
  }
  return counts;
}

/** I2 on one state: P1's seat counts in each scope against the counts over P1's copy. */
function seatsAreTheCopys(state: RoomState, what: string): void {
  const copy = projectState(state, P1, { sceneId: null });
  const view = seatView(state, "p1");
  for (const sceneId of SCENES) {
    if (!copy.scenes[sceneId]) continue;
    assert.deepEqual(seatCounts(state, "p1", sceneId, view), copyCounts(copy, "p1", sceneId), `${what}: P1's seats on ${sceneId} are the counts over P1's copy`);
  }
}

describe("a player's seats read their own copy", () => {
  test("I2: after every op of random runs, each of P1's seat counts equals the count over P1's copy", () => {
    let applied = 0;
    for (let run = 0; run < RUNS; run++) {
      const r = rng(9_100 + run);
      const ids = rng(77 + run);
      let state = start(r);
      let seq = 1;
      seatsAreTheCopys(state, `run ${run} start`);
      for (let step = 0; step < STEPS; step++) {
        const who = pick(r, ["dm", "p1", "p1", "p2"] as const);
        const op = draw(r, state, who, () => idAt(ids, T0 + seq * 1_000));
        const parsed = opSchema.safeParse(op);
        if (!parsed.success) continue;
        const result = applyOp(state, parsed.data, VIEWERS[who], { seq: ++seq, at: new Date(T0 + seq * 1_000).toISOString() });
        if (!result.ok) continue;
        applied++;
        state = result.state;
        seatsAreTheCopys(state, `run ${run} step ${step} (${who} ${op.t})`);
      }
    }
    assert.ok(applied > RUNS * STEPS * 0.3, `most drawn ops applied: ${applied}`);
  });
});
