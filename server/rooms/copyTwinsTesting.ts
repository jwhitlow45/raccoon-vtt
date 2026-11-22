import { FAR_TREATMENT, opKind } from "#shared/farLine.ts";
import { admitLimits, FAR, farReading, LIMITS, ROOM_FULL, roundUp, SCENE_FULL, type CopiedKind, type LimitSender } from "#shared/limits.ts";
import { readEntity, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState, seatView, stableStringify } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { drawing, effect, entry, env, randomState, rng, scene, template, token } from "#shared/testutil.ts";
import { exactOver, growthBound, linesHeld, playerReadings, readingAt, samePlace, sameScope, SizeGuard, touchedScenes, type ExactCopy, type ExactPlace, type FarParts, type FarScope } from "./sizeGuard.ts";

/*
 * Twins of a random room apart only in what P1's copy leaves out
 * (D-261120-003), for the tests of a player's exact part
 * (sizeGuard.copy.test.ts) and of their far answers
 * (sizeGuard.reading.test.ts, sizeGuard.reading.random.test.ts).
 */

export const copyOf = (state: RoomState, memberId: string) => stableStringify(projectState(state, { memberId, role: "player" }, { sceneId: null }));

export const players = (state: RoomState) => Object.keys(state.members).filter((id) => state.members[id]!.kind === "player");

/** A creature P1's copy holds that no player owns, and one hidden from players, in a random room. */
export const seenCreature = (s: RoomState) => Object.values(s.tokens).find((t) => t.ownerIds.length === 0 && t.visibility === "all" && copyOf(s, "p1").includes(`"id":"${t.id}"`));
export const hiddenCreatures = (s: RoomState) => Object.values(s.tokens).filter((t) => t.visibility === "dm" && t.ownerIds.length === 0);
export const walk = (seen: boolean[]) => ({ turn: 3, stops: seen.map((on, i) => ({ x: i, y: 1, elevation: 0, ...(on ? { seen: true as const } : {}) })) });

/**
 * Ways a twin of a room differs only in what P1's copy leaves out, each
 * returning false where the room has nothing to change. A twin whose copy
 * comes out otherwise is not compared.
 */
export const OMITTED: Record<string, (s: RoomState) => boolean> = {
  "a walk P1 saw none of, on a creature they see": (s) => {
    const t = seenCreature(s);
    if (t) s.tokens[t.id] = { ...t, path: walk([false, false]) };
    return t !== undefined;
  },
  "a walk P1 saw some of, on a creature they see": (s) => {
    const t = seenCreature(s);
    if (t) s.tokens[t.id] = { ...t, path: walk([true, false, true]) };
    return t !== undefined;
  },
  "a hidden creature's place, name and notes": (s) => {
    const t = hiddenCreatures(s)[0];
    if (t) s.tokens[t.id] = { ...t, x: t.x + 3, name: `${t.name} the Hidden`, notes: "n".repeat(300) };
    return t !== undefined;
  },
  "the DM's notes on a creature P1 sees": (s) => {
    const t = seenCreature(s);
    if (t && "inline" in t.actor) s.tokens[t.id] = { ...t, actor: { inline: { ...t.actor.inline, dmNotes: "d".repeat(500) } } };
    return t !== undefined && "inline" in t.actor;
  },
  "the creature a held area of P1's follows": (s) => {
    const [, other] = hiddenCreatures(s);
    if (other && s.templates.pa) s.templates.pa = { ...s.templates.pa, attachedTo: other.id };
    return other !== undefined && s.templates.pa !== undefined;
  },
  "the floor of a held area of P1's": (s) => {
    const floor = Object.keys(s.scenes).find((id) => id !== s.templates.pa?.sceneId);
    if (floor && s.templates.pa) s.templates.pa = { ...s.templates.pa, sceneId: floor };
    return floor !== undefined && s.templates.pa !== undefined;
  },
  "the conditions an HP change on a creature P1 saw put on": (s) => {
    const line = s.log.find((l) => l.id === "hp-seen");
    const data = line?.data as { revert?: { added?: unknown[] } } | undefined;
    if (line && data?.revert) s.log = s.log.map((l) => (l === line ? { ...l, data: { ...l.data, revert: { ...data.revert, added: [...(data.revert!.added ?? []), effect("e-more", { key: "prone" })] } } } as never : l));
    return data?.revert !== undefined;
  },
  "which hidden row's turn is under way, on creatures P1 sees": (s) => {
    const rows = s.encounter?.entries.filter((e) => e.id.startsWith("hidden-turn")) ?? [];
    const next = rows.find((e) => e.id !== s.encounter!.activeEntryId);
    if (next) s.encounter = { ...s.encounter!, activeEntryId: next.id, turnStart: { ...s.encounter!.turnStart!, entryId: next.id, tokenId: next.tokenId! } };
    return next !== undefined;
  },
  "P1's things behind a blackout": (s) => {
    s.meta = { ...s.meta, view: { ...s.meta.view, blackout: true } };
    for (const [id, t] of Object.entries(s.templates)) if (t.ownerId === "p1") s.templates[id] = { ...t, label: "Moved in the dark", origin: { ...t.origin, x: t.origin.x + 2 } };
    return true;
  },
};

