import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, readEntity } from "#shared/keys.ts";
import { FAR, HARD, LIMITS } from "#shared/limits.ts";
import type { Effect, RoomState, Viewer } from "#shared/model.ts";
import type { Op, RestoreEntry } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { turnUnderWay } from "#shared/rules/path.ts";
import { actor, character, DM, entry, env, P1, P2, rng, scene, token } from "#shared/testutil.ts";
import { copyOf, farAnswer, hiddenCreatures, knownBy, OMITTED, parked, readingsApart, seenCreature, twinBase, type Past } from "./copyTwinsTesting.ts";
import { shedOf, storedBytes } from "./sizeGuard.ts";

/*
 * The far rule as a state machine (design 1.6): twins apart only in what
 * P1's copy leaves out, parked past the room's line, P1's scene's or the
 * room's on sight alone, or within one op under it, then 200 random steps
 * of P1's, P2's, the DM's and the server's, each closed as a batch is.
 *
 * (I1) P1's answers are equal on every step, but where the twins' rounded
 * stepped parts stand apart or the op's result in P1's copy differs
 * (copyTwinsTesting.ts readingsApart), each recorded by name, which ends
 * that run. (I2) A room that never passed the stored bound never sheds,
 * and with the bound lowered under the room, each batch's shed (shedOf, as
 * the actor runs it) leaves it within the bound or with nothing left to
 * shed. (I3) A shed changes no player's copy. (I4) After every op at most
 * 1 + turnMounts creatures hold walks of the turn under way, each the
 * turn's creature or one of its mounts.
 */

const SEEDS = Number(process.env.READING_SEEDS ?? 12);
const STEPS = 200;
let seq = 50_000;

type Step = { op: Op; who: Viewer; what: string };

/** Hidden creatures every room here holds, which walked on turns gone by in one twin. */
const GHOSTS = 120;

const walkOf = (turn: number, stops: number) => ({ turn, stops: Array.from({ length: stops }, (_, i) => ({ x: 4 + (i % 5), y: 4 + Math.floor(i / 5), elevation: 0 })) });

/** Eight conditions on P1's hero that end with its turn, so its turn's end writes lines P1 reads. */
const ending = (): Effect[] => Array.from({ length: 8 }, (_, i) => ({ id: `end-${i}`, key: "custom", label: `Ward ${i}`, duration: { remaining: 1, boundary: "turnEnd", anchor: { tokenId: "p1-hero" } } }));

/**
 * Beside OMITTED, what a turn's end reads that P1's copy leaves out: walks
 * a room kept from before change format 65 on hidden creatures, more than
 * a step of them, and the walk of a hidden mount listed on the turn.
 */
const TURN_OMITTED: Record<string, (s: RoomState) => boolean> = {
  "hidden creatures' walks of turns gone by, more than a step of them": (s) => {
    for (let i = 0; i < GHOSTS; i++) s.tokens[`ghost-${i}`] = { ...s.tokens[`ghost-${i}`]!, path: walkOf(1 + (i % 4), 50) };
    return true;
  },
  "a hidden mount's walk on the turn under way": (s) => {
    const turn = s.encounter?.turnStart?.seq;
    if (s.tokens.mount && turn !== undefined && s.encounter?.turnStart?.mounts?.includes("mount")) s.tokens.mount = { ...s.tokens.mount, path: walkOf(turn, 50) };
    return s.tokens.mount?.path !== undefined;
  },
};

