import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { chunkKey } from "#shared/keys.ts";
import type { Actor, RoomState } from "#shared/model.ts";
import { expectHash } from "#shared/permissions.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import type { HistoryScope } from "#shared/undoContract.ts";
import { comparable, scene, template, token, trap } from "#shared/testutil.ts";
import { scopeActor, scopeFixture, until, type ScopeClient } from "./undoScopeTesting.ts";

function inline(state: RoomState, id: string): Actor {
  const held = state.tokens[id]!.actor;
  assert.ok("inline" in held);
  return held.inline;
}

const damage = (tokenId: string) => ({ t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 4 } });
const ac = (tokenId: string, value = 19) => ({ t: "token.update", tokenId, patch: { actor: { ac: value } } });

function rememberedFixture() {
  const f = scopeFixture();
  f.state.scenes[f.sceneId] = { ...f.state.scenes[f.sceneId]!, bounds: { w: 100, h: 60 }, fogEnabled: true, vision: { on: true, light: "dark" }, blockMovement: true };
  f.state.tokens[f.pc] = { ...f.state.tokens[f.pc]!, disposition: "ally", x: 90, y: 50 };
  f.state.characters[f.bree]!.actor.senses = "Darkvision 30 ft.";
  for (let ty = 0; ty < 3; ty++) for (let tx = 0; tx < 6; tx++) {
    f.state.exploredTiles[`${f.sceneId}:${tx},${ty}`] = { sceneId: f.sceneId, tx, ty, rev: 0, bits: encodeTile(fullTileBits()) };
  }
  for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 6; cx++) {
    const cells: Record<string, "stone"> = {};
    for (let y = cy * 16; y < Math.min(44, cy * 16 + 16); y++) for (let x = cx * 16; x < cx * 16 + 16; x++) cells[`${x},${y}`] = "stone";
    f.state.buildChunks[chunkKey(f.sceneId, cx, cy)] = { sceneId: f.sceneId, cx, cy, rev: 0, cells, edges: {} };
  }
  return f;
}

function unchanged(before: RoomState, after: RoomState): void {
  assert.deepEqual(after, before, "refused history command must not change any game state or log");
}

async function blocked(client: ScopeClient, scope: HistoryScope, direction: "undo" | "redo", prerequisite: { scope: HistoryScope; direction: "undo" | "redo"; buried?: boolean }) {
  const head = client.head(scope, direction);
  const before = client.actor.committed.state;
  const event = await client.send({ t: direction, scope, head: head.id });
  assert.equal(event.rejects?.length, 1, "a conflicting step refuses");
  unchanged(before, client.actor.committed.state);
  const retained = client.head(scope, direction);
  assert.equal(retained.id, head.id, "retention keeps the same expected head");
  assert.equal(retained.retained?.scope, prerequisite.scope);
  assert.equal(retained.retained?.direction, prerequisite.direction);
  assert.equal(retained.retained?.buried, prerequisite.buried ?? false);
  assert.ok(retained.retained.label.length > 0, "the prerequisite has a phrase");
  return retained;
}

