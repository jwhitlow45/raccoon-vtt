import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Viewer } from "../model.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { actor, chance, env, int, member, pick, rng, room } from "../testutil.ts";
import { DEPENDED_ON, PARENT_GONE } from "./misc.ts";

const A: Viewer = { memberId: "dmA", role: "dm" };
const B: Viewer = { memberId: "dmB", role: "dm" };

function twoDms(): RoomState {
  return room({ members: { dmA: member("dmA", "dm"), dmB: member("dmB", "dm"), p1: member("p1") } });
}

/** Every reference to a scene, a character or a token that names one missing from the room. */
function stranded(state: RoomState): string[] {
  const out: string[] = [];
  const scene = (what: string, id: string) => {
    if (!state.scenes[id]) out.push(`${what} on missing scene ${id}`);
  };
  if (state.meta.playerSceneId !== null) scene("player scene", state.meta.playerSceneId);
  for (const [key, c] of Object.entries(state.buildChunks)) scene(`chunk ${key}`, c.sceneId);
  for (const [key, t] of Object.entries(state.fogTiles)) scene(`fog tile ${key}`, t.sceneId);
  for (const id of Object.keys(state.fogDrafts)) scene("fog draft", id);
  for (const l of Object.values(state.labels)) scene(`label ${l.id}`, l.sceneId);
  for (const t of Object.values(state.templates)) {
    scene(`template ${t.id}`, t.sceneId);
    if (t.attachedTo !== undefined && !state.tokens[t.attachedTo]) out.push(`template ${t.id} attached to missing token ${t.attachedTo}`);
    if (t.casterId !== undefined && !state.tokens[t.casterId]) out.push(`template ${t.id} cast by missing token ${t.casterId}`);
  }
  for (const d of Object.values(state.drawings)) scene(`drawing ${d.id}`, d.sceneId);
  for (const t of Object.values(state.tokens)) {
    scene(`token ${t.id}`, t.sceneId);
    if ("ref" in t.actor && !state.characters[t.actor.ref]) out.push(`token ${t.id} of missing character ${t.actor.ref}`);
  }
  for (const e of state.encounter?.entries ?? []) {
    if (e.characterId !== undefined && !state.characters[e.characterId]) out.push(`entry ${e.id} of missing character ${e.characterId}`);
    if (e.tokenId !== undefined && !state.tokens[e.tokenId]) out.push(`entry ${e.id} of missing token ${e.tokenId}`);
  }
  return out;
}

function run(state: RoomState, op: Op, who: Viewer, seq: number): { state: RoomState; inverse: RestoreEntry[] } {
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return { state: r.state, inverse: r.inverse ?? [] };
}

/** An undo as the server builds it, marked so the reference checks apply. */
function undo(state: RoomState, entries: RestoreEntry[], seq: number) {
  return applyOp(state, { t: "sys.restore", entries, from: "undo", deps: true }, A, env(seq));
}

const newScene: Op = { t: "scene.create", scene: { id: "crypt", name: "Crypt", bounds: { w: 30, h: 30 } } };
const rat = (sceneId: string, overrides: object = {}): Op => ({
  t: "token.create",
  token: { id: "rat", sceneId, kind: "monster", name: "Rat", size: "tiny", x: 1, y: 1, actor: { inline: actor() }, ...overrides },
});

