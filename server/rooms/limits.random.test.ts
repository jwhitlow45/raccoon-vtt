import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS, SEAT_FULL, seatCounts, type SeatCounts } from "#shared/limits.ts";
import type { InitEntry, RoomState, Token } from "#shared/model.ts";
import { projectState, seatView, type ProjectedState } from "#shared/project.ts";
import { mintedIds, opSchema, type Op } from "#shared/protocol.ts";
import { APART, AYLA, BREE, dmAreas, dmDrawings, dmTokens, idAt, limitsRoom, OGRE, STAIRS_DOWN, STAIRS_UP, withUpper } from "#shared/privTestutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, AT, character, chance, DM, entry, int, P1, P2, pick, rng, token } from "#shared/testutil.ts";
import { answer, Mint, openTwins, same, together, type Answer } from "./limitsTwinTesting.ts";
import { each, viewOf, type Who as Member } from "./numberingTesting.ts";

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
  s.tokens.guide = token("guide", { kind: "npc", name: "Guide", disposition: "ally", x: 6, y: 8 });
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

/*
 * The twin runs: room A and room B start alike but for what only the DM
 * sees, and take the same shared events at the same clock times, P1's
 * and P2's ops drawn from their own copies, which the twins hold alike.
 * Between shared events each twin draws its own work on what only it
 * holds, and some shared events take a public thing out of P1's copy in
 * two ways, hidden in A and deleted in B. After every shared event:
 *
 * - I1: P1's answers and P1's and the display's frames are the same in
 *   both twins, after each twin's frames are scanned raw for its own ids
 *   and names.
 * - I3: after every close, no area or kept ruler of a player's stands on
 *   a creature its owner does not see while its owner holds its floor.
 * - I4: the DM's deletions and hides of what only one twin holds are
 *   never refused.
 * - I6: no player op is refused with a seat's words unless it can put a
 *   thing into a seat's class.
 * - I7: an id that left P1's copy is never taken again.
 */

const TWIN_RUNS = Number(process.env.LIMITS_TWIN_RUNS ?? 4);
const TWIN_STEPS = Number(process.env.LIMITS_TWIN_STEPS ?? 40);
const SEAT_WORDS = new Set(Object.values(SEAT_FULL));
const SEAT_KINDS = new Set(["token.create", "template.create", "template.update", "drawing.create", "encounter.add", "undo", "redo"]);
/** Creatures both players see and neither plays, which the DM may take out of every player's copy in two ways. */
const PUBLIC = [OGRE, "guide"];

