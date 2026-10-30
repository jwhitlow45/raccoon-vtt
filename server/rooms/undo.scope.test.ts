import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { chunkKey } from "#shared/keys.ts";
import { LIMITS } from "#shared/limits.ts";
import { cutLine } from "#shared/logRings.ts";
import type { Actor, RoomState, Viewer } from "#shared/model.ts";
import { withCellVision } from "#shared/perPlayerTestutil.ts";
import { expectHash } from "#shared/permissions.ts";
import { projectArchivedLog, projectLogEntry, projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import type { HistoryScope } from "#shared/undoContract.ts";
import { DM, P1, P2, character, comparable, env, room, scene, template, token, trap } from "#shared/testutil.ts";
import { UndoStacks } from "./undo.ts";
import { scopeActor, scopeFixture, scopeObserver, until, type ScopeClient } from "./undoScopeTesting.ts";

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
      for (const admission of ["quota", "replay", "rate"] as const) for (const scope of (role === "dm" ? ["play", "setup"] : ["play"]) as HistoryScope[]) {
        test(`${role} ${scope} ${direction}: ${admission} refusal preserves both stacks and ids`, async (t) => {
          const f = scopeFixture();
          const h = await scopeActor(t, f.state);
          let now = 0;
          const client = await h.connect(role === "dm" ? f.dm : f.player, role, () => now);
          await client.apply(scope === "setup" ? ac(f.goblin) : { t: "token.move", tokenId: f.pc, x: 10, y: 3 });
          if (direction === "redo") await client.restore(scope);
          const histories = client.history();
          const before = h.actor.committed.state;
          const command = { t: direction, scope, head: client.head(scope, direction).id };
          if (admission === "rate") {
            while (client.conn.opRate.allow()) { /* Spend only this connection's burst. */ }
            const n = ++client.n;
            await h.actor.op(client.conn, n, command);
            assert.ok(client.sent.some((m) => m.t === "retry" && m.n === n && m.code === "busy"));
            unchanged(before, h.actor.committed.state);
            assert.deepEqual(client.history().play, histories.play);
            assert.deepEqual(client.history().setup, histories.setup);
            now += 10_000;
            await h.actor.op(client.conn, n, command);
            const answer = await until(() => client.sent.find((m) => m.t === "ev" && (m.acks?.includes(n) || m.rejects?.some((r) => r.n === n))), "retry after rate admission recovers");
            assert.ok(answer.t === "ev" && answer.acks?.includes(n), "the original command number and head still succeed");
          } else {
            // A load failure normally precedes history. Force only its admission flag to isolate preservation of existing stacks.
            if (admission === "replay") Object.defineProperty(h.actor, "replayFailed", { value: true, configurable: true });
            else h.actor.readOnly = true;
            try {
              const event = await client.send(command);
              assert.equal(event.rejects?.[0]?.code, "quota");
              unchanged(before, h.actor.committed.state);
              assert.deepEqual(client.history().play, histories.play);
              assert.deepEqual(client.history().setup, histories.setup);
            } finally {
              if (admission === "replay") Object.defineProperty(h.actor, "replayFailed", { value: false });
              else h.actor.readOnly = false;
            }
            await client.restore(scope, direction);
          }
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

  for (const scope of ["play", "setup"] as const) test(`${scope} gesture splits after an intervening action in the other scope`, async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const second = await h.connect(f.dm);
    const group = uuidv7();
    const declaration = scope === "setup" ? "setup" : undefined;
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 5, y: 3 }, group, declaration);
    const first = dm.head(scope).id;
    await second.apply(scope === "play" ? { t: "room.update", name: "Interruption" } : { t: "token.move", tokenId: f.pc, x: 9, y: 3 });
    await dm.apply({ t: "token.move", tokenId: f.goblin, x: 6, y: 3 }, group, declaration);
    assert.equal(dm.history()[scope]!.undo.depth, 2, "an old group id cannot merge across the intervening scope");
    assert.notEqual(dm.head(scope).id, first);
    await dm.restore(scope);
    assert.equal(h.actor.committed.state.tokens[f.goblin]!.x, 5, "only the resumed gesture's part is restored");
    assert.equal(dm.head(scope).id, first);
    assert.equal(dm.history()[scope === "play" ? "setup" : "play"]!.undo.depth, 1);
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
    ]) {
      await dm.apply(op);
      assert.deepEqual(dm.history().play, before.play, `${op.t} preserves Play Redo`);
      assert.deepEqual(dm.history().setup, before.setup, `${op.t} preserves Setup Redo`);
    }
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

  for (const scope of ["play", "setup"] as const) for (const direction of ["undo", "redo"] as const) for (const refreshed of [false, true]) {
    test(`${scope} ${direction}: forget confirmation preserves the head and checks current memory${refreshed ? " after the party revisits" : " before forgetting"}`, async (t) => {
      const f = scopeFixture();
      const elsewhere = uuidv7();
      f.state.scenes[elsewhere] = scene(elsewhere);
      f.state.meta.playerSceneId = elsewhere;
      f.state.scenes[f.sceneId] = { ...f.state.scenes[f.sceneId]!, bounds: { w: 80, h: 64 }, fogEnabled: true, autoWalls: "all", blockMovement: true, vision: { on: true, light: "bright" } };
      for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 5; tx++) {
        f.state.exploredTiles[`${f.sceneId}:${tx},${ty}`] = { sceneId: f.sceneId, tx, ty, rev: 0, bits: encodeTile(fullTileBits()) };
        const cells: Record<string, "stone"> = {};
        for (let y = ty * 16; y < ty * 16 + 16; y++) for (let x = tx * 16; x < tx * 16 + 16; x++) cells[`${x},${y}`] = "stone";
        f.state.buildChunks[chunkKey(f.sceneId, tx, ty)] = { sceneId: f.sceneId, cx: tx, cy: ty, rev: 0, cells, edges: {} };
      }
      const h = await scopeActor(t, f.state);
      const dm = await h.connect(f.dm);
      const other = await h.connect(f.otherDm);
      const visit = async () => {
        await other.apply({ t: "room.setPlayerScene", sceneId: f.sceneId });
        await other.apply({ t: "room.setPlayerScene", sceneId: elsewhere });
      };
      await dm.apply({ t: "build.rect", sceneId: f.sceneId, terrain: "wood", x: 0, y: 0, w: 80, h: 16 }, scope === "setup" ? uuidv7() : undefined, scope === "setup" ? "setup" : undefined);
      if (direction === "redo") await dm.restore(scope);
      await visit();
      for (let y = 16; y < 64; y += 16) await other.apply({ t: "build.rect", sceneId: f.sceneId, terrain: "grass", x: 0, y, w: 80, h: 16 });
      const head = dm.head(scope, direction).id;
      const before = h.actor.committed.state;
      const histories = { play: dm.history().play, setup: dm.history().setup };
      const asked = await dm.send({ t: direction, scope, head });
      assert.equal(asked.rejects?.[0]?.code, "forget");
      const question = dm.n;
      unchanged(before, h.actor.committed.state);
      assert.deepEqual({ play: dm.history().play, setup: dm.history().setup }, histories, "cancel and pending confirmation consume nothing");
      const wrong = await dm.send({ t: direction, scope, head, forget: question - 1 });
      assert.equal(wrong.rejects?.[0]?.code, "invalid");
      unchanged(before, h.actor.committed.state);
      if (refreshed) await visit();
      const explored = h.actor.committed.state.exploredTiles;
      await dm.apply({ t: direction, scope, head, forget: question });
      assert.equal(h.actor.committed.state.buildChunks[chunkKey(f.sceneId, 0, 0)]?.cells["0,0"], direction === "undo" ? "stone" : "wood");
      if (refreshed) assert.deepEqual(h.actor.committed.state.exploredTiles, explored, "a valid old yes cannot forget memory that no longer needs forgetting");
      else assert.notDeepEqual(h.actor.committed.state.exploredTiles, explored, "the confirmed restore performs the necessary forgetting");
      assert.notEqual(dm.history()[scope]![direction].head?.id, head);
    });
  }

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