/** The room with P1's area and ruler on a hidden creature, a fight on a creature P1 sees, and Players move any token in half. */
export function twinBase(seed: number): RoomState {
  const r = rng(seed * 31 + 7);
  const state = randomState(r);
  const hidden = hiddenCreatures(state)[0];
  if (hidden) {
    state.templates.pa = template("pa", { sceneId: hidden.sceneId, ownerId: "p1", attachedTo: hidden.id, label: "Bless" });
    state.drawings.pr = drawing("pr", { sceneId: hidden.sceneId, kind: "ruler", ownerId: "p1", anchors: [null, hidden.id], points: [1.5, 1.5, hidden.x + 0.5, hidden.y + 0.5] });
  }
  if (seed % 2 === 0) state.meta = { ...state.meta, settings: { ...state.meta.settings, playersMoveAny: "all" } };
  // A fight whose turn is a hidden row's, kept hidden on its turn, on one of two creatures P1 sees with walks P1's copy
  // leaves out.
  const scene = state.meta.playerSceneId ?? Object.keys(state.scenes)[0]!;
  state.tokens["turn-a"] = token("turn-a", { sceneId: scene, x: 1, y: 1, path: walk([true, true]) });
  state.tokens["turn-b"] = token("turn-b", { sceneId: scene, x: 2, y: 1, path: walk([true, true]) });
  state.meta = { ...state.meta, settings: { ...state.meta.settings, revealHiddenOnTurn: false } };
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "hidden-turn-a",
    entries: [entry("hidden-turn-a", { tokenId: "turn-a", hidden: true }), entry("hidden-turn-b", { tokenId: "turn-b", hidden: true })],
    turnStart: { entryId: "hidden-turn-a", tokenId: "turn-a", sceneId: scene, x: 1, y: 1, elevation: 0, seq: 3 },
  };
  // An HP change every player saw on a creature P1 sees, which put a condition on it.
  const seen = seenCreature(state);
  if (seen) {
    const vitals = { hp: { cur: 5, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } };
    const revert = { before: vitals, after: vitals, added: [effect("e-hit", { key: "poisoned" })] };
    state.log = [...state.log, { id: "hp-seen", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "hp", change: "damage", amount: 3, label: "Bloodied", left: vitals.hp, revert, tokenId: seen.id, seen: true } } as never];
  }
  return state;
}

/**
 * What `memberId` holds of a room: their copy, and the shared lines as they
 * read them when written (linesHeld), which their exact part counts so.
 * Twins alike in both must give equal exact parts.
 */
export const knownBy = (state: RoomState, memberId: string) => {
  const view = seatView(state, memberId);
  return `${copyOf(state, memberId)}\n${stableStringify([...linesHeld(state, memberId, view)].map(([line, held]) => [line.id, held]))}`;
};

/**
 * A player's or the DM's answer to an op as the actor gives it with the
 * near lines out of the way, the room after it, and for a player's op a
 * byte line refused, the scope whose line it was: "room" or the scene by
 * its main floor.
 */
export type FarAnswer = { said: string; next: RoomState | null; scope?: FarScope };

const MIB = 1024 * 1024;

/**
 * `who`'s answer to `op` on `before`: the far counts (shared/limits.ts
 * admitLimits) on the room and each scene the op wrote into, then the far
 * bytes (SizeGuard), as the actor reads them (actor.ts #reduce and
 * #bytesMeet), with the near lines out of the way. A deletion and the
 * server's own ops meet no line. The DM's op is answered as the DM's line
 * reads it.
 */
