import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, readEntity, type EntityKey } from "#shared/keys.ts";
import type { Effect, RoomState, Viewer } from "#shared/model.ts";
import { heldClock, projectState, publicEffects, seatView, stableStringify } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, drawing, effect, entry, env, randomOp, randomState, rng, room, scene, template, token } from "#shared/testutil.ts";
import { exactCopies, linesHeld, ownHeldBytes } from "./sizeGuard.ts";

/*
 * D-261116-015 and D-261119-021: a player's exact part counts only what
 * their copy shows, so an op that leaves their copy as it was leaves what
 * the exact part shows, and where, as it was. The exceptions, tracked
 * privately as residuals: a thing of theirs the op makes or removes
 * outright, which shows once, and the DM putting an area of theirs their
 * copy does not hold on a creature or taking it off one. One the DM hid
 * counts as a deleted one does (LP43-PRIV-1, D-261120-012), where they see
 * it or not, so the DM hiding it while unseen takes it out once, as a delete
 * does, and showing it again while unseen is that residual's too.
 */

const copyOf = (state: RoomState, memberId: string) => stableStringify(projectState(state, { memberId, role: "player" }, { sceneId: null }));

const there = (state: RoomState, key: string) => (key.startsWith("row:") ? (state.encounter?.entries.some((e) => `row:${e.id}` === key) ?? false) : readEntity(state, key as EntityKey) != null);

/** Whether the op put an area on a creature or took it off one, or hid or showed it. */
function reattached(before: RoomState, after: RoomState, key: string): boolean {
  if (!key.startsWith("template:")) return false;
  const area = (state: RoomState) => readEntity(state, key as EntityKey) as { attachedTo?: string; visibility?: string } | undefined;
  return area(before)?.attachedTo !== area(after)?.attachedTo || area(before)?.visibility !== area(after)?.visibility;
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

  test("the turn P1's copy shows is its active row's, where it began when the row names no creature, and the mounts sharing it", () => {
    const width = (turn: (state: RoomState) => void) => {
      const state = room();
      state.meta = { ...state.meta, settings: { ...state.meta.settings, playersMoveAny: "all" } };
      const path = { turn: 7, stops: [{ x: 3, y: 3, elevation: 0, seen: true as const }, { x: 5, y: 3, elevation: 0, seen: true as const }] };
      state.tokens.wolf = token("wolf", { x: 5, y: 3, path });
      state.tokens.horse = token("horse", { x: 8, y: 8, size: "large", path: { ...path, stops: path.stops.map((stop) => ({ ...stop, y: 8 })) } });
      turn(state);
      const held = exactCopies(state, "p1");
      return [held.get(keys.token("wolf"))!.shown, held.get(keys.token("horse"))!.shown] as const;
    };
    const start = { sceneId: "s1", x: 3, y: 3, elevation: 0, seq: 7 };
    const none = width(() => {});
    // The wolf's row, where its turn began unseen by players, so the copy shows only the row.
    const [unseenStart] = width((s) => (s.encounter = { rev: 0, round: 1, activeEntryId: "rwolf", entries: [entry("rwolf", { tokenId: "wolf" })], turnStart: { ...start, entryId: "rwolf", tokenId: "wolf" } }));
    // A row by character alone, played by the wolf, where the turn began in sight.
    const [byCharacter] = width((s) => {
      s.characters.c2 = character("c2", { ownerIds: ["p2"] });
      s.tokens.wolf = { ...s.tokens.wolf!, actor: { ref: "c2" } };
      s.encounter = { rev: 0, round: 1, activeEntryId: "rc2", entries: [entry("rc2", { characterId: "c2" })], turnStart: { ...start, entryId: "rc2", tokenId: "wolf", seen: true } };
    });
    // The wolf's turn, riding the horse it steers, which shares the turn.
    const [, mount] = width((s) => {
      s.tokens.wolf = { ...s.tokens.wolf!, x: 8, y: 8, attached: { to: "horse", kind: "ride", steer: true } };
      s.encounter = { rev: 0, round: 1, activeEntryId: "rwolf", entries: [entry("rwolf", { tokenId: "wolf" })], turnStart: { ...start, entryId: "rwolf", tokenId: "wolf", seen: true, mounts: ["horse"] } };
    });
    assert.ok(unseenStart - none[0] > 20_000, `the wolf's row: ${unseenStart} against ${none[0]}`);
    assert.ok(byCharacter - none[0] > 20_000, `a row by character: ${byCharacter} against ${none[0]}`);
    assert.ok(mount - none[1] > 20_000, `the horse sharing the turn: ${mount} against ${none[1]}`);
  });

  test("the DM renames or resizes P1's area while its creature is out of P1's sight, and hiding it takes it out as a delete does", () => {
    for (const patch of [{ label: "A much longer name for the area" }, { size: 60 }]) {
      const { moved, unchanged } = moves(onHidden(), { t: "template.update", templateId: "a1", patch } as Op);
      assert.ok(unchanged > 0, `P1's copy is as it was after ${JSON.stringify(patch)}`);
      assert.deepEqual(moved, [], JSON.stringify(patch));
    }
    const [hidden, deleted] = [{ t: "template.update", templateId: "a1", patch: { visibility: "dm" } }, { t: "template.delete", templateId: "a1" }].map((op) => moves(onHidden(), op as Op).next!) as [RoomState, RoomState];
    assert.equal(copyOf(hidden, "p1"), copyOf(deleted, "p1"), "P1's copies are alike");
    assert.deepEqual(shownBy(hidden, "p1"), shownBy(deleted, "p1"));
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
        // Residual 9 (D-261120-004): an HP line counts what players are shown of the conditions its change put on or took
        // off, which their copy of the line does not carry. It may move only that line, and only with those.
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
          const shownThen = residual ? [shownChanges(base, id), shownChanges(twin, id)] : undefined;
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (a[key] === b[key] || (shownThen && key === "log:hp-seen" && shownThen[0]![key] !== shownThen[1]![key])) continue;
            found.push(`seed ${seed}, ${name}, ${id}'s ${key}: ${a[key] ?? "none"} against ${b[key] ?? "none"}`);
          }
        }
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    for (const name of Object.keys(OMITTED)) assert.ok((compared.get(name) ?? 0) >= 20, `${name}: ${compared.get(name) ?? 0} twins compared`);
  });
});

