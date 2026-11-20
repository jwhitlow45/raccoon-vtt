import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, readEntity, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, drawing, effect, entry, env, randomOp, randomState, rng, room, scene, template, token } from "#shared/testutil.ts";
import { exactCopies, ownHeldBytes } from "./sizeGuard.ts";

/*
 * D-261116-015 and D-261119-021: a player's exact part counts only what
 * their copy shows, so an op that leaves their copy as it was leaves what
 * the exact part shows, and where, as it was. The exceptions, tracked
 * privately as residuals: a thing of theirs the op makes or removes
 * outright, which shows once, and the DM putting an area of theirs their
 * copy does not hold on a creature or taking it off one. One the DM hid
 * counts as a deleted one does (LP43-PRIV-1), so only what it follows
 * decides whether it is held then.
 */

const copyOf = (state: RoomState, memberId: string) => stableStringify(projectState(state, { memberId, role: "player" }, { sceneId: null }));

const there = (state: RoomState, key: string) => (key.startsWith("row:") ? (state.encounter?.entries.some((e) => `row:${e.id}` === key) ?? false) : readEntity(state, key as EntityKey) != null);

/** Whether the op put an area on a creature or took it off one. */
function reattached(before: RoomState, after: RoomState, key: string): boolean {
  if (!key.startsWith("template:")) return false;
  const area = (state: RoomState) => readEntity(state, key as EntityKey) as { attachedTo?: string } | undefined;
  return area(before)?.attachedTo !== area(after)?.attachedTo;
}

/** What of `memberId`'s exact part shows otherwise, or counts in another scope, after the op, but for things it made or removed. */
function shownMoved(before: RoomState, after: RoomState, memberId: string): string[] {
  const [was, is] = [exactCopies(before, memberId), exactCopies(after, memberId)];
  const out: string[] = [];
  for (const key of new Set([...was.keys(), ...is.keys()])) {
    const [a, b] = [was.get(key), is.get(key)];
    if (a && b) {
      const [from, to] = [a.shownOn ?? a.on, b.shownOn ?? b.on];
      if (a.shown !== b.shown || from !== to) out.push(`${key}: ${a.shown} B on ${from}, then ${b.shown} B on ${to}`);
    } else if (there(before, key) && there(after, key) && !reattached(before, after, key)) out.push(`${key} ${a ? "left" : "came into"} the exact part`);
  }
  return out;
}

const players = (state: RoomState) => Object.keys(state.members).filter((id) => state.members[id]!.kind === "player");

/** `op` by `who` on `state`, and for each player whose copy it leaves as it was, what of their exact part it moved. */
function moves(state: RoomState, op: Op, who: Viewer = DM): { next: RoomState | null; moved: string[]; unchanged: number } {
  const result = applyOp(state, op, who, env(6_000_000));
  if (!result.ok) return { next: null, moved: [], unchanged: 0 };
  const moved: string[] = [];
  let unchanged = 0;
  for (const id of players(state)) {
    if (copyOf(state, id) !== copyOf(result.state, id)) continue;
    unchanged++;
    moved.push(...shownMoved(state, result.state, id).map((why) => `${id}: ${why}`));
  }
  return { next: result.state, moved, unchanged };
}

/** P1's riding area and kept ruler on a hidden creature `y`, which stands on a floor P1 holds, and a scene P1 does not hold. */
function onHidden(): RoomState {
  const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) } });
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor() });
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
  state.tokens.y = token("y", { x: 9, y: 9, visibility: "dm" });
  state.templates.a1 = template("a1", { ownerId: "p1", attachedTo: "y", casterId: "hero", label: "Faerie Fire" });
  state.drawings.r1 = drawing("r1", { kind: "ruler", ownerId: "p1", anchors: ["hero", "y"], points: [2.5, 2.5, 9.5, 9.5] });
  return state;
}

