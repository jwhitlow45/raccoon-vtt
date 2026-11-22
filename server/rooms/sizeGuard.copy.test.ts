import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, readEntity, type EntityKey } from "#shared/keys.ts";
import type { Effect, RoomState, Viewer } from "#shared/model.ts";
import { lineAudience } from "#shared/logRings.ts";
import { heldClock, projectLogEntry, projectState, publicEffects, seatView, stableStringify } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, character, DM, drawing, effect, entry, env, randomOp, randomState, rng, room, scene, template, token } from "#shared/testutil.ts";
import { exactCopies, farWidths, linesHeld, measuredStateBytes, ownHeldBytes, turnWalks } from "./sizeGuard.ts";
import { GROUND, UPPER, fallCard, trapdoor, tower as floorsTower, withFalls, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import { copyOf, hiddenCreatures, knownBy, OMITTED, placeName, players, seenCreature, twinBase } from "./copyTwinsTesting.ts";

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
      const [from, to] = [placeName(a.shownOn ?? a.on), placeName(b.shownOn ?? b.on)];
      if (a.shown !== b.shown || from !== to) out.push(`${key}: ${a.shown} B on ${from}, then ${b.shown} B on ${to}`);
    } else if (there(before, key) && there(after, key) && !reattached(before, after, key)) out.push(`${key} ${a ? "left" : "came into"} the exact part`);
  }
  return out;
}


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

  test("no walk counts in P1's exact part: a walk of the turn under way counts in the room's walk pool, whoever may move its creature (D-261121-120)", () => {
    const walked = (settings: Partial<RoomState["meta"]["settings"]>, active: string, path: boolean, seq = 7) => {
      const state = room();
      state.meta = { ...state.meta, settings: { ...state.meta.settings, ...settings } };
      state.tokens.wolf = token("wolf", { x: 5, y: 3, ...(path ? { path: { turn: 7, stops: [{ x: 3, y: 3, elevation: 0, seen: true }, { x: 5, y: 3, elevation: 0, seen: true }] } } : {}) });
      state.tokens.bat = token("bat", { x: 8, y: 8 });
      state.encounter = { rev: 0, round: 1, activeEntryId: `r${active}`, entries: [entry("rwolf", { tokenId: "wolf", value: 20 }), entry("rbat", { tokenId: "bat", value: 10 })], turnStart: { entryId: `r${active}`, tokenId: active, sceneId: "s1", x: 3, y: 3, elevation: 0, seen: true, seq } };
      return { state, wolf: exactCopies(state, "p1").get(keys.token("wolf"))! };
    };
    for (const settings of [{ playersMoveAny: "all" as const }, { playersApplyDamage: true }]) {
      const [walking, standing] = [walked(settings, "wolf", true), walked(settings, "wolf", false)];
      assert.equal(walking.wolf.shown, standing.wolf.shown, JSON.stringify(settings));
      assert.equal(walking.wolf.sub, standing.wolf.sub, JSON.stringify(settings));
      const whole = (state: RoomState) => measuredStateBytes(state) + farWidths(state);
      assert.equal(whole(walking.state), whole(standing.state), "the pool holds the turn's walk");
    }
    // Once its turn passed the walk is not the turn's: a room kept it from before change format 65, and it counts at its
    // bytes outside P1's exact part until a turn's end takes it off.
    const [after, none] = [walked({ playersMoveAny: "all" }, "bat", true, 8), walked({ playersMoveAny: "all" }, "bat", false, 8)];
    assert.equal(after.wolf.shown, none.wolf.shown);
    assert.equal(turnWalks(after.state).bytes, 0);
    assert.equal(farWidths(after.state), farWidths(none.state));
    assert.ok(measuredStateBytes(after.state) > measuredStateBytes(none.state));
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
  return Object.fromEntries([...exactCopies(state, memberId)].map(([key, part]) => [key, `${part.shown} B on ${placeName(part.shownOn ?? part.on)}`]));
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
          if (knownBy(base, id) !== knownBy(twin, id)) continue;
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
 * Whether a change touched the thing `key` names itself, a drawing or an
 * ask held as stored, whose own content its hold counts so: a change
 * anywhere else, such as where its creature stands, must leave it alike
 * (LP44R5-OPUS-1).
 */
const ownContent = (key: string, where: string) => {
  const at = key.replace(/^drawing:/, "drawings.").replace(/^cast:/, "casts.");
  return where === at || where.startsWith(`${at}.`);
};

/**
 * Residual 7: an area of theirs their copy does not hold, put on or taken off
 * a creature or onto another floor, which only the DM does. Whose an area is
 * never changes once made. Its hide reads as a delete, residual 6's, and a
 * show again residual 7's (D-261120-012).
 */
const areaMoved = (where: string) => /^templates\.[^.]+\.(attachedTo|sceneId|ownerId|visibility)$/.test(where);

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
  // P1's ruler kept on the hidden creature, which their copy does not hold and their exact part holds as stored.
  state.drawings.kept = drawing("kept", { sceneId: scene, kind: "ruler", ownerId: "p1", anchors: [null, "ghost"], points: [1.5, 1.5, 2.5, 2.5] });
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
  "where the hidden creature a held ruler is kept on stands": /^tokens\.ghost\.(x|y|sceneId)$/,
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
            if (shown[key] === after[key] || (asStored.has(key) && ownContent(key, where)) || (key.startsWith("template:") && areaMoved(where))) continue;
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

// ---------------------------------------------------------------------------
// A shared line as a player's exact part holds it is what they read when it was written (LP44-FABLE-9 and 10)

/** A clock op of the DM's, now and then a blackout, else a random op of the DM's or P1's. */
function lineOp(r: () => number, state: RoomState, k: number): { op: Op; who: Viewer } {
  const roll = r();
  if (roll < 0.15) return { op: { t: "clock.advance", by: 1 + Math.floor(r() * 600_000) } as Op, who: DM };
  if (roll < 0.2) return { op: { t: "clock.set", at: Math.floor(r() * 9_000_000) } as Op, who: DM };
  if (roll < 0.25) return { op: { t: "clock.update", shown: r() < 0.7 } as Op, who: DM };
  if (roll < 0.35) return { op: { t: "view.blackout", blackout: r() < 0.5 } as Op, who: DM };
  const who = k % 2 === 0 ? DM : ({ memberId: "p1", role: "player" } as Viewer);
  return { op: randomOp(r, state, who), who };
}

describe("LP44-FABLE-10: a shared line counts in a player's exact part as they read it when the op wrote it", () => {
  test("random rooms through the DM's and P1's ops, the DM's clock ops and blackouts among them: each player's written line is their read of it then", () => {
    const found: string[] = [];
    let lines = 0;
    let dark = 0;
    for (let seed = 1; seed <= 600 && found.length < 10; seed++) {
      const r = rng(seed * 53 + 5);
      let state = randomState(r);
      state.clock = { id: "clk1", rev: 0, t: 86_400, shown: true, calendar: { kind: "days" } };
      for (let k = 0; k < 12; k++) {
        const { op, who } = lineOp(r, state, k);
        const result = applyOp(state, op, who, env(7_000_000 + seed * 20 + k));
        if (!result.ok) continue;
        const next = result.state;
        const was = new Set(state.log.map((line) => line.id));
        for (const line of next.log) {
          if (was.has(line.id) || lineAudience(line) !== "shared") continue;
          lines++;
          if (next.meta.view?.blackout) dark++;
          for (const id of players(next)) {
            const viewer: Viewer = { memberId: id, role: "player" };
            const [held, read] = [seatView(next, id).written(line.id), projectLogEntry(next, line, viewer, { sceneId: null })];
            if (stableStringify(held) !== stableStringify(read)) found.push(`seed ${seed}, ${op.t}, ${id}'s ${line.data?.type ?? line.kind} line: ${stableStringify(held)} against ${stableStringify(read)}`);
          }
        }
        state = next;
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    assert.ok(lines > 2_000 && dark > 300, `${lines} new shared lines, ${dark} behind a blackout`);
  });

  test("a clock line the DM writes behind a blackout is in no player's exact part until it lifts, as in their copy (D-261120-062)", () => {
    const dark = () => {
      const state = room();
      state.clock = { id: "clk1", rev: 0, t: 86_400, shown: true, calendar: { kind: "days" } };
      const result = applyOp(state, { t: "view.blackout", blackout: true } as Op, DM, env(7_900_000));
      assert.ok(result.ok, result.ok ? "" : result.message);
      return result.state;
    };
    for (const by of [60, 600_000]) {
      const [quiet, advanced] = [dark(), applyOp(dark(), { t: "clock.advance", by } as Op, DM, env(7_900_001))];
      assert.ok(advanced.ok, advanced.ok ? "" : advanced.message);
      assert.equal(copyOf(advanced.state, "p1"), copyOf(quiet, "p1"), "P1's copies are equal");
      assert.deepEqual(shownBy(advanced.state, "p1"), shownBy(quiet, "p1"), `by ${by}`);
      const lifted = applyOp(advanced.state, { t: "view.blackout", blackout: false } as Op, DM, env(7_900_002));
      assert.ok(lifted.ok, lifted.ok ? "" : lifted.message);
      const line = lifted.state.log.find((entry) => entry.data?.type === "clock")!;
      assert.ok(exactCopies(lifted.state, "p1").has(keys.log(line.id)), "and in P1's once the blackout lifts");
    }
  });
});

describe("D-261120-060: a player's creature's walk past its turn counts as their copy held it on that turn", () => {
  test("random rooms through the DM's and P1's ops: wherever P1's copy holds a walk of a creature of theirs, it is the walk their exact part keeps", () => {
    const found: string[] = [];
    let walks = 0;
    for (let seed = 1; seed <= 400 && found.length < 10; seed++) {
      const r = rng(seed * 59 + 3);
      let state = randomState(r);
      // A fight on the turn of a creature of P1's, which P1 walks now and then.
      const mine = Object.values(state.tokens).find((t) => t.ownerIds.includes("p1") && t.attached === undefined);
      if (mine) state.encounter = { rev: 0, round: 1, activeEntryId: "rmine", entries: [entry("rmine", { tokenId: mine.id, value: 30 }), ...(state.encounter?.entries ?? [])], turnStart: { entryId: "rmine", tokenId: mine.id, sceneId: mine.sceneId, x: mine.x, y: mine.y, elevation: mine.elevation, seq: 5 } };
      for (let k = 0; k < 10; k++) {
        const who: Viewer = k % 2 === 0 ? DM : { memberId: "p1", role: "player" };
        const at = mine ? state.tokens[mine.id] : undefined;
        const op: Op = at && k % 2 === 1 && r() < 0.7 ? ({ t: "token.move", tokenId: at.id, x: at.x + Math.floor(r() * 5) - 2, y: at.y + Math.floor(r() * 5) - 2 } as Op) : randomOp(r, state, who);
        const result = applyOp(state, op, who, env(8_000_000 + seed * 20 + k));
        if (!result.ok) continue;
        state = result.state;
        const view = seatView(state, "p1");
        for (const id of Object.keys(state.tokens)) {
          const held = (view.copy("token", id) as { path?: unknown } | null)?.path;
          if (held === undefined) continue;
          const walk = view.walk(id);
          if (walk === null) continue;
          walks++;
          if (stableStringify(held) !== stableStringify(walk)) found.push(`seed ${seed}, ${id}: ${stableStringify(held)} against ${stableStringify(walk)}`);
        }
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    assert.ok(walks > 300, `${walks} walks compared`);
  });
});

test("on a Per player scene with fog, the walk P1's exact part keeps past its turn holds only the bends their copy held on it (D-261120-060)", () => {
  const state = room({ scenes: { s1: scene("s1", { fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } }), s2: scene("s2", { order: 1 }) } });
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor() });
  // A leg no other player saw whole, whose bend lies on ground P1's fog hides.
  const path = { turn: 7, stops: [{ x: 2, y: 2, elevation: 0 }, { x: 4, y: 4, elevation: 0, via: [2, 4], moved: 20, cost: 20 }] };
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 4, y: 4, path });
  state.encounter = { rev: 0, round: 1, activeEntryId: "rhero", entries: [entry("rhero", { tokenId: "hero" })], turnStart: { entryId: "rhero", tokenId: "hero", sceneId: "s1", x: 2, y: 2, elevation: 0, seq: 7 } };
  const view = seatView(state, "p1");
  const held = (view.copy("token", "hero") as { path?: { stops: Array<{ via?: unknown }> } }).path;
  assert.ok(held && held.stops[1]!.via === undefined, "P1's copy holds the walk without the bend");
  assert.equal(stableStringify(view.walk("hero")), stableStringify(held));
  // Past the turn, which a turn of another row's started, the exact part keeps it so.
  const later = { ...state, encounter: { ...state.encounter, activeEntryId: null, turnStart: undefined } } as RoomState;
  assert.equal(stableStringify(seatView(later, "p1").walk("hero")), stableStringify(held));
});

// ---------------------------------------------------------------------------
// Floors phase 4 (docs/design/design-v1-floors.md phase 4, 4.7): openings, falls, cards and trapdoors

/**
 * A floors room: the tower's opening from Upper floor down to Ground floor
 * and its stairs, hidden by the seed, a trapdoor upstairs, the DM's cards,
 * and Thorn, P1's, upstairs with P1's area on it and, by the seed, a hidden
 * owl on it bearing another area of P1's, a hidden goblin with an area of
 * the DM's on the trapdoor, a hidden ogre beside the hole, a fall P1's
 * Thorn already took, Thorn's turn and Upper floor reached or not.
 */
function floorsBase(seed: number): RoomState {
  const r = rng(seed * 47 + 13);
  let s = withStairs(withOpening(floorsTower()));
  if (r() < 0.5) s = { ...s, floorLinks: Object.fromEntries(Object.entries(s.floorLinks!).map(([id, link]) => [id, link.kind === "stairs" ? { ...link, hidden: true as const } : link])) };
  s.traps = { td1: trapdoor("td1", { zone: { cells: [{ x: 10, y: 6, w: 2, h: 2 }] } }) };
  s.tokens.thorn = { ...s.tokens.thorn!, sceneId: UPPER, x: 4, y: 6, rev: 9 };
  s.templates.aura = template("aura", { sceneId: UPPER, ownerId: "p1", attachedTo: "thorn", label: "Aura of Protection", rev: 9 });
  if (r() < 0.6) {
    s.tokens.owl = token("owl", { kind: "pc", size: "tiny", visibility: "dm", sceneId: UPPER, x: 4, y: 6, rev: 9, attached: { to: "thorn", kind: "perch" }, nudge: { x: 0.25, y: 0 } });
    s.templates.mark = template("mark", { sceneId: UPPER, ownerId: "p1", attachedTo: "owl", casterId: "thorn", label: "Hunter's Mark", rev: 9 });
  }
  if (r() < 0.6) {
    s.tokens.gob = token("gob", { visibility: "dm", sceneId: UPPER, x: 10, y: 6, rev: 99, path: { turn: 2, stops: [{ x: 9, y: 6, elevation: 0 }, { x: 10, y: 6, elevation: 0 }] } });
    s.templates.gobaura = template("gobaura", { sceneId: UPPER, ownerId: "dm1", attachedTo: "gob", visibility: "dm", rev: 9 });
  }
  if (r() < 0.5) s.tokens.ogre = token("ogre", { visibility: "dm", sceneId: GROUND, x: 8, y: 8, rev: 9 });
  if (r() < 0.6) s = withFalls(s, ...Array.from({ length: 1 + Math.floor(r() * 10) }, (_, i) => fallCard({ id: `${40 + i}:0`, made: 40 + i, tokenId: i % 2 ? "gob" : "thorn", riders: i % 3 ? ["owl"] : undefined })));
  if (r() < 0.4) s.encounter = { rev: 9, round: 1, activeEntryId: "rthorn", entries: [entry("rthorn", { tokenId: "thorn" })], turnStart: { entryId: "rthorn", tokenId: "thorn", sceneId: UPPER, x: 4, y: 6, elevation: 0, seen: true, seq: 7 } };
  s.openFloors = { [GROUND]: { sceneId: GROUND, rev: 1 }, ...(r() < 0.6 ? { [UPPER]: { sceneId: UPPER, rev: 1 } } : {}) };
  // A fall Thorn already took, so its walk and its area hold what a fall writes.
  if (r() < 0.5) {
    const fell = applyOp(s, { t: "token.move", tokenId: "thorn", x: 6, y: 6 } as Op, { memberId: "p1", role: "player" }, env(6_100_000 + seed));
    assert.ok(fell.ok, fell.ok ? "" : fell.message);
    s = fell.state;
  }
  return s;
}

describe("floors phase 4: an op that leaves a player's copy as it was leaves what their exact part shows as it was", () => {
  test("the DM's falls, drops, Dismiss, hidden stairs and a delete of a card's creature, on floors rooms", () => {
    const found: string[] = [];
    let compared = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const state = floorsBase(seed);
      const ops: Op[] = [
        { t: "token.move", tokenId: "ogre", x: 3, y: 3 },
        { t: "token.move", tokenId: "gob", x: 6, y: 6 },
        { t: "token.move", tokenId: "gob", x: 13, y: 6, route: [[10, 6, 0, 0], [13, 6, 0, 0]] } as Op,
        { t: "fall.settle", fallId: "40:0" },
        { t: "token.delete", tokenId: "gob" },
        { t: "floorLink.update", linkId: "l1", patch: { hidden: true } } as Op,
        { t: "trap.spring", trapId: "td1", tokenIds: ["gob"] } as Op,
      ];
      for (const op of ops) {
        const { moved, unchanged } = moves(state, op);
        compared += unchanged;
        found.push(...moved.map((why) => `seed ${seed}, ${op.t}: ${why}`));
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    assert.ok(compared > 150, `${compared} copies unchanged and compared`);
  });

  test("twins apart in every field P1's copy leaves out of a floors room give equal exact parts", () => {
    const found: string[] = [];
    let compared = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const base = floorsBase(seed);
      const r = rng(seed * 53 + 1);
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
        const [copy, shown, asStored] = [knownBy(base, memberId), shownBy(base, memberId), heldAsStored(base, memberId)];
        for (const change of changes.sort(() => r() - 0.5).slice(0, 60)) {
          const twin = applied(base, change);
          let twinCopy: string;
          try {
            twinCopy = knownBy(twin, memberId);
          } catch {
            continue;
          }
          if (twinCopy !== copy) continue;
          compared++;
          const where = change.path.join(".");
          const after = shownBy(twin, memberId);
          for (const key of new Set([...Object.keys(shown), ...Object.keys(after)])) {
            if (shown[key] === after[key] || asStored.has(key) || (key.startsWith("template:") && areaMoved(where))) continue;
            found.push(`seed ${seed}, ${memberId}, ${where}${change.append ? " one longer" : ""}: ${key} ${shown[key] ?? "none"} against ${after[key] ?? "none"}`);
          }
        }
      }
    }
    assert.deepEqual(found.slice(0, 10), []);
    assert.ok(compared > 300, `${compared} twins compared`);
  });
});