/** One shared op of a player's, drawn from their own copy. */
function drawFromCopy(r: () => number, copy: ProjectedState, who: "p1" | "p2", mint: () => string, left: readonly string[]): Op {
  const tokens = Object.keys(copy.tokens).sort();
  const mine = who === "p1" ? [AYLA, CADE].filter((id) => copy.tokens[id]) : [BREE];
  const self = mine.length > 0 ? pick(r, mine) : AYLA;
  const at = copy.tokens[self] as Partial<Token> | undefined;
  const scene = at?.sceneId ?? "s1";
  const own = Object.values(copy.templates).filter((a) => a.ownerId === who).map((a) => a.id).sort();
  const reused = left.length > 0 && chance(r, 0.15) ? pick(r, left) : null;
  const id = () => reused ?? mint();
  const kind = int(r, 0, 9);
  if (kind <= 2) {
    const rides = tokens.length > 0 && chance(r, 0.6) ? pick(r, tokens) : undefined;
    const sceneOf = rides ? ((copy.tokens[rides] as Partial<Token>).sceneId ?? scene) : scene;
    return { t: "template.create", template: { id: id(), sceneId: sceneOf, shape: "sphere", size: 5, origin: { x: 4.5, y: 4.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: who, visibility: "all", ...(rides ? { attachedTo: rides } : {}) } } as Op;
  }
  if (kind === 3 && own.length > 0) return { t: "template.update", templateId: pick(r, own), patch: { attachedTo: tokens.length > 0 && chance(r, 0.5) ? pick(r, tokens) : null } } as Op;
  if (kind === 4) {
    const anchored = tokens.length > 0 && chance(r, 0.6) ? pick(r, tokens) : null;
    return { t: "drawing.create", drawing: { id: id(), sceneId: scene, kind: anchored ? "ruler" : "line", points: [3.5, 3.5, 6.5, 4.5], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: who, visibility: "all", ...(anchored ? { anchors: [self, anchored] } : {}) } } as Op;
  }
  if (kind === 5) return { t: "drawing.clear", sceneId: scene, scope: "own" };
  if (kind === 6) return { t: "token.move", tokenId: self, ...cellIn(r, chance(r, 0.8) ? R : F) } as Op;
  if (kind === 7) return { t: "token.climb", tokenId: self, linkId: scene === "up" ? STAIRS_DOWN : STAIRS_UP } as Op;
  if (kind === 8 && copy.encounter) return { t: "encounter.add", entries: [{ id: id(), tokenId: self }] } as Op;
  return {
    t: "token.create",
    token: { id: id(), sceneId: scene, kind: "npc", name: "Wolf", size: "medium", layer: "token", x: (at?.x ?? 4) + 1, y: at?.y ?? 3, actor: { inline: actor({ dmNotes: "" }) }, companion: { of: self === CADE ? CADE : who === "p1" ? AYLA : BREE, turn: "shared" } },
  } as Op;
}

/** I3 on one twin's state. */
function noUnseenRiders(state: RoomState, what: string): void {
  for (const memberId of ["p1", "p2"]) {
    const view = seatView(state, memberId);
    for (const a of Object.values(state.templates)) {
      if (a.ownerId !== memberId || a.attachedTo === undefined || a.visibility !== "all") continue;
      const on = state.tokens[a.attachedTo];
      if (on && on.sceneId !== a.sceneId) continue;
      if (view.holds(a.sceneId)) assert.ok(view.sees(a.attachedTo), `${what}: ${memberId}'s area ${a.id} stands on ${a.attachedTo}, which they do not see`);
    }
    for (const d of Object.values(state.drawings)) {
      if (d.ownerId !== memberId || !d.anchors || !view.holds(d.sceneId)) continue;
      for (const id of d.anchors) if (id !== null) assert.ok(view.sees(id), `${what}: ${memberId}'s ruler ${d.id} stands on ${id}, which they do not see`);
    }
  }
}

describe("random twin runs answer P1 alike", () => {
  test("I1, I3, I4, I6, I7: shared events with work apart between them give P1 the same answers and frames", async (t) => {
    for (let run = 0; run < TWIN_RUNS; run++) {
      await t.test(`run ${run}`, async (t) => {
        const r = rng(4_200 + run);
        const base = start(r);
        const a = structuredClone(base);
        const b = structuredClone(base);
        // What only the DM sees, apart per twin: creatures named and drawn apart.
        const apart = (s: RoomState, seed: number) => {
          const own = rng(seed);
          const ids: string[] = [];
          for (let i = int(own, 0, 4); i > 0; i--) {
            const id = `${APART}shade${seed}x${i}`;
            s.tokens[id] = token(id, { name: `${APART}name${seed}x${i}`, visibility: "dm", ...cellIn(own, chance(own, 0.5) ? R : F) });
            ids.push(id, `${APART}name${seed}x${i}`);
          }
          // One twin fills a room cap with the DM's things, so a player's op that read the cap would answer apart.
          const fill = int(own, 0, 3);
          if (fill === 1) ids.push(...dmAreas(s, LIMITS.templatesPerScene));
          if (fill === 2) ids.push(...dmDrawings(s, LIMITS.drawingsPerScene));
          if (fill === 3) ids.push(...dmTokens(s, LIMITS.tokensPerScene));
          return ids;
        };
        const pair = await openTwins(t, a, b, { a: apart(a, run * 2 + 1), b: apart(b, run * 2 + 2) });
        const shared = new Mint();
        const own = [rng(run * 2 + 11), rng(run * 2 + 12)];
        const left: string[] = [];
        for (let step = 0; step < TWIN_STEPS; step++) {
          // Each twin's own work first, then the clocks meet again.
          for (const [i, room] of pair.entries()) {
            const rr = own[i]!;
            for (let k = int(rr, 0, 2); k > 0; k--) {
              const hidden = pair.hidden[i]!;
              const hiddenIds = hidden.ids.filter((id) => room.state.tokens[id]);
              const op: Op =
                hiddenIds.length > 0 && chance(rr, 0.7)
                  ? chance(rr, 0.3)
                    ? { t: "token.delete", tokenId: pick(rr, hiddenIds) }
                    : ({ t: "token.update", tokenId: pick(rr, hiddenIds), patch: { name: `${APART}name${i}s${step}k${k}` } } as Op)
                  : ({ t: "token.create", token: { id: idAt(rr, room.clock.now), sceneId: "s1", kind: "monster", name: `${APART}new${i}s${step}k${k}`, size: "medium", ...cellIn(rr, F), visibility: "dm", actor: { inline: actor() } } } as Op);
              if (op.t === "token.create") hidden.ids.push(op.token.id, op.token.name);
              if (op.t === "token.update") hidden.names.push(op.patch.name!);
              assert.equal(await answer(room, "dm", op), "taken", `I4: run ${run} step ${step}: ${room.name}'s own ${op.t}`);
            }
          }
          const meet = Math.max(pair[0].clock.now, pair[1].clock.now);
          for (const room of pair) room.clock.now = meet;
          const roll = int(r, 0, 19);
          const what = `run ${run} step ${step}`;
          if (roll === 0) {
            await each(pair, (room) => room.restart(false));
          } else if (roll === 1) {
            await each(pair, (room) => room.reloadP1());
          } else if (roll <= 3) {
            // A public thing leaves P1's copy: hidden in A, deleted in B.
            const id = pick(r, PUBLIC);
            if (pair[0].state.tokens[id]?.visibility === "all" && pair[1].state.tokens[id]) {
              left.push(...Object.values(pair[0].state.templates).filter((x) => x.attachedTo === id && x.ownerId === "p1").map((x) => x.id));
              for (const room of pair) await together(room, [["dm", room.name === "A" ? ({ t: "token.update", tokenId: id, patch: { visibility: "dm" } } as Op) : { t: "token.delete", tokenId: id }]]);
            }
          } else {
            const sends: Array<[Member, Op]> = [];
            let fresh = 0;
            for (let k = int(r, 1, 3); k > 0; k--) {
              const who = pick(r, ["p1", "p1", "p2"] as const);
              const copy = viewOf(pair[0].clients[who].sent);
              sends.push([who, drawFromCopy(r, copy, who, () => (fresh++, shared.next(pair[0])), left)]);
            }
            // B's source draws as A's did, so the next ids are alike in both.
            for (let k = 0; k < fresh; k++) shared.next(pair[1]);
            const answers: Answer[][] = [];
            for (const room of pair) answers.push(await together(room, sends));
            assert.deepEqual(answers[0], answers[1], `I1: ${what}: the same answers in both twins to ${JSON.stringify(sends)}`);
            for (const [k, [who, op]] of sends.entries()) {
              const got = answers[0]![k]!;
              if (typeof got === "object" && SEAT_WORDS.has(got.message)) assert.ok(SEAT_KINDS.has(op.t), `I6: ${what}: ${who}'s ${op.t} refused with a seat's words`);
              if (who === "p1" && mintedIds(op).some((id) => left.includes(id))) assert.notEqual(got, "taken", `I7: ${what}: an id that left P1's copy is taken again`);
            }
          }
          same(pair, what);
          for (const room of pair) noUnseenRiders(room.state, `I3: ${what}: ${room.name}`);
        }
      });
    }
  });
});