describe("scoped history through the room actor", () => {
  test("move Undo and Redo preserve later AC, HP and name edits", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 6, y: 3 });
    await dm.apply({ t: "token.update", tokenId: f.goblin, patch: { name: "Captain", actor: { ac: 19, hp: { cur: 16 } } } });
    assert.equal(dm.history().play.undo.depth, 1);
    assert.equal(dm.history().setup?.undo.depth, 1);
    for (const [direction, x] of [["undo", 3], ["redo", 6]] as const) {
      await dm.restore("play", direction);
      const state = h.actor.committed.state;
      assert.equal(state.tokens[f.goblin]!.x, x);
      assert.equal(state.tokens[f.goblin]!.name, "Captain");
      assert.equal(inline(state, f.goblin).ac, 19);
      assert.equal(inline(state, f.goblin).hp.cur, 16);
    }
  });

  test("pose restore removes custom footprint fields absent before the resize", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.update", tokenId: f.goblin, patch: { size: "custom", w: 2, h: 3 } });
    await dm.apply(ac(f.goblin));
    await dm.restore();
    const restored = h.actor.committed.state.tokens[f.goblin]!;
    assert.equal(restored.size, "medium");
    assert.equal(Object.hasOwn(restored, "w"), false);
    assert.equal(Object.hasOwn(restored, "h"), false);
    assert.equal(inline(h.actor.committed.state, f.goblin).ac, 19);
    await dm.restore("play", "redo");
    assert.equal(h.actor.committed.state.tokens[f.goblin]!.w, 2);
    assert.equal(h.actor.committed.state.tokens[f.goblin]!.h, 3);
  });

  for (const target of ["inline", "character"] as const) {
    for (const setupFirst of [true, false]) {
      test(`${target}: ${setupFirst ? "Setup then damage" : "damage then Setup"} retains the older whole-value step`, async (t) => {
        const f = scopeFixture();
        const h = await scopeActor(t, f.state);
        const dm = await h.connect(f.dm);
        const edit = target === "inline" ? ac(f.goblin) : { t: "character.update", characterId: f.bree, patch: { actor: { ac: 19 } } };
        const hit = damage(target === "inline" ? f.goblin : f.pc);
        await dm.apply(setupFirst ? edit : hit);
        await dm.apply(setupFirst ? hit : edit);
        const older = setupFirst ? "setup" : "play";
        const newer = setupFirst ? "play" : "setup";
        await blocked(dm, older, "undo", { scope: newer, direction: "undo" });
        await dm.restore(newer);
        await dm.restore(older);
        assert.deepEqual(comparable(h.actor.committed.state), comparable(f.state));
      });
    }
  }

  for (const buried of [false, true]) {
    test(`Play Redo requires the other scope's Redo${buried ? " through a buried blocker" : ""}`, async (t) => {
      const f = scopeFixture();
      const h = await scopeActor(t, f.state);
      const dm = await h.connect(f.dm);
      if (buried) await dm.apply({ t: "room.update", name: "Earlier setup" });
      await dm.apply(ac(f.goblin));
      const setupLabel = dm.head("setup").label;
      await dm.apply(damage(f.goblin));
      await dm.restore("play");
      await dm.restore("setup");
      if (buried) await dm.restore("setup");
      const retained = await blocked(dm, "play", "redo", { scope: "setup", direction: "redo", buried });
      assert.equal(retained.retained?.label, setupLabel);
      if (buried) await dm.restore("setup", "redo");
      await dm.restore("setup", "redo");
      await dm.restore("play", "redo");
      assert.equal(inline(h.actor.committed.state, f.goblin).ac, 19);
      assert.equal(inline(h.actor.committed.state, f.goblin).hp.cur, 16);
    });
  }

  test("new Setup preserves Play Redo and blocks it until Setup Undo", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply(damage(f.goblin));
    await dm.restore();
    const redo = dm.head("play", "redo").id;
    await dm.apply(ac(f.goblin));
    assert.equal(dm.head("play", "redo").id, redo);
    await blocked(dm, "play", "redo", { scope: "setup", direction: "undo" });
    await dm.restore("setup");
    await dm.restore("play", "redo");
    assert.equal(inline(h.actor.committed.state, f.goblin).hp.cur, 16);
  });

  test("an external change to the same key is not attributed to an older own Setup value", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const other = await h.connect(f.otherDm);
    await dm.apply(damage(f.goblin));
    await dm.apply(ac(f.goblin));
    await other.apply(ac(f.goblin, 21));
    const before = h.actor.committed.state;
    const event = await dm.send({ t: "undo", head: dm.head().id });
    assert.equal(event.rejects?.length, 1);
    unchanged(before, h.actor.committed.state);
    assert.deepEqual(dm.history().play, { undo: { head: null, depth: 0 }, redo: { head: null, depth: 0 } });
    assert.equal(dm.history().setup?.undo.depth, 1);
  });

  test("Retry recomputes attribution and drops a retained step after an external edit", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const other = await h.connect(f.otherDm);
    await dm.apply(damage(f.goblin));
    await dm.apply(ac(f.goblin));
    const retained = await blocked(dm, "play", "undo", { scope: "setup", direction: "undo" });
    await other.apply(ac(f.goblin, 21));
    const before = h.actor.committed.state;
    assert.equal((await dm.send({ t: "undo", head: retained.id })).rejects?.length, 1);
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.history().play.undo.depth, 0);
    assert.equal(dm.history().play.redo.depth, 0);
  });

  test("Discard requires retention and the exact head, and changes no game state", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply(damage(f.goblin));
    const original = dm.head().id;
    const before = h.actor.committed.state;
    assert.equal((await dm.send({ t: "undo", head: original, discard: true })).rejects?.length, 1);
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.head().id, original);
    await dm.apply(ac(f.goblin));
    await blocked(dm, "play", "undo", { scope: "setup", direction: "undo" });
    const retainedState = h.actor.committed.state;
    assert.equal((await dm.send({ t: "undo", head: uuidv7(), discard: true })).rejects?.length, 1);
    assert.equal(dm.head().id, original);
    await dm.apply({ t: "undo", head: original, discard: true });
    unchanged(retainedState, h.actor.committed.state);
    assert.equal(dm.history().play.undo.depth, 0);
    assert.equal(dm.history().play.redo.depth, 0);
    assert.equal(dm.history().setup?.undo.depth, 1);
  });

  for (const role of ["dm", "player"] as const) {
    for (const direction of ["undo", "redo"] as const) {
      for (const scope of (role === "dm" ? ["play", "setup"] : ["play"]) as HistoryScope[]) {
        test(`${role} ${scope} ${direction}: quota refusal preserves both stacks and ids`, async (t) => {
          const f = scopeFixture();
          const h = await scopeActor(t, f.state);
          const client = await h.connect(role === "dm" ? f.dm : f.player);
          await client.apply(scope === "setup" ? ac(f.goblin) : { t: "token.move", tokenId: f.pc, x: 10, y: 3 });
          if (direction === "redo") await client.restore(scope);
          const histories = client.history();
          const before = h.actor.committed.state;
          h.actor.readOnly = true;
          const event = await client.send({ t: direction, scope, head: client.head(scope, direction).id });
          assert.equal(event.rejects?.[0]?.code, "quota");
          unchanged(before, h.actor.committed.state);
          assert.deepEqual(client.history().play, histories.play);
          assert.deepEqual(client.history().setup, histories.setup);
          h.actor.readOnly = false;
          await client.restore(scope, direction);
        });
      }
    }
  }

  test("a merged gesture rotates its head and a stale command consumes neither step", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const group = uuidv7();
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 4, y: 3 }, group);
    const first = dm.head().id;
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 5, y: 3 }, group);
    const second = dm.head().id;
    assert.notEqual(second, first);
    assert.equal(dm.history().play.undo.depth, 1);
    const before = h.actor.committed.state;
    assert.equal((await dm.send({ t: "undo", head: first })).rejects?.length, 1);
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.head().id, second);
    await dm.restore();
    assert.equal(h.actor.committed.state.tokens[f.goblin]!.x, 3);
    assert.notEqual(dm.head("play", "redo").id, second);
  });

  test("None and no-effect edits preserve both Redo stacks", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 5, y: 3 });
    await dm.apply({ t: "room.update", name: "Setup name" });
    await dm.restore("setup");
    await dm.restore("play");
    const before = dm.history();
    for (const op of [
      { t: "member.update", memberId: f.dm.id, name: "Renamed DM" },
      { t: "token.move", tokenId: f.goblin, x: 3, y: 3 },
      { t: "room.update", name: f.state.meta.name },
      { t: "log.chat", text: "Keep both redo steps" },
    ]) await dm.apply(op);
    assert.deepEqual(dm.history().play, before.play);
    assert.deepEqual(dm.history().setup, before.setup);
  });

  test("HP Log correction remains available after a whole-value conflict and creates no Redo", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply(damage(f.goblin));
    const hp = h.actor.committed.state.log.find((line) => line.data?.type === "hp" && line.data.revert);
    assert.ok(hp);
    await dm.apply(ac(f.goblin));
    await blocked(dm, "play", "undo", { scope: "setup", direction: "undo" });
    const before = dm.history();
    await dm.apply({ t: "undo", log: hp.id });
    assert.equal(inline(h.actor.committed.state, f.goblin).hp.cur, 20);
    assert.equal(inline(h.actor.committed.state, f.goblin).ac, 19);
    assert.deepEqual(dm.history().play, before.play);
    assert.deepEqual(dm.history().setup, before.setup);
  });

  test("a mixed Setup pose blocks Play Undo and its Redo entry blocks Play Redo", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 5, y: 3 });
    await dm.apply({ t: "token.update", tokenId: f.goblin, patch: { x: 7, actor: { ac: 19 } } });
    await blocked(dm, "play", "undo", { scope: "setup", direction: "undo" });
    await dm.restore("setup");
    await dm.restore("play");
    await blocked(dm, "setup", "redo", { scope: "play", direction: "redo" });
    await dm.restore("play", "redo");
    await dm.restore("setup", "redo");
    assert.equal(h.actor.committed.state.tokens[f.goblin]!.x, 7);
    assert.equal(inline(h.actor.committed.state, f.goblin).ac, 19);
  });

  test("a player's answer drops an ordinary ask's stale Undo without a restore or Redo", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const player = await h.connect(f.player);
    const rollId = uuidv7();
    await dm.apply({ t: "roll.ask", request: { id: rollId, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: true, targets: [{ tokenId: f.pc }] } });
    await player.apply({ t: "roll.answer", rollId, target: { tokenId: f.pc }, total: 17, tag: uuidv7() });
    const before = h.actor.committed.state;
    const event = await dm.send({ t: "undo", head: dm.head().id });
    assert.equal(event.rejects?.length, 1);
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.history().play.undo.depth, 0);
    assert.equal(dm.history().play.redo.depth, 0);
  });

  test("an unrecorded server restore is never attributed to an own other-scope value on the same key", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply(damage(f.goblin));
    await dm.apply(ac(f.goblin));
    const changed = structuredClone(h.actor.committed.state.tokens[f.goblin]!);
    assert.ok("inline" in changed.actor);
    changed.actor.inline.ac = 22;
    await h.actor.sys({ t: "sys.restore", entries: [{ key: `token:${f.goblin}`, value: changed }], from: "undo", deps: true });
    const before = h.actor.committed.state;
    assert.equal((await dm.send({ t: "undo", head: dm.head().id })).rejects?.length, 1);
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.history().play.undo.depth, 0);
    assert.equal(dm.history().play.redo.depth, 0);
  });

  test("re-sync and its explicit guarded dialog inverse both belong to Setup", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "character.update", characterId: f.bree, patch: { actor: { ac: 19 }, ddbSync: { base: { ac: 19 }, rolls: {} } } });
    const synced = h.actor.committed.state.characters[f.bree]!;
    assert.ok(synced.ddbSync?.at);
    await dm.apply({ t: "character.update", characterId: f.bree, patch: { actor: { ac: 14 }, ddbSync: null }, expect: { "actor.ac": expectHash(synced, "actor.ac"), ddbSync: expectHash(synced, "ddbSync") } });
    assert.equal(dm.history().play.undo.depth, 0);
    assert.equal(dm.history().setup?.undo.depth, 2);
    assert.equal(h.actor.committed.state.characters[f.bree]!.actor.ac, 14);
    await dm.restore("setup");
    assert.equal(h.actor.committed.state.characters[f.bree]!.actor.ac, 19);
    assert.deepEqual(h.actor.committed.state.characters[f.bree]!.ddbSync, synced.ddbSync);
  });

  test("forget cancellation and a stale yes preserve both memory and the intended Play head", async (t) => {
    const f = rememberedFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const band = (y: number) => ({ t: "build.rect", sceneId: f.sceneId, terrain: "wood", x: 0, y, w: 96, h: 20 });
    await dm.apply(band(0));
    await dm.apply(band(20));
    const head = dm.head().id;
    const before = h.actor.committed.state;
    const question = await dm.send({ t: "undo", head });
    assert.equal(question.rejects?.[0]?.code, "forget");
    const asked = dm.n;
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.head().id, head, "cancel sends no confirmation and leaves the same step");
    const wrongQuestion = await dm.send({ t: "undo", head, forget: asked - 1 });
    assert.equal(wrongQuestion.rejects?.[0]?.code, "invalid");
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.head().id, head);
    await dm.apply({ t: "build.paint", sceneId: f.sceneId, terrain: "grass", cells: ["2,2"] });
    const replacement = dm.head().id;
    const replacedState = h.actor.committed.state;
    assert.equal((await dm.send({ t: "undo", head, forget: asked })).rejects?.[0]?.code, "invalid");
    unchanged(replacedState, h.actor.committed.state);
    assert.equal(dm.head().id, replacement);
  });

  test("controlled attach restores encounter effects together with pose and preserves later AC", async (t) => {
    const f = scopeFixture();
    f.state.tokens[f.goblin] = token(f.goblin, { sceneId: f.sceneId, kind: "npc", name: "Warhorse", size: "large", x: 4, y: 4 });
    f.state.tokens[f.pc] = { ...f.state.tokens[f.pc]!, x: 4, y: 6 };
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "encounter.start", entries: [{ id: "rider", tokenId: f.pc, value: 20 }, { id: "mount", tokenId: f.goblin, value: 8 }] });
    await dm.apply({ t: "encounter.next" });
    const encounter = h.actor.committed.state.encounter;
    await dm.apply({ t: "token.attach", tokenId: f.pc, to: f.goblin, kind: "ride", steer: true, x: 4, y: 5, elevation: 0 });
    assert.notDeepEqual(h.actor.committed.state.encounter, encounter, "fixture includes a non-token inverse");
    await dm.apply(ac(f.goblin));
    await dm.restore();
    assert.equal(h.actor.committed.state.tokens[f.pc]!.attached, undefined);
    assert.equal(h.actor.committed.state.tokens[f.pc]!.y, 6);
    assert.deepEqual(h.actor.committed.state.encounter?.entries, encounter?.entries);
    assert.deepEqual(h.actor.committed.state.encounter?.turnStart, encounter?.turnStart);
    assert.equal(inline(h.actor.committed.state, f.goblin).ac, 19);
    await dm.restore("play", "redo");
    assert.equal(h.actor.committed.state.tokens[f.pc]!.attached?.to, f.goblin);
    assert.ok(h.actor.committed.state.encounter?.turnStart?.mounts?.includes(f.goblin));
  });

  for (const external of [false, true]) {
    test(`attached area scene transfer restores atomically${external ? " and a changed area refuses without moving the token" : " with the token"}`, async (t) => {
      const f = scopeFixture();
      const destination = uuidv7();
      f.state.scenes[destination] = scene(destination, { order: 1 });
      f.state.templates.aura = template("aura", { sceneId: f.sceneId, ownerId: f.dm.id, attachedTo: f.goblin, origin: { x: 3.5, y: 3.5, z: 0 } });
      const h = await scopeActor(t, f.state);
      const dm = await h.connect(f.dm);
      const other = await h.connect(f.otherDm);
      await dm.apply({ t: "token.update", tokenId: f.goblin, patch: { sceneId: destination } });
      assert.equal(h.actor.committed.state.templates.aura!.sceneId, destination);
      await dm.apply(ac(f.goblin));
      if (external) await other.apply({ t: "template.update", templateId: "aura", patch: { size: 30 } });
      const before = h.actor.committed.state;
      const event = await dm.send({ t: "undo", head: dm.head().id });
      if (external) {
        assert.equal(event.rejects?.length, 1);
        unchanged(before, h.actor.committed.state);
        assert.equal(dm.history().play.undo.depth, 0);
        assert.equal(dm.history().play.redo.depth, 0);
      } else {
        assert.equal(event.rejects?.length ?? 0, 0);
        assert.equal(h.actor.committed.state.tokens[f.goblin]!.sceneId, f.sceneId);
        assert.equal(h.actor.committed.state.templates.aura!.sceneId, f.sceneId);
        assert.equal(inline(h.actor.committed.state, f.goblin).ac, 19);
      }
    });
  }

  for (const external of [false, true]) {
    test(`trapped move preserves every trap and reveal inverse${external ? " under atomic refusal" : " on Undo"}`, async (t) => {
      const f = scopeFixture();
      f.state.tokens[f.pc] = { ...f.state.tokens[f.pc]!, x: 3, y: 3 };
      f.state.tokens[f.goblin] = { ...f.state.tokens[f.goblin]!, x: 12, visibility: "dm" };
      const baseTrap = trap("plate", { sceneId: f.sceneId, zone: { cells: [{ x: 4, y: 3, w: 1, h: 1 }] } });
      f.state.traps.plate = { ...baseTrap, rig: { ...baseTrap.rig!, actions: [{ show: { tokenId: f.goblin } }] } };
      const h = await scopeActor(t, f.state);
      const dm = await h.connect(f.dm);
      const other = await h.connect(f.otherDm);
      await dm.apply({ t: "token.move", tokenId: f.pc, x: 6, y: 3 });
      assert.equal(h.actor.committed.state.traps.plate!.state, "sprung");
      assert.equal(h.actor.committed.state.tokens[f.goblin]!.visibility, "all");
      if (external) await other.apply({ t: "trap.update", trapId: "plate", patch: { name: "External trap definition" } });
      const before = h.actor.committed.state;
      const event = await dm.send({ t: "undo", head: dm.head().id });
      if (external) {
        assert.equal(event.rejects?.length, 1);
        unchanged(before, h.actor.committed.state);
        assert.equal(dm.history().play.redo.depth, 0);
      } else {
        assert.equal(event.rejects?.length ?? 0, 0);
        assert.equal(h.actor.committed.state.tokens[f.pc]!.x, 3);
        assert.equal(h.actor.committed.state.tokens[f.goblin]!.visibility, "dm");
        assert.equal(h.actor.committed.state.traps.plate!.state, "armed");
        assert.equal(h.actor.committed.state.traps.plate!.found, false);
      }
    });
  }

  test("each scope retains its own 50 steps even when actions alternate", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const play = await h.connect(f.dm);
    const setup = await h.connect(f.dm);
    for (let i = 0; i < 51; i++) {
      await play.apply({ t: "token.move", tokenId: f.goblin, x: 4 + i % 2, y: 3 });
      await setup.apply({ t: "room.update", name: `Setup ${i}` });
    }
    assert.equal(play.history().play.undo.depth, 50);
    assert.equal(setup.history().setup?.undo.depth, 50);
  });

  test("a step replaced while its asset lookup waits is refused without consuming its replacement", async (t) => {
    const f = scopeFixture();
    const assetId = uuidv7();
    f.state.tokens[f.goblin]!.image = { assetId, crop: { cx: 0, cy: 0, zoom: 1 } };
    const h = await scopeActor(t, f.state);
    h.db.assetRows = [{ id: assetId, room_id: "UNDOSCOPE", kind: "token", width: 128, height: 128, uploaders: [f.dm.id] }];
    const dm = await h.connect(f.dm);
    const second = await h.connect(f.dm);
    await dm.apply({ t: "token.delete", tokenId: f.goblin });
    const old = dm.head().id;
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.db.beforeAssets = async () => { started = true; await gate; };
    t.after(release);
    const pending = dm.send({ t: "undo", head: old });
    await until(() => started || undefined, "asset lookup to begin");
    await second.apply({ t: "token.move", tokenId: f.pc, x: 10, y: 3 });
    const replacement = second.head().id;
    const before = h.actor.committed.state;
    release();
    const event = await pending;
    assert.match(event.rejects?.[0]?.message ?? "", /Play history changed/);
    unchanged(before, h.actor.committed.state);
    assert.equal(dm.head().id, replacement);
    const lookups = h.db.assetLookups;
    assert.equal((await dm.send({ t: "undo", head: old })).rejects?.length, 1);
    assert.equal(h.db.assetLookups, lookups, "a known stale head refuses before another asset lookup");
  });
});