export function farAnswer(before: RoomState, op: Op, who: Viewer, at: number): FarAnswer {
  const result = applyOp(before, op, who, env(at));
  if (!result.ok) return { said: `${result.code}: ${result.message}`, next: null };
  const measured = result.withoutTraps ? result.withoutTraps() : result;
  if (!measured.ok) return { said: `${measured.code}: ${measured.message}`, next: null };
  const kind = opKind(op);
  if (kind.far === "deletion" || FAR_TREATMENT[op.t] === "server") return { said: "taken", next: result.state };
  const sender: LimitSender = who.role === "player" ? { role: "player", memberId: who.memberId, viewOf: (state) => seatView(state, who.memberId) } : { role: "dm" };
  const scenes = touchedScenes(before, measured.state, measured.touched);
  for (const sceneId of [null, ...scenes]) {
    const counts = admitLimits(measured.state, sceneId, before, sender, kind);
    if (!counts.ok) return { said: `${counts.code}: ${counts.message}`, next: null };
  }
  const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
  const far = who.role === "player" ? "widest" : kind.far === "exempt" ? "today" : "dmAdd";
  const check = guard.check(measured.state, scenes, growthBound(before, measured.state, measured.touched), before, who.role, far, kind.far === "exempt", who.role === "player" ? who.memberId : undefined);
  if (check.ok) return { said: "taken", next: result.state };
  const refusedScene = guard.refusedScene;
  const scope: FarScope | undefined = check.message === ROOM_FULL ? { kind: "room" } : check.message === SCENE_FULL && refusedScene !== null ? { kind: "scene", main: refusedScene } : undefined;
  return { said: `${check.code}: ${check.message}`, next: null, ...(scope !== undefined ? { scope } : {}) };
}

/** A thing in an exact part by its key as the state stores it: a row of the fight, a line of the log, or an entity. */
const storedAt = (state: RoomState, key: string): unknown => {
  if (key.startsWith("row:")) return state.encounter?.entries.find((e) => e.id === key.slice("row:".length));
  if (key.startsWith("log:")) return state.log.find((line) => line.id === key.slice("log:".length));
  return readEntity(state, key as EntityKey);
};

/** P1's copy of a thing in their exact part, by its key: a shared line as they read it when written. */
const copyAt = (state: RoomState, key: string, memberId: string): string => {
  const view = seatView(state, memberId);
  const at = key.indexOf(":");
  const [kind, id] = [key.slice(0, at), key.slice(at + 1)];
  return stableStringify(kind === "log" ? view.written(id) : view.copy(kind as CopiedKind, id));
};

/** A place of an exact part in words, apart by kind as the places are: the room, the blocks or a floor by its id. */
export const placeName = (place: ExactPlace): string => (place.kind === "floor" ? `floor ${place.id}` : `the ${place.kind}`);

/** The keys whose part differs between two exact parts, or that one holds and the other does not. */
const partsApart = (x: ReadonlyMap<EntityKey, ExactCopy>, y: ReadonlyMap<EntityKey, ExactCopy>): EntityKey[] =>
  [...new Set([...x.keys(), ...y.keys()])].filter((key) => {
    const [p, q] = [x.get(key), y.get(key)];
    return !p || !q || !samePlace(p.on, q.on) || p.shownOn?.kind !== q.shownOn?.kind || p.shown !== q.shown || p.sub !== q.sub;
  });

/**
 * Why twins' answers to one op of P1's may differ, or null where nothing
 * recorded explains it (D-261121-073), each established from the twins
 * themselves. "own copy" (residual 2): their exact parts after the op
 * differ, and every thing they differ in is one the op made or wrote in a
 * twin whose copy P1 holds differently in the two. "step" (residual 1):
 * in the scope whose byte line refused, the first of `refused` (each
 * twin's) in the order the far check reads them, the twins' stepped parts
 * round to different steps before or after the op, hidden bytes having
 * carried one across a step. Exact parts apart before the op explain
 * nothing: P1's copies were alike then.
 */