describe("history while asset lookup waits", () => {
  for (const scope of ["play", "setup"] as const) for (const direction of ["undo", "redo"] as const) {
    for (const interference of ["replace", "other-scope", "no-effect", "read-only"] as const) {
      // The original replaced-step test also checks that a known stale head skips the next lookup.
      if (scope === "play" && direction === "undo" && interference === "replace") continue;
      test(`${scope} ${direction} asset wait: ${interference}`, async (t) => {
        const f = scopeFixture();
        const assetId = uuidv7();
        const image = { assetId, crop: { cx: 0, cy: 0, zoom: 1 } };
        f.state.tokens[f.goblin]!.image = image;
        const { rev: _rev, fogExemptAuto: _auto, ...created } = f.state.tokens[f.goblin]!;
        if (direction === "redo") {
          if (scope === "play") delete f.state.tokens[f.goblin];
          else delete f.state.tokens[f.goblin]!.image;
        }
        const h = await scopeActor(t, f.state);
        h.db.assetRows = [{ id: assetId, room_id: "UNDOSCOPE", kind: "token", width: 128, height: 128, uploaders: [f.dm.id] }];
        const dm = await h.connect(f.dm);
        const other = await h.connect(f.dm);
        if (direction === "undo") {
          await dm.apply(scope === "play" ? { t: "token.delete", tokenId: f.goblin } : { t: "token.update", tokenId: f.goblin, patch: { image: null } });
        } else {
          await dm.apply(scope === "play" ? { t: "token.create", token: created } : { t: "token.update", tokenId: f.goblin, patch: { image } });
          await dm.restore(scope);
        }
        const old = dm.head(scope, direction).id;
        let release!: () => void;
        let started = false;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        t.after(release);
        h.db.beforeAssets = async () => { started = true; await gate; };
        const pending = dm.send({ t: direction, scope, head: old });
        await until(() => started || undefined, "asset lookup");
        const play = { t: "token.move", tokenId: f.pc, x: 10, y: 3 };
        const setup = { t: "room.update", name: "Changed room" };
        try {
          if (interference === "replace") {
            await other.apply(scope === "play" ? play : setup);
            if (direction === "redo") await other.restore(scope);
          } else if (interference === "other-scope") {
            await other.apply(scope === "play" ? setup : play);
          } else if (interference === "no-effect") {
            await other.apply({ t: "token.move", tokenId: f.pc, x: 8, y: 3 });
          } else h.actor.readOnly = true;
        } finally {
          release();
        }
        const before = h.actor.committed.state;
        const beforeHistory = other.history()[scope];
        const event = await pending;
        if (interference === "replace" || interference === "read-only") {
          assert.equal(event.rejects?.length, 1);
          unchanged(before, h.actor.committed.state);
          assert.deepEqual(dm.history()[scope], beforeHistory, "replacement or admission refusal preserves the current head");
        } else {
          assert.equal(event.rejects?.length ?? 0, 0, JSON.stringify(event.rejects));
          assert.ok(h.actor.committed.state.tokens[f.goblin]!.image, "restore keeps the looked-up image");
          assert.notEqual(dm.head(scope, direction === "undo" ? "redo" : "undo").id, old, "transfer gets a fresh head");
        }
      });
    }
  }
});