describe("a restore never strands work on a scene, character or token that is gone", () => {
  // What another DM may add to a scene after this DM created it.
  const onScene: Record<string, Op> = {
    paint: { t: "build.paint", sceneId: "crypt", terrain: "stone", cells: ["1,1"] },
    label: { t: "build.label", sceneId: "crypt", labelId: "l1", label: { x: 2, y: 2, text: "Altar", size: 1 } },
    token: rat("crypt"),
    template: {
      t: "template.create",
      template: { id: "a1", sceneId: "crypt", shape: "sphere", size: 20, origin: { x: 2, y: 2, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff0000", ownerId: "dmB", visibility: "all" },
    },
    drawing: {
      t: "drawing.create",
      drawing: { id: "d1", sceneId: "crypt", kind: "line", points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 1, opacity: 1 }, ownerId: "dmB", visibility: "all" },
    },
    "fog tile": { t: "fog.live", sceneId: "crypt", ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }] },
    "fog draft": { t: "fog.draft", sceneId: "crypt", add: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }] },
    "player scene": { t: "room.setPlayerScene", sceneId: "crypt" },
  };

  for (const [what, op] of Object.entries(onScene)) {
    test(`undoing a scene's creation is refused once another DM's ${what} is on it`, () => {
      const created = run(twoDms(), newScene, A, 1);
      const used = run(created.state, op, B, 2);
      const r = undo(used.state, created.inverse, 3);
      assert.ok(!r.ok);
      assert.equal(r.message, DEPENDED_ON);
    });
  }

  test("a stored restore without the server's mark applies as the older build applied it, so its room still replays", () => {
    const created = run(twoDms(), newScene, A, 1);
    const used = run(created.state, onScene.token!, B, 2);
    const r = applyOp(used.state, { t: "sys.restore", entries: created.inverse, from: "undo" }, A, env(3));
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.equal(r.state.scenes.crypt, undefined);
    assert.deepEqual(stranded(r.state), ["token rat on missing scene crypt"]);
  });

  test("undoing a scene's creation still works when nothing uses it, or after its own content is undone", () => {
    const created = run(twoDms(), newScene, A, 1);
    assert.ok(undo(created.state, created.inverse, 2).ok);
    const painted = run(created.state, onScene.paint!, A, 2);
    const unpainted = undo(painted.state, painted.inverse, 3);
    assert.ok(unpainted.ok);
    const gone = undo(unpainted.state, created.inverse, 4);
    assert.ok(gone.ok, gone.ok ? "" : gone.message);
    assert.equal(gone.state.scenes.crypt, undefined);
    assert.deepEqual(stranded(gone.state), []);
  });

  test("undoing a scene's delete, and redoing it, take the scene and everything on it together", () => {
    let state = run(twoDms(), newScene, A, 1).state;
    state = run(state, onScene.paint!, A, 2).state;
    state = run(state, onScene.token!, A, 3).state;
    const deleted = run(state, { t: "scene.delete", sceneId: "crypt" }, A, 4);
    const back = undo(deleted.state, deleted.inverse, 5);
    assert.ok(back.ok, back.ok ? "" : back.message);
    assert.ok(back.state.tokens.rat && back.state.scenes.crypt);
    const redo = applyOp(back.state, { t: "sys.restore", entries: back.inverse!, from: "redo", deps: true }, A, env(6));
    assert.ok(redo.ok, redo.ok ? "" : redo.message);
    assert.equal(redo.state.scenes.crypt, undefined);
    assert.deepEqual(stranded(redo.state), []);
  });

  test("undoing a character's creation is refused once a token or an initiative row uses it", () => {
    const c9 = { id: "c9", name: "Wren", size: "medium" as const, ownerIds: ["p1"], actor: actor({ dmNotes: "" }) };
    const created = run(twoDms(), { t: "character.create", character: c9 }, A, 1);
    const placed = run(created.state, rat("s1", { id: "wren", kind: "pc", name: "Wren", size: "medium", actor: { ref: "c9" } }), B, 2);
    const r = undo(placed.state, created.inverse, 3);
    assert.ok(!r.ok);
    assert.equal(r.message, DEPENDED_ON);
    const rolled = run(created.state, { t: "encounter.start", entries: [{ id: "n1", characterId: "c9", value: 12 }] }, B, 2);
    const r2 = undo(rolled.state, created.inverse, 3);
    assert.ok(!r2.ok);
    assert.equal(r2.message, DEPENDED_ON);
  });

  test("putting back a token whose scene or character was deleted since is refused", () => {
    const placed = run(twoDms(), rat("s2"), A, 1);
    const removed = run(placed.state, { t: "token.delete", tokenId: "rat" }, A, 2);
    const sceneGone = run(removed.state, { t: "scene.delete", sceneId: "s2" }, B, 3);
    const r = undo(sceneGone.state, removed.inverse, 4);
    assert.ok(!r.ok);
    assert.equal(r.message, PARENT_GONE);

    let state = run(twoDms(), { t: "character.create", character: { id: "c9", name: "Wren", size: "medium", ownerIds: [], actor: actor() } }, A, 1).state;
    state = run(state, rat("s1", { id: "wren", kind: "pc", actor: { ref: "c9" } }), A, 2).state;
    const tokenGone = run(state, { t: "token.delete", tokenId: "wren" }, A, 3);
    const characterGone = run(tokenGone.state, { t: "character.delete", characterId: "c9" }, B, 4);
    const r2 = undo(characterGone.state, tokenGone.inverse, 5);
    assert.ok(!r2.ok);
    assert.equal(r2.message, PARENT_GONE);
  });

  test("putting back a player scene that was deleted since is refused", () => {
    const moved = run(twoDms(), { t: "room.setPlayerScene", sceneId: "s2" }, A, 1);
    const deleted = run(moved.state, { t: "scene.delete", sceneId: "s1" }, B, 2);
    const r = undo(deleted.state, moved.inverse, 3);
    assert.ok(!r.ok);
    assert.equal(r.message, PARENT_GONE);
  });

  const goblin = rat("s1", { id: "gob", name: "Goblin", size: "medium" });
  const area = (id: string, ref: { attachedTo?: string; casterId?: string }): Op => ({
    t: "template.create",
    template: { id, sceneId: "s1", shape: "sphere", size: 10, origin: { x: 1, y: 1, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff0000", ownerId: "dmB", visibility: "all", ...ref },
  });
  // What another DM may hang on a token after this DM created it.
  const onToken: Record<string, Op> = {
    "initiative row": { t: "encounter.start", entries: [{ id: "e1", tokenId: "gob", value: 12 }] },
    "area attached to it": area("a1", { attachedTo: "gob" }),
    "area cast from it": area("a1", { casterId: "gob" }),
  };

  for (const [what, op] of Object.entries(onToken)) {
    test(`undoing a token's creation is refused once another DM's ${what} names it`, () => {
      const created = run(twoDms(), goblin, A, 1);
      const used = run(created.state, op, B, 2);
      const r = undo(used.state, created.inverse, 3);
      assert.ok(!r.ok);
      assert.equal(r.message, DEPENDED_ON);
    });
  }

  test("putting back an initiative row or an area whose token was deleted since is refused", () => {
    let state = run(twoDms(), goblin, A, 1).state;
    state = run(state, { t: "encounter.start", entries: [{ id: "e1", tokenId: "gob", value: 12 }, { id: "e2", label: "Lair", value: 20 }] }, A, 2).state;
    const rowGone = run(state, { t: "encounter.remove", entryIds: ["e1"] }, A, 3);
    const tokenGone = run(rowGone.state, { t: "token.delete", tokenId: "gob" }, B, 4);
    const r = undo(tokenGone.state, rowGone.inverse, 5);
    assert.ok(!r.ok);
    assert.equal(r.message, PARENT_GONE);

    for (const ref of [{ attachedTo: "gob" }, { casterId: "gob" }]) {
      const placed = run(run(twoDms(), goblin, A, 1).state, area("a1", ref), A, 2);
      const areaGone = run(placed.state, { t: "template.delete", templateId: "a1" }, A, 3);
      const gone = run(areaGone.state, { t: "token.delete", tokenId: "gob" }, B, 4);
      const r2 = undo(gone.state, areaGone.inverse, 5);
      assert.ok(!r2.ok, JSON.stringify(ref));
      assert.equal(r2.message, PARENT_GONE);
    }
  });

  test("undoing a token's creation keeps a duration anchored to it paused, as deleting the token does", () => {
    let state = run(twoDms(), rat("s1", { id: "hero", name: "Hero", size: "medium" }), A, 1).state;
    const created = run(state, goblin, A, 2);
    const blessed = { id: "fx1", key: "blessed", duration: { mode: "rounds", rounds: 10, of: { tokenId: "gob" } } } as const;
    state = run(created.state, { t: "actor.effect.add", target: { tokenId: "hero" }, effect: blessed }, B, 3).state;
    const undone = undo(state, created.inverse, 4);
    assert.ok(undone.ok, undone.ok ? "" : undone.message);
    const deleted = run(state, { t: "token.delete", tokenId: "gob" }, A, 4);
    assert.deepEqual(undone.state.tokens.hero, deleted.state.tokens.hero);
    const hero = undone.state.tokens.hero!.actor;
    assert.ok("inline" in hero);
    assert.deepEqual(hero.inline.effects[0]?.duration?.anchor, { tokenId: "gob" });
  });

  test("a reference an older build's restore left stranded does not block later undos of what holds it", () => {
    const created = run(twoDms(), goblin, A, 1);
    const rolled = run(created.state, { t: "encounter.start", entries: [{ id: "e1", tokenId: "gob", value: 12 }, { id: "e2", label: "Lair", value: 20 }] }, B, 2);
    const legacy = applyOp(rolled.state, { t: "sys.restore", entries: created.inverse, from: "undo" }, A, env(3));
    assert.ok(legacy.ok);
    assert.deepEqual(stranded(legacy.state), ["entry e1 of missing token gob"]);
    const next = run(legacy.state, { t: "encounter.next" }, B, 4);
    const back = applyOp(next.state, { t: "sys.restore", entries: next.inverse, from: "undo", deps: true }, B, env(5));
    assert.ok(back.ok, back.ok ? "" : back.message);
    assert.equal(back.state.encounter?.activeEntryId, rolled.state.encounter?.activeEntryId);
  });

  test("random edits, undos and redos by two DMs never strand anything", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      let state = twoDms();
      const stacks = new Map<string, { undo: RestoreEntry[][]; redo: RestoreEntry[][] }>([
        ["dmA", { undo: [], redo: [] }],
        ["dmB", { undo: [], redo: [] }],
      ]);
      for (let seq = 1; seq <= 120; seq++) {
        const who = chance(r, 0.5) ? A : B;
        const stack = stacks.get(who.memberId)!;
        const roll = r();
        let op: Op;
        let from: "undo" | "redo" | null = null;
        if (roll < 0.3 && stack.undo.length > 0) {
          op = { t: "sys.restore", entries: stack.undo.pop()!, from: (from = "undo"), deps: true };
        } else if (roll < 0.4 && stack.redo.length > 0) {
          op = { t: "sys.restore", entries: stack.redo.pop()!, from: (from = "redo"), deps: true };
        } else {
          op = randomEdit(r, state, `${seed}-${seq}`);
        }
        const result = applyOp(state, op, who, env(seq));
        if (!result.ok) continue;
        state = result.state;
        if (result.inverse) {
          if (from === "undo") stack.redo.push(result.inverse);
          else if (from === "redo") stack.undo.push(result.inverse);
          else {
            stack.undo.push(result.inverse);
            stack.redo = [];
          }
        }
        assert.deepEqual(stranded(state), [], `seed ${seed}, op ${seq} (${op.t})`);
      }
    }
  });
});