export function readingsApart(a: [RoomState, RoomState], b: [RoomState, RoomState], refused: ReadonlyArray<FarScope | undefined>, memberId = "p1"): "own copy" | "step" | null {
  const [ea, eb] = [exactOver(a[0], a[1], memberId), exactOver(b[0], b[1], memberId)];
  if (partsApart(ea.before, eb.before).length > 0) return null;
  const apart = partsApart(ea.after, eb.after);
  const wrote = ([before, after]: [RoomState, RoomState], key: string) => stableStringify(storedAt(before, key)) !== stableStringify(storedAt(after, key));
  if (apart.length > 0) return apart.every((key) => (wrote(a, key) || wrote(b, key)) && copyAt(a[1], key, memberId) !== copyAt(b[1], key, memberId)) ? "own copy" : null;
  const [ra, rb] = [playerReadings(a[0], a[1], memberId), playerReadings(b[0], b[1], memberId)];
  const place = (scope: FarScope) => ra.findIndex((reading) => sameScope(reading.scope, scope));
  const scope = refused.filter((at): at is FarScope => at !== undefined && place(at) >= 0).sort((x, y) => place(x) - place(y))[0];
  if (scope === undefined) return null;
  const rounded = (parts: FarParts | undefined) => (parts ? roundUp(Math.max(0, parts.stepped), FAR.byteStep) : null);
  const [x, y] = [readingAt(ra, scope), readingAt(rb, scope)];
  return rounded(x?.before) !== rounded(y?.before) || rounded(x?.after) !== rounded(y?.after) ? "step" : null;
}

/** Where twins are parked: past the room's line, P1's scene's, or the room's at the widest on per-player sight alone. */
export type Past = "room" | "scene" | "sight";

/**
 * Both twins padded alike, so P1's reading of the room or of `sceneId`'s
 * scene lands past its line by at most a step where `offset` is positive,
 * or at most `-offset` under it and within a step of that otherwise, the
 * larger of the twins' stepped parts just under a step's edge, so twins
 * less than a step apart in hidden bytes read alike: by the DM's hidden
 * notes on scenes of their own (a room's) or on the scene, and for "sight"
 * by empty per-player scenes first, whose reserves the room's reading at
 * the widest counts.
 */
export function parked(twins: RoomState[], past: Past, sceneId: string, offset: number): void {
  const [first] = twins;
  const scope: FarScope = past === "scene" ? { kind: "scene", main: first!.scenes[sceneId]!.floor?.of ?? sceneId } : { kind: "room" };
  const line = past === "scene" ? FAR.sceneBytes : FAR.roomBytes;
  const reading = () => {
    const at = twins.map((twin) => readingAt(playerReadings(twin, twin, "p1"), scope)!.after);
    const stepped = Math.max(...at.map((parts) => parts.stepped));
    return { reading: farReading(stepped, at[0]!.exact), stepped, exact: at[0]!.exact };
  };
  if (past === "sight") {
    for (let i = 0; reading().reading < line - 1.2 * MIB; i++) {
      for (const twin of twins) twin.scenes = { ...twin.scenes, [`sight-${i}`]: scene(`sight-${i}`, { order: 70 + i, bounds: { w: LIMITS.sceneCells, h: LIMITS.sceneCells }, fogEnabled: true, vision: { on: true, light: "bright", perPlayer: true } }) };
    }
  }
  const pad = (bytes: number, round: number) => {
    let left = bytes;
    for (let i = 0; left > 0; i++) {
      const notes = Math.min(left, past === "scene" ? left : 3 * MIB);
      // Each collection replaced, never changed, as an op leaves it: the measures keep sizes per collection object.
      for (const twin of twins) {
        const on = past === "scene" ? sceneId : `pad-${round}-${i}`;
        if (past !== "scene" && !twin.scenes[on]) twin.scenes = { ...twin.scenes, [on]: scene(on, { order: 50 + round * 10 + i }) };
        twin.tokens = { ...twin.tokens, [`pad-${round}-${i}`]: token(`pad-${round}-${i}`, { sceneId: on, visibility: "dm", notes: "n".repeat(Math.max(0, notes - 400)) }) };
      }
      left -= notes;
    }
  };
  // Coarse, then to 2 KiB under a step's edge: the reading is that edge and the exact part.
  pad(Math.max(0, line + Math.min(0, offset) - reading().reading - 2 * FAR.byteStep), 0);
  const now = reading();
  const steps = offset > 0 ? Math.floor((line - now.exact) / FAR.byteStep) + 1 : Math.floor((line + offset - now.exact) / FAR.byteStep);
  pad(Math.max(0, steps * FAR.byteStep - 2048 - now.stepped), 1);
}