describe("history delivery windows and observer isolation", () => {
  test("commit waits, reconnects and duplicate acks keep every history behind its committed view", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const peer = await h.connect(f.dm);
    const display = await scopeObserver(h.actor, { memberId: "display:abcdefghijkl", role: "player", display: true });
    const preview = await scopeObserver(h.actor, { memberId: f.dm.id, role: "dm", previewOf: f.player.id });
    await dm.apply({ t: "character.update", characterId: f.bree, patch: { level: 4 } });
    const old = dm.history();
    let release!: () => void;
    let waiting = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    t.after(release);
    h.db.beforeCommit = async () => { waiting = true; await gate; };
    const pending = dm.restore("setup");
    await until(() => waiting || undefined, "commit wait");
    let reconnect: ReturnType<typeof h.connect>;
    let queued: ReturnType<ScopeClient["send"]>;
    try {
      assert.deepEqual(peer.history().setup, old.setup);
      reconnect = h.connect(f.dm);
      queued = peer.send({ t: "undo", scope: "setup", head: old.setup!.undo.head!.id });
      assert.deepEqual(dm.history(), old);
    } finally {
      release();
    }
    await pending;
    const joined = await reconnect;
    assert.equal((await queued).rejects?.length, 1, "a queued old head cannot consume the transferred head");
    assert.deepEqual(joined.history().setup, dm.history().setup);
    await h.actor.op(dm.conn, dm.n, { t: "undo", head: old.setup!.undo.head!.id, scope: "setup" });
    for (const client of [dm, peer, joined]) {
      let covered = -1;
      let serial = -1;
      let seq = -1;
      let watermark = -1;
      for (const message of client.sent) {
        if (message.t === "snapshot" || message.t === "ev") covered = message.seq;
        if (message.t !== "history") continue;
        assert.equal(message.seq, covered, "history follows a covering view");
        assert.ok(message.serial >= serial && message.seq >= seq && message.watermark >= watermark, "coverage never regresses");
        serial = message.serial;
        seq = message.seq;
        watermark = message.watermark;
      }
    }
    for (const client of [display, preview]) {
      assert.equal(client.sent.some((m) => m.t === "history"), false);
      const bytes = JSON.stringify(client.sent);
      assert.ok(!bytes.includes(old.setup!.undo.head!.id));
      assert.ok(!bytes.includes(old.setup!.undo.head!.label));
      assert.ok(!bytes.includes('"correction":['));
    }
  });

  test("a snapshot and duplicate ack during the batch window expose only committed heads", async (t) => {
    const f = scopeFixture();
    // A long batch window lets the explicit queue barrier flush each batch without racing the timer.
    const h = await scopeActor(t, f.state, { batchMs: 60_000 });
    const dm = await h.connect(f.dm);
    const flush = () => h.actor.deletionStep(async () => ({ deleted: [], result: undefined }));
    await h.actor.op(dm.conn, ++dm.n, { t: "token.move", tokenId: f.goblin, x: 5, y: 3 });
    await flush();
    const before = dm.history();
    await h.actor.op(dm.conn, ++dm.n, { t: "token.update", tokenId: f.goblin, patch: { name: "Staged private label" } });
    await h.actor.op(dm.conn, 1, { t: "token.move", tokenId: f.goblin, x: 5, y: 3 });
    assert.deepEqual(dm.history(), before, "a duplicate ack does not pair the old view with staged heads");
    const joined = await h.connect(f.dm);
    assert.equal(joined.history().serial, before.serial);
    assert.deepEqual(joined.history().setup, before.setup);
    assert.equal(joined.sent.find((m) => m.t === "snapshot")!.seq, before.seq);
    await flush();
    assert.equal(joined.history().setup?.undo.depth, 1);
    assert.ok(joined.history().serial > before.serial);
  });
});