/** twinBase's room with P1's hero, a steed P1 may ride, a hidden mount and P1's row, on its turn two runs in three. */
function table(seed: number): RoomState {
  const state = twinBase(seed);
  const sceneId = state.meta.playerSceneId ?? Object.keys(state.scenes)[0]!;
  state.meta = { ...state.meta, settings: { ...state.meta.settings, playersApplyDamage: seed % 3 === 0 } };
  state.characters["p1-char"] = character("p1-char", { ownerIds: ["p1"], name: "Wren", actor: actor({ notes: "", effects: ending() }) });
  state.tokens["p1-hero"] = token("p1-hero", { sceneId, kind: "pc", name: "Wren", x: 4, y: 4, actor: { ref: "p1-char" } });
  state.tokens.steed = token("steed", { sceneId, kind: "npc", name: "Pony", size: "large", x: 6, y: 4, ownerIds: ["p1"] });
  state.tokens.mount = token("mount", { sceneId, name: "Shadow", x: 4, y: 4, visibility: "dm" });
  for (let i = 0; i < GHOSTS; i++) state.tokens[`ghost-${i}`] = token(`ghost-${i}`, { sceneId, name: "Ghost", x: 20 + (i % 10), y: 20 + Math.floor(i / 10), visibility: "dm" });
  const encounter = state.encounter!;
  const entries = [...encounter.entries, entry("p1-row", { tokenId: "p1-hero" })];
  state.encounter = seed % 3 === 2 ? { ...encounter, entries } : { ...encounter, entries, activeEntryId: "p1-row", turnStart: { entryId: "p1-row", tokenId: "p1-hero", sceneId, x: 4, y: 4, elevation: 0, seq: 5, mounts: ["mount"] } };
  return state;
}

/** Undo and Redo of P1's own things, as a step would restore them, guarded by the twin as it is. */
function restoreOf(state: RoomState, entries: readonly RestoreEntry[], from: "undo" | "redo"): Op {
  return { t: "sys.restore", entries: entries.map((e) => ({ key: e.key, value: e.value, expectHash: guardHash(e.key, readEntity(state, e.key)) })), from, deps: true } as Op;
}