// ---------------------------------------------------------------------------
// Twins generated from every field a player's copy leaves out (LP44R4-OPUS-1)

type Step = string | number;
/** A change to a stored room: a value put at `path`, or an element added to the list there. */
type Change = { path: Step[]; to: unknown; append?: true };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/** A stored value changed past what a copy may hold of it: a longer string, a number across a digit, a flag the other way. */
function bumped(value: unknown): unknown {
  if (typeof value === "string") return `${value}zz`;
  if (typeof value === "number") return Number.isInteger(value) ? (value >= 0 ? value + 10 ** String(value).length : value - 10 ** String(-value).length) : value * 10;
  if (typeof value === "boolean") return !value;
  return undefined;
}

/** One more of a list's elements, a record under an id of its own. */
const another = (item: unknown) => (isRecord(item) && typeof item.id === "string" ? { ...structuredClone(item), id: `${item.id}-twin` } : structuredClone(item));

/** Every change to `value` and all it holds: each leaf changed, each list one longer. */
function everyChange(value: unknown, path: Step[], out: Change[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => everyChange(item, [...path, i], out));
    if (value.length > 0) out.push({ path, to: another(value.at(-1)), append: true });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) if (key !== "id") everyChange(item, [...path, key], out);
  } else {
    const to = bumped(value);
    if (to !== undefined) out.push({ path, to });
  }
}