describe("history delivery and legacy commands", () => {
  for (const op of [{ t: "undo" }, { t: "redo" }, { t: "undo", of: 1 }]) {
    test(`legacy ${JSON.stringify(op)} gets a terminal reload refusal and the queue continues`, async (t) => {
      const f = scopeFixture();
      const h = await scopeActor(t, f.state);
      const dm = await h.connect(f.dm);
      await dm.apply({ t: "token.move", tokenId: f.goblin, x: 5, y: 3 });
      const before = h.actor.committed.state;
      const event = await dm.send(op);
      assert.equal(event.rejects?.[0]?.message, "Reload to use Undo");
      unchanged(before, h.actor.committed.state);
      await dm.apply({ t: "token.move", tokenId: f.goblin, x: 7, y: 3 });
      assert.equal(h.actor.committed.state.tokens[f.goblin]!.x, 7);
    });
  }

  test("two devices share heads, co-DMs and players receive only their own histories", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const second = await h.connect(f.dm);
    const coDm = await h.connect(f.otherDm);
    const player = await h.connect(f.player);
    await dm.apply({ t: "token.update", tokenId: f.goblin, patch: { name: "Private setup label" } });
    assert.deepEqual(second.history().setup, dm.history().setup);
    assert.equal(coDm.history().setup?.undo.depth, 0);
    assert.equal(player.history().setup, undefined);
    const privateHead = dm.head("setup");
    for (const client of [coDm, player]) {
      const bytes = JSON.stringify(client.sent.filter((m) => m.t === "history"));
      assert.ok(!bytes.includes(privateHead.id));
      assert.ok(!bytes.includes(privateHead.label));
    }
    await second.restore("setup");
    assert.equal(dm.history().setup?.undo.depth, 0);
    assert.equal(dm.history().setup?.redo.depth, 1);
  });

  test("chat advances coverage without changing serial or invalidating an unchanged head", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 5, y: 3 });
    const before = dm.history();
    const head = dm.head().id;
    const event = await dm.apply({ t: "log.chat", text: "Ready" });
    const after = dm.history();
    assert.equal(after.serial, before.serial);
    assert.equal(after.seq, event.seq);
    assert.ok(after.seq > before.seq);
    assert.equal(after.watermark, dm.n);
    assert.equal(dm.head().id, head);
    await dm.apply({ t: "undo", head });
  });

  test("an ack-only refusal advances watermark at the same sequence and serial", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 5, y: 3 });
    const before = dm.history();
    const event = await dm.send({ t: "undo", head: uuidv7() });
    assert.equal(event.rejects?.length, 1);
    const after = dm.history();
    assert.equal(after.seq, before.seq);
    assert.equal(after.serial, before.serial);
    assert.ok(after.watermark > before.watermark);
    assert.deepEqual(after.play, before.play);
  });

  test("history never publishes a staged head beside the previous committed view", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const before = dm.history();
    let release!: () => void;
    let committing = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.db.beforeCommit = async () => { committing = true; await gate; };
    const pending = dm.apply({ t: "token.move", tokenId: f.goblin, x: 6, y: 3 });
    try {
      await until(() => committing || undefined, "commit to wait");
      assert.equal(h.actor.committed.state.tokens[f.goblin]!.x, 3);
      assert.deepEqual(dm.history(), before);
      assert.equal(dm.sent.some((m) => m.t === "ev" && m.acks?.includes(dm.n)), false);
    } finally {
      release();
    }
    const event = await pending;
    const after = dm.history();
    assert.equal(after.seq, event.seq);
    assert.equal(after.watermark, dm.n);
    assert.ok(after.serial > before.serial);
    assert.equal(after.play.undo.depth, 1);
  });

  test("a token-bar Undo requires matching origin as well as the expected head", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const one = await h.connect(f.player);
    const two = await h.connect(f.player);
    await one.apply({ t: "token.move", tokenId: f.pc, x: 9, y: 3 });
    await two.apply({ t: "token.move", tokenId: f.pc, x: 10, y: 3 });
    const head = one.head().id;
    const before = h.actor.committed.state;
    const event = await one.send({ t: "undo", head, of: 1 });
    assert.equal(event.rejects?.length, 1);
    unchanged(before, h.actor.committed.state);
    assert.equal(one.head().id, head);
    await two.apply({ t: "undo", head, of: 1 });
    assert.equal(h.actor.committed.state.tokens[f.pc]!.x, 9);
  });
});