test("no-effect histories ignore revision-only writes but keep every guard in mixed effects", () => {
  const stacks = new UndoStacks();
  const old = { id: "a", rev: 1, x: 2 };
  const revision = { key: "token:a", value: old, expectHash: guardHash("token:a", { ...old, rev: 2 }) };
  const changed = { key: "token:b", value: { id: "b", rev: 1, x: 1 }, expectHash: guardHash("token:b", { id: "b", rev: 2, x: 2 }) };
  stacks.push("dm", [revision], "no effect");
  assert.equal(stacks.depth("dm").undo, 0);
  stacks.push("dm", [revision, changed], "mixed");
  assert.deepEqual(stacks.peek("dm", "undo")!.entries, [revision, changed]);
});

test("8 KiB evidence cap can hide a large notice when its retained witnesses lose access", () => {
  const state = room();
  const witnesses = Array.from({ length: 150 }, (_, i) => ({ key: `character:c${i}`, owner: true, name: "A".repeat(200) }));
  for (let i = 0; i < 150; i++) state.characters[`c${i}`] = character(`c${i}`, { ownerIds: ["p1"] });
  const entry = cutLine({ id: "2:0", at: "2026-10-29T00:00:00Z", kind: "event", to: ["p1"], copyOf: "2:1", data: { type: "correction", from: "undo", scope: "setup" }, parts: { correction: witnesses } });
  assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= LIMITS.apartLineBytes);
  const kept = entry.parts!.correction!;
  assert.ok(kept.length > 0 && kept.length < witnesses.length);
  assert.deepEqual(kept, witnesses.slice(0, kept.length), "trimming preserves a prefix of the frozen evidence");
  assert.ok(projectLogEntry(state, entry, P1, { sceneId: null }));
  for (const witness of kept) state.characters[witness.key.slice("character:".length)]!.ownerIds = [];
  assert.equal(projectLogEntry(state, entry, P1, { sceneId: null }), null, "readable omitted witnesses do not expand authorization");
  assert.deepEqual(projectArchivedLog(state, [entry], P1, { sceneId: null }), []);
  assert.equal(projectLogEntry(state, entry, P2, { sceneId: null }), null);
});