/** The changes to what `copy` leaves out of `stored` or holds otherwise, walked as sizeGuard.ts hiddenOf walks them. */
function omittedChanges(stored: unknown, copy: unknown, path: Step[], out: Change[]): void {
  if (copy === undefined || copy === null) return everyChange(stored, path, out);
  if (Array.isArray(stored)) {
    const copies = Array.isArray(copy) ? copy : [];
    stored.forEach((item, i) => {
      const match = isRecord(item) && typeof item.id === "string" ? copies.find((c) => isRecord(c) && c.id === item.id) : copies.find((c) => same(c, item));
      if (match === undefined) {
        everyChange(item, [...path, i], out);
        out.push({ path, to: another(item), append: true });
      } else if (!same(item, match)) omittedChanges(item, match, [...path, i], out);
    });
  } else if (isRecord(stored)) {
    const held = isRecord(copy) ? copy : {};
    for (const [key, item] of Object.entries(stored)) {
      if (key === "id") continue;
      if (!(key in held)) everyChange(item, [...path, key], out);
      else if (!same(item, held[key])) omittedChanges(item, held[key], [...path, key], out);
    }
  } else if (!same(stored, copy)) {
    const to = bumped(stored);
    if (to !== undefined) out.push({ path, to });
  }
}

/** Every thing stored, where it is and as `memberId`'s copy holds it. */
function storedThings(state: RoomState, memberId: string): Array<{ path: Step[]; stored: unknown; copy: unknown }> {
  const view = seatView(state, memberId);
  const out: Array<{ path: Step[]; stored: unknown; copy: unknown }> = [];
  const records = [["tokens", "token"], ["templates", "template"], ["drawings", "drawing"], ["casts", "cast"], ["rolls", "roll"], ["characters", "character"], ["companionBlocks", "companionBlock"], ["members", "member"], ["buildChunks", "chunk"]] as const;
  for (const [name, kind] of records) for (const [id, stored] of Object.entries(state[name] as Record<string, unknown>)) out.push({ path: [name, id], stored, copy: view.copy(kind, id) });
  // A shared line as their exact part holds it: as they read it when it was written, or not at all (linesHeld).
  const lines = linesHeld(state, memberId, view);
  state.log.forEach((line, i) => out.push({ path: ["log", i], stored: line, copy: lines.get(line) ?? null }));
  state.encounter?.entries.forEach((row, i) => out.push({ path: ["encounter", "entries", i], stored: row, copy: view.copy("row", row.id) }));
  return out;
}

function applied(state: RoomState, change: Change): RoomState {
  // Through JSON, so no two places share an object: a change to one is a change to it alone.
  const twin = JSON.parse(JSON.stringify(state)) as RoomState;
  let at: Record<string | number, unknown> = twin as never;
  for (const step of change.path.slice(0, -1)) at = at[step] as never;
  const last = change.path.at(-1)!;
  if (change.append) (at[last] as unknown[]).push(change.to);
  else at[last] = change.to;
  return twin;
}

/** What players are shown of the conditions each HP line's change put on or took off: residual 9 (D-261120-004). */
function shownChanges(state: RoomState, memberId: string): Record<string, string> {
  const clock = heldClock(state, { memberId, role: "player" })?.id;
  const out: Record<string, string> = {};
  for (const line of state.log) {
    const revert = (line.data as { type?: string; revert?: { added?: Effect[]; removed?: Effect[] } } | undefined)?.revert;
    if (revert) out[`log:${line.id}`] = stableStringify(publicEffects([...(revert.added ?? []), ...(revert.removed ?? [])], () => false, clock));
  }
  return out;
}

/**
 * Which of `memberId`'s drawings and asks their copy does not hold, which
 * count as stored, since neither changes once made (D-261119-021,
 * D-261120-010).
 */