describe("D-261119-021: an op that leaves a player's copy as it was leaves what their exact part shows as it was", () => {
  test("the DM moves the hidden creature P1's area and ruler are on to a scene P1 does not hold", () => {
    const state = onHidden();
    const { next, moved, unchanged } = moves(state, { t: "token.update", tokenId: "y", patch: { sceneId: "s2", x: 3, y: 3 } } as Op);
    assert.ok(unchanged > 0 && next, "P1's copy is as it was");
    assert.deepEqual(moved, []);
    assert.equal(next.templates.a1!.sceneId, "s2", "the area went along");
    for (const scope of [undefined, ["s1"], ["s2"]]) assert.equal(ownHeldBytes(next, "p1", scope).shown, ownHeldBytes(state, "p1", scope).shown, `P1's reading of ${scope?.[0] ?? "the room"}`);
  });

  test("behind a blackout P1's copy holds none of their own things, an area or a ruler on a hidden creature included", () => {
    const state = onHidden();
    state.meta = { ...state.meta, view: { ...state.meta.view, blackout: true } };
    const held = [...exactCopies(state, "p1").keys()];
    assert.deepEqual(held.filter((key) => key === "template:a1" || key === "drawing:r1"), []);
  });

  test("a creature's walk counts at the walk width on the turn P1's copy shows, for a player who may move it, and as the copy holds it otherwise", () => {
    const walked = (settings: Partial<RoomState["meta"]["settings"]>, active: string) => {
      const state = room();
      state.meta = { ...state.meta, settings: { ...state.meta.settings, ...settings } };
      state.tokens.wolf = token("wolf", { x: 5, y: 3, path: { turn: 7, stops: [{ x: 3, y: 3, elevation: 0, seen: true }, { x: 5, y: 3, elevation: 0, seen: true }] } });
      state.tokens.bat = token("bat", { x: 8, y: 8 });
      state.encounter = { rev: 0, round: 1, activeEntryId: `r${active}`, entries: [entry("rwolf", { tokenId: "wolf", value: 20 }), entry("rbat", { tokenId: "bat", value: 10 })], turnStart: { entryId: `r${active}`, tokenId: active, sceneId: "s1", x: 3, y: 3, elevation: 0, seen: true, seq: 7 } };
      return exactCopies(state, "p1").get(keys.token("wolf"))!;
    };
    const [mover, healer, after] = [walked({ playersMoveAny: "all" }, "wolf"), walked({ playersApplyDamage: true }, "wolf"), walked({ playersMoveAny: "all" }, "bat")];
    assert.ok(mover.shown - healer.shown > 20_000, `${mover.shown} against ${healer.shown}`);
    assert.ok(mover.shown - after.shown > 20_000, `${mover.shown} against ${after.shown} once the turn passed`);
  });

  test("the DM hides P1's area, renames it or resizes it while its creature is out of P1's sight", () => {
    for (const patch of [{ visibility: "dm" }, { label: "A much longer name for the area" }, { size: 60 }]) {
      const { moved, unchanged } = moves(onHidden(), { t: "template.update", templateId: "a1", patch } as Op);
      assert.ok(unchanged > 0, `P1's copy is as it was after ${JSON.stringify(patch)}`);
      assert.deepEqual(moved, [], JSON.stringify(patch));
    }
  });

  test("the DM deletes the hidden creature, which takes P1's area with it, or deletes P1's ruler: only that thing leaves, once (a residual)", () => {
    for (const op of [{ t: "token.delete", tokenId: "y" }, { t: "drawing.delete", drawingId: "r1" }] as Op[]) {
      const state = onHidden();
      const { next, moved, unchanged } = moves(state, op);
      assert.ok(unchanged > 0 && next);
      assert.deepEqual(moved, []);
      const [was, is] = [exactCopies(state, "p1"), exactCopies(next, "p1")];
      const gone = [...was.keys()].filter((key) => !is.has(key));
      assert.deepEqual(gone, [op.t === "token.delete" ? "template:a1" : "drawing:r1"]);
    }
  });

  test("P1's area on a creature in their sight that the DM hid counts as one the DM deleted, as their copies are alike", () => {
    const seen = () => {
      const state = onHidden();
      state.tokens.y = { ...state.tokens.y!, visibility: "all" };
      return state;
    };
    const hidden = seen();
    hidden.templates.a1 = { ...hidden.templates.a1!, visibility: "dm" };
    const deleted = seen();
    delete deleted.templates.a1;
    assert.equal(copyOf(hidden, "p1"), copyOf(deleted, "p1"), "P1's copies are alike");
    assert.deepEqual([...exactCopies(hidden, "p1").keys()], [...exactCopies(deleted, "p1").keys()]);
  });

  test("random rooms through the DM's ops, P1's areas and rulers on hidden creatures among them", () => {
    const found: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 300 && found.length < 10; seed++) {
      const r = rng(seed * 17 + 3);
      let state = randomState(r);
      // P1's area and ruler on a hidden creature in half the rooms, and a fight in a third.
      const hidden = Object.values(state.tokens).find((t) => t.visibility === "dm" && t.ownerIds.length === 0);
      if (hidden && seed % 2 === 0) {
        state.templates.pa = template("pa", { sceneId: hidden.sceneId, ownerId: "p1", attachedTo: hidden.id, label: "Bless" });
        state.drawings.pr = drawing("pr", { sceneId: hidden.sceneId, kind: "ruler", ownerId: "p1", anchors: [null, hidden.id], points: [1.5, 1.5, hidden.x + 0.5, hidden.y + 0.5] });
      }
      if (seed % 3 === 0 && !state.encounter && hidden) state.encounter = { rev: 0, round: 1, activeEntryId: "rh", entries: [entry("rh", { tokenId: hidden.id, hidden: true })] };
      for (let k = 0; k < 10; k++) {
        const op = randomOp(r, state, DM);
        const { next, moved, unchanged } = moves(state, op);
        if (!next) continue;
        checked += unchanged;
        found.push(...moved.map((why) => `seed ${seed}, ${op.t}: ${why}`));
        state = next;
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    assert.ok(checked > 500, `${checked} ops left a player's copy as it was`);
  });
});

/** Where each thing in a player's exact part counts what it shows, and how much: what equal copies must give alike. */
function shownBy(state: RoomState, memberId: string): Record<string, string> {
  return Object.fromEntries([...exactCopies(state, memberId)].map(([key, part]) => [key, `${part.shown} B on ${part.shownOn ?? part.on}`]));
}

/** A creature P1's copy holds that no player owns, and one hidden from players, in a random room. */
const seenCreature = (s: RoomState) => Object.values(s.tokens).find((t) => t.ownerIds.length === 0 && t.visibility === "all" && copyOf(s, "p1").includes(`"id":"${t.id}"`));
const hiddenCreatures = (s: RoomState) => Object.values(s.tokens).filter((t) => t.visibility === "dm" && t.ownerIds.length === 0);
const walk = (seen: boolean[]) => ({ turn: 3, stops: seen.map((on, i) => ({ x: i, y: 1, elevation: 0, ...(on ? { seen: true as const } : {}) })) });

/**
 * Ways a twin of a room differs only in what P1's copy leaves out, each
 * returning false where the room has nothing to change. A twin whose copy
 * comes out otherwise is not compared.
 */
const OMITTED: Record<string, (s: RoomState) => boolean> = {
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
function twinBase(seed: number): RoomState {
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

describe("D-261120-003: rooms whose copies are equal give a player equal exact parts", () => {
  test("random twins apart only in what P1's copy leaves out: walks, hidden fields, a held area's creature and floor, a blackout", () => {
    const found: string[] = [];
    const compared = new Map<string, number>();
    for (let seed = 1; seed <= 150; seed++) {
      for (const [name, omit] of Object.entries(OMITTED)) {
        // A residual the private log tracks: an HP line counts the conditions its change put on or took off that
        // players saw then, which their copy of the line does not carry. It may move only that line.
        const residual = name === "the conditions an HP change on a creature P1 saw put on";
        const base = twinBase(seed);
        // Both twins behind the blackout, or neither: only what it hides differs.
        if (name === "P1's things behind a blackout") base.meta = { ...base.meta, view: { ...base.meta.view, blackout: true } };
        const twin = structuredClone(base);
        if (!omit(twin)) continue;
        for (const id of players(base)) {
          if (copyOf(base, id) !== copyOf(twin, id)) continue;
          compared.set(name, (compared.get(name) ?? 0) + 1);
          const [a, b] = [shownBy(base, id), shownBy(twin, id)];
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (a[key] === b[key] || (residual && key === "log:hp-seen")) continue;
            found.push(`seed ${seed}, ${name}, ${id}'s ${key}: ${a[key] ?? "none"} against ${b[key] ?? "none"}`);
          }
        }
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    for (const name of Object.keys(OMITTED)) assert.ok((compared.get(name) ?? 0) >= 20, `${name}: ${compared.get(name) ?? 0} twins compared`);
  });
});