test("per-player sight freezes correction recipients and narrows later live and archive reads", () => {
  withCellVision(() => {
    const state = room({
      scenes: { s1: scene("s1", { vision: { on: true, light: "bright", perPlayer: true } }) },
      tokens: {
        a: token("a", { ownerIds: ["p1"], kind: "pc", x: 1, y: 2 }),
        b: token("b", { ownerIds: ["p2"], kind: "pc", x: 20, y: 20 }),
        target: token("target", { x: 3, y: 3, hpVisibility: "exact", name: "Private creature name", nameHidden: true }),
      },
      holders: { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } },
    });
    const hit = applyOp(state, { t: "actor.hp", target: { tokenId: "target" }, change: { kind: "damage", amount: 5 } }, DM, env(1));
    assert.ok(hit.ok);
    const undo = applyOp(hit.state, { t: "sys.restore", entries: hit.inverse!, from: "undo", scope: "play", correction: { label: "Private label" }, deps: true }, DM, env(2));
    assert.ok(undo.ok);
    const notices = (current: RoomState, viewer: Viewer) => projectArchivedLog(current, undo.log, viewer, { sceneId: null }).filter((e) => e.data?.type === "correction");
    assert.equal(notices(undo.state, P1).length, 1);
    assert.equal(notices(undo.state, P2).length, 0);
    assert.deepEqual(projectState(undo.state, P2, { sceneId: null }), projectState(hit.state, P2, { sceneId: null }), "an invisible correction changes no projected counters");
    assert.ok(!JSON.stringify(notices(undo.state, P1)).includes("Private"));
    const hiddenHp = applyOp(undo.state, { t: "token.update", tokenId: "target", patch: { hpVisibility: "hidden" } }, DM, env(3));
    assert.ok(hiddenHp.ok);
    assert.equal(notices(hiddenHp.state, P1).length, 0, "lost field permission narrows archive access");
    const gained = applyOp(undo.state, { t: "token.move", tokenId: "b", x: 1, y: 1 }, DM, env(3));
    assert.ok(gained.ok);
    assert.equal(notices(gained.state, P2).length, 0, "new sight cannot gain an old notice");
    const lost = applyOp(gained.state, { t: "token.move", tokenId: "a", x: 30, y: 20 }, DM, env(4));
    assert.ok(lost.ok);
    assert.equal(notices(lost.state, P1).length, 0, "lost sight narrows archive access");
    assert.equal(projectState(lost.state, P1, { sceneId: null }).log.filter((e) => e.data?.type === "correction").length, 0);
    const blackout = { ...undo.state, meta: { ...undo.state.meta, view: { ...undo.state.meta.view, blackout: true } } };
    assert.equal(notices(blackout, P1).length, 0, "blackout removes target-based notices");
  });
});