/** The next step at random, from what twin A holds. */
function nextStep(r: () => number, state: RoomState, undo: { entries: RestoreEntry[] | null; from: "undo" | "redo" }): Step {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const sceneId = state.tokens["p1-hero"]?.sceneId ?? state.meta.playerSceneId!;
  const cell = () => 2 + Math.floor(r() * 12);
  const hero = state.tokens["p1-hero"];
  const own = Object.values(state.drawings).filter((d) => d.ownerId === "p1");
  const seen = seenCreature(state);
  const hidden = hiddenCreatures(state).filter((t) => !t.id.startsWith("pad-"));
  const encounter = state.encounter;
  const roll = r();
  if (roll < 0.3) {
    return pick<Step>([
      { what: "move", who: P1, op: { t: "token.move", tokenId: "p1-hero", x: cell(), y: cell() } },
      { what: "mount", who: P1, op: { t: "token.attach", tokenId: "p1-hero", to: "steed", kind: "ride", steer: true, x: state.tokens.steed?.x ?? 6, y: state.tokens.steed?.y ?? 4, elevation: 0 } as Op },
      { what: "dismount", who: P1, op: { t: "token.detach", tokenId: "p1-hero", x: (state.tokens.steed?.x ?? 6) - 1, y: state.tokens.steed?.y ?? 4 } as Op },
      { what: "steed move", who: P1, op: { t: "token.move", tokenId: "steed", x: cell(), y: cell() } },
      { what: "elevation", who: P1, op: { t: "token.update", tokenId: "p1-hero", patch: { elevation: pick([0, 5, 10]) } } as Op },
    ]);
  }
  if (roll < 0.5) {
    return pick<Step>([
      { what: "chat", who: P1, op: { t: "log.chat", text: "c".repeat(1 + Math.floor(r() * 300)) } },
      { what: "notes", who: P1, op: { t: "character.update", characterId: "p1-char", patch: { actor: { notes: "w".repeat(Math.floor(r() * 400)) } } } as Op },
      { what: "create", who: P1, op: { t: "drawing.create", drawing: { id: `p1-line-${++seq}`, sceneId, kind: "line", points: [1, 1, cell(), cell()], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op },
      { what: "ruler", who: P1, op: { t: "drawing.create", drawing: { id: `p1-ruler-${++seq}`, sceneId, kind: "ruler", points: [4.5, 4.5, cell() + 0.5, cell() + 0.5], anchors: ["p1-hero", null], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op },
      own.length > 0 ? { what: "delete", who: P1, op: { t: "drawing.delete", drawingId: pick(own).id } as Op } : { what: "chat", who: P1, op: { t: "log.chat", text: "nothing to delete" } },
      { what: "add row", who: P1, op: { t: "encounter.add", entries: [{ id: `p1-row-${++seq}`, characterId: "p1-char", value: Math.floor(r() * 20) }] } as Op },
      { what: "ask", who: P1, op: { t: "cast.ask", cast: { id: `ask-${++seq}`, caster: "p1-hero", sceneId, spell: "Fireball", slot: 3, targets: [seen?.id ?? "p1-hero"] } } as Op },
    ]);
  }
  if (roll < 0.6 || (encounter?.activeEntryId === "p1-row" && roll < 0.7)) {
    if (encounter?.activeEntryId === "p1-row" && r() < 0.6) return { what: "end turn", who: P1, op: { t: "encounter.next", from: { entry: "p1-row", round: encounter.round } } as Op };
    if (undo.entries && r() < 0.6) return { what: undo.from, who: P1, op: restoreOf(state, undo.entries, undo.from) };
    if (seen && state.meta.settings.playersMoveAny === "all") return { what: "P2 moves any", who: P2, op: { t: "token.move", tokenId: seen.id, x: cell(), y: cell() } };
    if (seen && state.meta.settings.playersApplyDamage) return { what: "damage", who: P1, op: { t: "actor.hp", target: { tokenId: seen.id }, change: { kind: "damage", amount: 1 + Math.floor(r() * 6) } } as Op };
    return { what: "move", who: P1, op: { t: "token.move", tokenId: "p1-hero", x: cell(), y: cell() } };
  }
  const hiddenOne = hidden.length > 0 ? pick(hidden) : undefined;
  return pick<Step>([
    { what: "DM next", who: DM, op: { t: "encounter.next" } },
    { what: "DM previous", who: DM, op: { t: "encounter.prev" } },
    encounter
      ? { what: "DM fight end", who: DM, op: { t: "encounter.end" } as Op }
      : { what: "DM fight start", who: DM, op: { t: "encounter.start", entries: [{ id: `row-${++seq}`, tokenId: "p1-hero", value: 15 }, ...(hiddenOne ? [{ id: `row-${++seq}`, tokenId: hiddenOne.id, value: 10, hidden: true }] : [])] } as Op },
    { what: "DM blackout", who: DM, op: { t: "view.blackout", blackout: !state.meta.view.blackout } as Op },
    hiddenOne ? { what: "DM show", who: DM, op: { t: "token.update", tokenId: hiddenOne.id, patch: { visibility: "all" } } as Op } : { what: "DM next", who: DM, op: { t: "encounter.next" } },
    seen ? { what: "DM hide", who: DM, op: { t: "token.update", tokenId: seen.id, patch: { visibility: "dm" } } as Op } : { what: "DM next", who: DM, op: { t: "encounter.next" } },
    hiddenOne ? { what: "DM lend", who: DM, op: { t: "token.update", tokenId: hiddenOne.id, patch: { ownerIds: ["p1"] } } as Op } : { what: "DM previous", who: DM, op: { t: "encounter.prev" } },
    { what: "DM fog", who: DM, op: { t: "scene.update", sceneId, patch: { fogEnabled: !state.scenes[sceneId]?.fogEnabled } } as Op },
    hiddenOne ? { what: "DM hidden delete", who: DM, op: { t: "token.delete", tokenId: hiddenOne.id } } : { what: "DM next", who: DM, op: { t: "encounter.next" } },
    { what: "DM hidden scene", who: DM, op: { t: "scene.create", scene: { id: `vault-${++seq}`, name: "Vault", bounds: { w: 20, h: 20 } } } as Op },
    { what: "DM mounts the hidden one", who: DM, op: { t: "token.attach", tokenId: "mount", to: "p1-hero", kind: "ride", steer: true, x: hero?.x ?? 4, y: hero?.y ?? 4, elevation: 0 } as Op },
    { what: "join", who: { memberId: "server", role: "dm" }, op: { t: "sys.memberJoin", member: { id: `p-${++seq}`, name: "Late", color: "#123456", kind: "player", createdAt: "2026-11-21T20:00:00.000Z" } } as Op },
  ]);
}

/** (I4) The turn's walks: on its creature and its mounts alone, at most 1 + turnMounts of them. */
function walksHeld(state: RoomState, where: string): void {
  const turn = turnUnderWay(state.encounter);
  if (!turn) return;
  const start = state.encounter!.turnStart!;
  const walkers = Object.values(state.tokens).filter((t) => t.path?.turn === turn.seq);
  assert.ok(walkers.length <= 1 + LIMITS.turnMounts, `${where}: ${walkers.length} walks of the turn`);
  for (const t of walkers) assert.ok(t.id === start.tokenId || start.mounts?.includes(t.id), `${where}: ${t.id} walks outside the turn`);
}

/** (I2, I3) The batch's close on one twin, at `bound`: the shed shedOf names, which must apply and leave every player's copy as it was. */
function closed(before: RoomState, state: RoomState, bound: number, where: string): { state: RoomState; shed: boolean } {
  const stored = storedBytes(state);
  // The lines committed before this batch are archived; the batch's own are not yet.
  const archived = new Set(before.log.map((e) => e.id));
  const shed = shedOf(state, stored, archived, before, bound);
  if (!shed) {
    if (bound === HARD.storedBytes) assert.ok(stored <= HARD.storedBytes, `${where}: stored ${stored} past HARD with nothing to shed`);
    return { state, shed: false };
  }
  const r = applyOp(state, { t: "sys.shed", ...shed } as Op, { memberId: "server", role: "dm" }, { seq: ++seq, at: "2026-11-21T20:00:00.000Z", uncounted: true });
  assert.ok(r.ok, `${where}: the shed applies: ${r.ok ? "" : r.message}`);
  for (const id of ["p1", "p2"]) assert.equal(copyOf(r.state, id), copyOf(state, id), `${where}: the shed leaves ${id}'s copy`);
  const after = storedBytes(r.state);
  assert.ok(after <= bound || shedOf(r.state, after, archived, before, bound) === null, `${where}: within the bound or nothing left`);
  return { state: r.state, shed: true };
}

describe("the far rule as a state machine (design 1.6, D-261121-060, 120, 121, 124)", () => {
  test(`twins over ${STEPS} random steps keep P1's answers equal, shed only what no player holds, and hold the turn's walks to its creatures`, (t) => {
    const failures: string[] = [];
    const recorded = new Map<string, number>();
    const said = new Map<string, number>();
    let steps = 0;
    let sheds = 0;
    const runs: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      // The first difference from the seed's own on that makes twins of this room.
      const differences = { ...OMITTED, ...TURN_OMITTED };
      const names = Object.keys(differences);
      let pair: { name: string; one: RoomState; other: RoomState } | null = null;
      for (let k = 0; k < names.length && !pair; k++) {
        const name = names[(seed + k) % names.length]!;
        const one = table(seed);
        if (name === "P1's things behind a blackout") one.meta = { ...one.meta, view: { ...one.meta.view, blackout: true } };
        const other = structuredClone(one);
        if (differences[name]!(other) && knownBy(one, "p1") === knownBy(other, "p1")) pair = { name, one, other };
      }
      if (!pair) continue;
      const { name, one, other } = pair;
      const past: Past = (["room", "scene", "sight"] as const)[seed % 3]!;
      const offset = seed % 2 === 0 ? FAR.byteStep / 2 : -2_000;
      parked([one, other], past, one.tokens["p1-hero"]!.sceneId, offset);
      // Half the runs lower the stored bound under the room, so batches shed; the rest keep HARD, which no run reaches.
      const bound = seed % 2 === 0 ? storedBytes(one) + 5_000 : HARD.storedBytes;
      const r = rng(seed * 104_729);
      let twins: [RoomState, RoomState] = [one, other];
      const undo: { entries: RestoreEntry[] | null; from: "undo" | "redo" } = { entries: null, from: "undo" };
      let i = 0;
      for (; i < STEPS; i++) {
        const where = `seed ${seed} (${past}, ${name}) step ${i}`;
        const step = nextStep(r, twins[0], undo);
        const at = ++seq;
        const answer = (state: RoomState) => {
          if (step.who.role === "dm") {
            const res = applyOp(state, step.op, step.who, env(at));
            return res.ok ? { said: "taken", next: res.state } : { said: `${res.code}: ${res.message}`, next: null };
          }
          return farAnswer(state, step.op, step.who, at);
        };
        const [a, b] = [answer(twins[0]), answer(twins[1])];
        steps++;
        if (step.who.memberId === "p1") said.set(`${step.what}: ${a.said.split(":")[0]}`, (said.get(`${step.what}: ${a.said.split(":")[0]}`) ?? 0) + 1);
        if (a.said !== b.said) {
          const took = (state: RoomState) => applyOp(state, step.op, step.who, env(at));
          const [ta, tb] = [took(twins[0]), took(twins[1])];
          const why = step.who.memberId === "p1" && ta.ok && tb.ok ? readingsApart([twins[0], ta.state], [twins[1], tb.state]) : null;
          if (why) recorded.set(why, (recorded.get(why) ?? 0) + 1);
          else failures.push(`${where}, ${step.what}: ${a.said} against ${b.said}`);
          break;
        }
        if (!a.next || !b.next) continue;
        if (step.who.memberId === "p1" && (step.what === "create" || step.what === "notes")) {
          const res = applyOp(twins[0], step.op, step.who, env(at));
          undo.entries = res.ok ? (res.inverse ?? []).filter((e) => e.key === keys.character("p1-char") || e.key.startsWith("drawing:")) : null;
          undo.from = "undo";
        } else if (step.what === "undo" || step.what === "redo") {
          const res = applyOp(twins[0], step.op, step.who, env(at));
          undo.entries = res.ok ? (res.inverse ?? []).filter((e) => e.key === keys.character("p1-char") || e.key.startsWith("drawing:")) : null;
          undo.from = step.what === "undo" ? "redo" : "undo";
        }
        walksHeld(a.next, `${where} A`);
        walksHeld(b.next, `${where} B`);
        const [ca, cb] = [closed(twins[0], a.next, bound, `${where} A`), closed(twins[1], b.next, bound, `${where} B`)];
        if (ca.shed || cb.shed) sheds++;
        twins = [ca.state, cb.state];
        // A step that shows P1 what told the twins apart, such as the DM's show or lend of the hidden creature, ends the run.
        if (knownBy(twins[0], "p1") !== knownBy(twins[1], "p1")) {
          recorded.set(`shown by ${step.what}`, (recorded.get(`shown by ${step.what}`) ?? 0) + 1);
          break;
        }
      }
      runs.push(`seed ${seed} (${past}, ${name}): ${i} steps`);
    }
    t.diagnostic(runs.join("; "));
    t.diagnostic(`${steps} steps, ${sheds} batches shed, residuals ${JSON.stringify(Object.fromEntries(recorded))}: ${JSON.stringify(Object.fromEntries([...said].sort()))}`);
    assert.deepEqual(failures, []);
    // What hidden bytes may still decide ends a run, and stays rare: a mutant that reads past the copy meets it often.
    const residuals = (recorded.get("own copy") ?? 0) + (recorded.get("step") ?? 0);
    assert.ok(residuals <= Math.ceil(SEEDS / 6), `residuals ${residuals} in ${SEEDS} runs`);
    assert.ok(steps >= SEEDS * STEPS * 0.5, `${steps} steps run`);
    assert.ok(sheds > 0, "some batches shed");
    assert.ok([...said.keys()].some((k) => k.endsWith(": taken")) && [...said.keys()].some((k) => k.endsWith(": quota")), "both answers met");
  });
});