const heldAsStored = (state: RoomState, memberId: string) => {
  const view = seatView(state, memberId);
  const drawings = Object.values(state.drawings).filter((d) => d.ownerId === memberId && d.visibility === "all" && view.copy("drawing", d.id) === null).map((d) => `drawing:${d.id}`);
  const asks = Object.values(state.casts).filter((c) => c.by === memberId && view.copy("cast", c.id) === null).map((c) => `cast:${c.id}`);
  return new Set([...drawings, ...asks]);
};

/**
 * Residual 7: an area of theirs their copy does not hold, put on or taken off
 * a creature or onto another floor, which only the DM does. Whose an area is
 * never changes once made. Its hide reads as a delete, residual 6's, and a
 * show again residual 7's (D-261120-012).
 */
const areaMoved = (where: string) => /^templates\.[^.]+\.(attachedTo|sceneId|ownerId|visibility)$/.test(where);

/**
 * What `memberId` holds of a room: their copy, and the shared lines as they
 * read them when written (linesHeld), which their exact part counts so.
 * Twins alike in both must give equal exact parts.
 */
const knownBy = (state: RoomState, memberId: string) => `${copyOf(state, memberId)}\n${stableStringify([...linesHeld(state, memberId)].map(([line, held]) => [line.id, held]))}`;

/** The things the examples a review named need, on a random room: a creature P1 sees with what players are not shown of it. */
function namedBase(seed: number): RoomState {
  const state = randomState(rng(seed * 41 + 11));
  const scene = state.meta.playerSceneId ?? Object.keys(state.scenes)[0]!;
  state.meta = { ...state.meta, view: { ...state.meta.view, blackout: false }, settings: { ...state.meta.settings, playersMoveAny: "all", playersApplyDamage: true } };
  delete state.clock;
  const effects = [
    effect("e-hidden", { key: "poisoned", hiddenFromPlayers: true }),
    effect("e-ready", { key: "readied", label: "When the door opens" }),
    effect("e-save", { key: "custom", label: "Held", save: { ability: "wis", dc: 15 }, due: { id: "12:0", state: "pending" } }),
    effect("e-ends", { key: "blessed", ends: { span: 600, at: 1000, clock: "clk1" } }),
  ];
  state.tokens.seen1 = token("seen1", { sceneId: scene, x: 1, y: 1, hpVisibility: "label", actor: { inline: actor({ hp: { cur: 7, max: 20, temp: 0 }, effects }) } });
  state.tokens.ghost = token("ghost", { sceneId: scene, x: 2, y: 2, visibility: "dm" });
  state.templates.ac = template("ac", { sceneId: scene, ownerId: "p1", attachedTo: "seen1", casterId: "ghost", label: "Faerie Fire" });
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor() });
  state.tokens.hero = token("hero", { kind: "pc", sceneId: scene, actor: { ref: "c1" }, ownerIds: ["p1"], x: 3, y: 1 });
  state.rolls.r1 = { id: "r1", rev: 3, test: { kind: "save", ability: "dex", choices: [] }, dc: 15, dcShown: false, resultShown: false, at: "2026-10-12T20:00:00.000Z", targets: [{ tokenId: "hero", total: 17, by: "p1", result: "pass" }] } as never;
  state.buildChunks[`${scene}:0,0`] = { sceneId: scene, cx: 0, cy: 0, rev: 9, cells: {}, edges: { "3,2,w": { kind: "door", state: "closed", secret: true, discovered: false }, "5,2,w": { kind: "door", state: "closed", secret: false, discovered: false } } } as never;
  const vitals = { hp: { cur: 7, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } };
  const revert = { before: vitals, after: vitals, added: [effects[2]!, effects[0]!], removed: [effects[3]!] };
  state.log = [...state.log, { id: "hp-named", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "hp", change: "damage", amount: 3, label: "Bloodied", left: vitals.hp, revert, tokenId: "seen1", seen: true } } as never];
  return state;
}