/** An edit that adds to or takes away from a scene, a character or a token, the things a restore could strand. */
function randomEdit(r: () => number, state: RoomState, id: string): Op {
  const sceneIds = Object.keys(state.scenes);
  const sceneId = pick(r, sceneIds);
  const characterIds = Object.keys(state.characters);
  const tokenIds = Object.keys(state.tokens);
  const cell = () => `${int(r, 0, 19)},${int(r, 0, 19)}`;
  const templateIds = Object.keys(state.templates);
  const entryIds = state.encounter?.entries.map((e) => e.id) ?? [];
  switch (int(r, 0, 14)) {
    case 0:
      return { t: "scene.create", scene: { id: `s-${id}`, name: "Room", bounds: { w: 20, h: 20 } } };
    case 1:
      return { t: "scene.delete", sceneId };
    case 2:
      return { t: "room.setPlayerScene", sceneId };
    case 3:
      return { t: "build.paint", sceneId, terrain: "stone", cells: [cell()] };
    case 4:
      return { t: "build.label", sceneId, labelId: `l-${id}`, label: { x: int(r, 0, 19), y: int(r, 0, 19), text: "Hall", size: 1 } };
    case 5: {
      const ref = characterIds.length > 0 && chance(r, 0.6) ? { ref: pick(r, characterIds) } : { inline: actor() };
      return rat(sceneId, { id: `t-${id}`, ...("ref" in ref ? { kind: "pc" } : {}), actor: ref });
    }
    case 6:
      return { t: "token.delete", tokenId: tokenIds.length > 0 ? pick(r, tokenIds) : "none" };
    case 7:
      return { t: "character.create", character: { id: `c-${id}`, name: "Hero", size: "medium", ownerIds: [], actor: actor() } };
    case 8:
      return { t: "character.delete", characterId: characterIds.length > 0 ? pick(r, characterIds) : "none" };
    case 9: {
      const here = tokenIds.filter((t) => state.tokens[t]?.sceneId === sceneId);
      const attachedTo = here.length > 0 && chance(r, 0.5) ? pick(r, here) : undefined;
      const casterId = tokenIds.length > 0 && chance(r, 0.5) ? pick(r, tokenIds) : undefined;
      return {
        t: "template.create",
        template: {
          id: `a-${id}`,
          sceneId,
          shape: "sphere",
          size: 10,
          origin: { x: 2, y: 2, z: 0 },
          yaw: 0,
          includeOrigin: true,
          color: "#ff0000",
          ownerId: "dmA",
          visibility: "all",
          ...(attachedTo === undefined ? {} : { attachedTo }),
          ...(casterId === undefined ? {} : { casterId }),
        },
      };
    }
    case 10:
      return {
        t: "drawing.create",
        drawing: { id: `d-${id}`, sceneId, kind: "line", points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 1, opacity: 1 }, ownerId: "dmA", visibility: "all" },
      };
    case 11:
      return chance(r, 0.5)
        ? { t: "fog.live", sceneId, ops: [{ id: `f-${id}`, mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }] }
        : { t: "fog.draft", sceneId, add: [{ id: `f-${id}`, mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }] };
    case 12:
      return { t: "template.delete", templateId: templateIds.length > 0 ? pick(r, templateIds) : "none" };
    case 13:
      return { t: "encounter.remove", entryIds: [entryIds.length > 0 ? pick(r, entryIds) : "none"] };
    default: {
      const of = r();
      const entry =
        characterIds.length > 0 && of < 0.4
          ? { id: `n-${id}`, characterId: pick(r, characterIds), value: 10 }
          : tokenIds.length > 0 && of < 0.8
            ? { id: `n-${id}`, tokenId: pick(r, tokenIds), value: 12 }
            : { id: `n-${id}`, label: "Lair", value: 20 };
      return state.encounter ? { t: "encounter.add", entries: [entry] } : { t: "encounter.start", entries: [entry] };
    }
  }
}