/** The examples the review named, by the stored place a change touched. */
const NAMED: Record<string, RegExp> = {
  "a creature's conditions hidden from players": /^tokens\.seen1\.actor\.inline\.effects\.0\b/,
  "HP numbers under a label": /^tokens\.seen1\.actor\.inline\.hp\b/,
  "an unseen caster's id": /^templates\.ac\.casterId$/,
  "a readied action's trigger": /^tokens\.seen1\.actor\.inline\.effects\.1\.label$/,
  "a save's DC or its occurrence": /^tokens\.seen1\.actor\.inline\.effects\.2\.(save\.dc|due\b)/,
  "a hidden clock's end": /^tokens\.seen1\.actor\.inline\.effects\.3\.ends\.(at|clock)$/,
  "a hidden roll answer": /^rolls\.r1\.(targets\.0\.result|dc)$/,
  "a secret door's flags": /^buildChunks\.[^.]+\.edges\.3,2,w\./,
  "an HP line's hidden parts of conditions shown": /^log\.\d+\.data\.revert\.(added\.0\.(save\.dc|due\b)|removed\.0\.ends\.(at|clock))/,
};

describe("LP44R4-OPUS-1: twins apart in any field a player's copy leaves out give them equal exact parts", () => {
  test("every field the copy leaves out or holds otherwise, changed, on rooms with what a review named and random ones", () => {
    const found: string[] = [];
    const named = new Map<string, number>();
    let compared = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const base = namedBase(seed);
      const r = rng(seed * 43 + 1);
      for (const memberId of ["p1", "p2"]) {
        if (!base.members[memberId]) continue;
        const candidates: Change[] = [];
        for (const thing of storedThings(base, memberId)) omittedChanges(thing.stored, thing.copy, thing.path, candidates);
        // A floor changes to another of the room's scenes, as a floor that is not one makes no room.
        const changes = candidates.flatMap((c): Change[] => {
          if (c.path.at(-1) !== "sceneId" || c.append) return [c];
          const other = Object.keys(base.scenes).find((id) => `${id}zz` !== c.to && id !== (c.to as string).slice(0, -2));
          return other === undefined ? [] : [{ ...c, to: other }];
        });
        // Every change at a named place, and a sample of the rest.
        const forced = changes.filter((c) => Object.values(NAMED).some((re) => re.test(c.path.join("."))));
        const rest = changes.filter((c) => !forced.includes(c)).sort(() => r() - 0.5).slice(0, 30);
        const [copy, shown, conditions, asStored] = [knownBy(base, memberId), shownBy(base, memberId), shownChanges(base, memberId), heldAsStored(base, memberId)];
        for (const change of [...forced, ...rest]) {
          const twin = applied(base, change);
          // A change no stored room could hold, such as a word outside its list, makes no twin.
          let twinCopy: string;
          try {
            twinCopy = knownBy(twin, memberId);
          } catch {
            continue;
          }
          if (twinCopy !== copy) continue;
          compared++;
          const where = change.path.join(".");
          for (const [name, re] of Object.entries(NAMED)) if (re.test(where)) named.set(name, (named.get(name) ?? 0) + 1);
          const [after, conditionsAfter] = [shownBy(twin, memberId), shownChanges(twin, memberId)];
          for (const key of new Set([...Object.keys(shown), ...Object.keys(after)])) {
            if (shown[key] === after[key] || asStored.has(key) || (key.startsWith("template:") && areaMoved(where))) continue;
            // Residual 9: an HP line moves only with what players are shown of its conditions.
            if (key.startsWith("log:") && conditions[key] !== conditionsAfter[key]) continue;
            found.push(`seed ${seed}, ${memberId}, ${where}${change.append ? " one longer" : ""}: ${key} ${shown[key] ?? "none"} against ${after[key] ?? "none"}`);
          }
        }
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    assert.ok(compared > 400, `${compared} twins compared`);
    for (const name of Object.keys(NAMED)) assert.ok((named.get(name) ?? 0) > 0, `${name}: no twin compared`);
  });
});
