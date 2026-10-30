import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { Member, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { serverMessageSchema, type ServerMessage } from "#shared/protocol.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { member, scene, token, trap } from "#shared/testutil.ts";
import { opAcknowledgmentSchema, type OpAcknowledgment } from "#shared/undoContract.ts";
import { scopeActor, scopeFixture, scopeObserver, until, type ScopeClient } from "./undoScopeTesting.ts";

type Event = Extract<ServerMessage, { t: "ev" }>;
const oldEventSchema = serverMessageSchema.options.find((schema): schema is Extract<typeof schema, { shape: { t: { value: "ev" } } }> => schema.shape.t.value === "ev")!.omit({ ackDetails: true });

function details(event: Event | undefined, expected: OpAcknowledgment[]): void {
  assert.ok(event, "the sender receives its committed acknowledgment event");
  assert.ok(serverMessageSchema.safeParse(event).success);
  assert.deepEqual(event.ackDetails, expected.map((detail) => ({ recorded: detail.changed && detail.scope !== "none", ...detail })), "details describe exactly this client's accepted operations");
  for (const detail of expected) assert.ok(event.acks?.includes(detail.n), "each detail has a matching ack");
}

async function ackActor(t: TestContext, state: RoomState, buffered = false) {
  // The queue barrier flushes buffered batches explicitly, before the long batch timer can race the assertions.
  const h = await scopeActor(t, state, buffered ? { batchMs: 60_000 } : {});
  return {
    ...h,
    connect: (who: Member) => h.connect(who, undefined, undefined, true),
    flush: () => h.actor.deletionStep(async () => ({ deleted: [], result: undefined })),
  };
}

function ack(client: ScopeClient, n: number): Event | undefined {
  return client.sent.findLast((message): message is Event => message.t === "ev" && Boolean(message.acks?.includes(n)));
}

test("mixed-device and server-op batches give each sending client only its own details", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state, true);
  const dm = await h.connect(f.dm);
  const second = await h.connect(f.dm);
  const co = await h.connect(f.otherDm);
  const player = await h.connect(f.player);
  const display = await scopeObserver(h.actor, { memberId: "display:abcdefghijkl", role: "player", display: true }, true);
  const preview = await scopeObserver(h.actor, { memberId: f.dm.id, role: "dm", previewOf: f.player.id }, true);
  await h.actor.op(dm.conn, ++dm.n, { t: "room.update", name: "Saved setup" });
  await h.actor.op(co.conn, ++co.n, { t: "token.move", tokenId: f.goblin, x: 6, y: 3 });
  await h.actor.op(player.conn, ++player.n, { t: "token.move", tokenId: f.pc, x: 9, y: 3 });
  const { rev: _rev, ...joined } = member(uuidv7());
  const system = h.actor.sys({ t: "sys.memberJoin", member: joined });
  for (const client of [dm, second, co, player, display, preview]) assert.equal(client.sent.some((m) => m.t === "ev" && m.ackDetails !== undefined), false);
  await h.flush();
  await system;
  for (const [client, scope] of [[dm, "setup"], [co, "play"], [player, "play"]] as const) details(ack(client, 1), [{ n: 1, scope, changed: true }]);
  for (const observer of [second, display, preview]) assert.equal(observer.sent.some((m) => m.t === "ev" && m.ackDetails !== undefined), false, "another device, display or View as receives no sender details");
});

test("per-op changes survive mixed batching even when later writes cancel them", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state, true);
  const dm = await h.connect(f.dm);
  for (const name of ["Different", "Different", f.state.meta.name]) await h.actor.op(dm.conn, ++dm.n, { t: "room.update", name });
  await h.flush();
  details(ack(dm, 3), [
    { n: 1, scope: "setup", changed: true },
    { n: 2, scope: "setup", changed: false },
    { n: 3, scope: "setup", changed: true },
  ]);
  assert.equal(h.actor.committed.state.meta.name, f.state.meta.name);
});

test("declared Setup gestures promote their first Play part and retain that scope on no-effect parts", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state, true);
  const dm = await h.connect(f.dm);
  const group = uuidv7();
  await h.actor.op(dm.conn, ++dm.n, { t: "token.move", tokenId: f.goblin, x: 6, y: 3 }, group, "setup");
  for (let i = 0; i < 2; i++) await h.actor.op(dm.conn, ++dm.n, { t: "token.move", tokenId: f.goblin, x: 7, y: 3 }, group);
  await h.flush();
  details(ack(dm, 3), [
    { n: 1, scope: "setup", changed: true },
    { n: 2, scope: "setup", changed: true },
    { n: 3, scope: "setup", changed: false },
  ]);
  assert.equal(dm.history().setup?.undo.depth, 1);
  assert.equal(dm.history().play.undo.depth, 0);
});

test("contradictory gesture parts refuse without state changes or acknowledgment details", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  const group = uuidv7();
  details(await dm.apply({ t: "token.move", tokenId: f.goblin, x: 6, y: 3 }, group), [{ n: 1, scope: "play", changed: true }]);
  const before = h.actor.committed.state;
  const history = dm.history();
  const event = await dm.send({ t: "room.update", name: "Must not apply" }, group);
  assert.equal(event.rejects?.length, 1);
  assert.equal(event.ackDetails, undefined);
  assert.deepEqual(h.actor.committed.state, before);
  assert.deepEqual(dm.history().play, history.play);
  assert.deepEqual(dm.history().setup, history.setup);
});

test("classification uses the accepted before-state and revision-only saves are no-effect", async (t) => {
  const f = scopeFixture();
  const actor = f.state.tokens[f.goblin]!.actor;
  assert.ok("inline" in actor);
  actor.inline.legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  const op = { t: "token.update", tokenId: f.goblin, patch: { actor: { legendary: { actionsMax: 4, actionsUsed: 1, resistMax: 3, resistUsed: 0 } } } };
  details(await dm.apply(op), [{ n: 1, scope: "setup", changed: true }]);
  details(await dm.apply(op), [{ n: 2, scope: "play", changed: false }]);
  details(await dm.apply({ t: "token.update", tokenId: f.goblin, patch: { name: f.state.tokens[f.goblin]!.name } }), [{ n: 3, scope: "setup", changed: false }]);
  details(await dm.apply({ t: "token.move", tokenId: f.goblin, x: 3, y: 3 }), [{ n: 4, scope: "play", changed: false }]);
  details(await dm.apply({ t: "room.update", name: f.state.meta.name }), [{ n: 5, scope: "setup", changed: false }]);
  details(await dm.apply({ t: "log.chat", text: "Hello" }), [{ n: 6, scope: "none", changed: true }]);
});

for (const retry of [false, true]) test(`acknowledgment details wait for a ${retry ? "retried" : "delayed"} commit and refusals carry none`, async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  const rejected = await dm.send({ t: "undo", head: uuidv7() });
  assert.equal(rejected.rejects?.length, 1);
  assert.equal(rejected.ackDetails, undefined);
  let release!: () => void;
  let waiting = false;
  let attempts = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(release);
  h.db.beforeCommit = async () => {
    attempts++;
    if (retry && attempts === 1) throw new Error("injected commit failure");
    waiting = true;
    await gate;
  };
  const pending = dm.apply({ t: "room.update", name: "Committed name" });
  try {
    await until(() => waiting || undefined, "commit wait");
    assert.equal(dm.sent.some((m) => m.t === "ev" && m.ackDetails?.some((d) => d.n === 2)), false);
    assert.equal(dm.sent.some((m) => m.t === "ev" && m.acks?.includes(2)), false);
    assert.equal(h.actor.committed.state.meta.name, f.state.meta.name);
    assert.equal(attempts, retry ? 2 : 1);
  } finally {
    release();
  }
  const event = await pending;
  details(event, [{ n: 2, scope: "setup", changed: true }]);
  assert.equal(h.db.durableMax, event.seq);
});

test("retained discard and successful stack and HP Log restores report their own effect", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  await dm.apply({ t: "actor.hp", target: { tokenId: f.goblin }, change: { kind: "damage", amount: 4 } });
  const hp = h.actor.committed.state.log.find((line) => line.data?.type === "hp" && line.data.revert);
  assert.ok(hp);
  await dm.apply({ t: "token.update", tokenId: f.goblin, patch: { actor: { ac: 19 } } });
  const head = dm.head().id;
  const refused = await dm.send({ t: "undo", head });
  assert.equal(refused.rejects?.length, 1);
  assert.equal(refused.ackDetails, undefined);
  const before = h.actor.committed.state;
  details(await dm.apply({ t: "undo", head, discard: true }), [{ n: 4, scope: "none", changed: false }]);
  assert.deepEqual(h.actor.committed.state, before);
  details(await dm.restore("setup"), [{ n: 5, scope: "none", changed: true }]);
  details(await dm.restore("setup", "redo"), [{ n: 6, scope: "none", changed: true }]);
  details(await dm.apply({ t: "undo", log: hp.id }), [{ n: 7, scope: "none", changed: true }]);
});

test("transport duplicate acknowledgments do not invent or reclassify details", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  details(await dm.apply({ t: "room.update", name: "Committed name" }), [{ n: 1, scope: "setup", changed: true }]);
  const before = h.actor.committed.state;
  const history = dm.history();
  await h.actor.op(dm.conn, 1, { t: "token.move", tokenId: f.goblin, x: 8, y: 3 });
  const duplicate = ack(dm, 1);
  assert.deepEqual(duplicate?.acks, [1]);
  assert.equal(duplicate?.ackDetails, undefined);
  assert.deepEqual(h.actor.committed.state, before, "a duplicate cannot apply the resent payload");
  assert.deepEqual(dm.history(), history);
});

test("receipt duplicates preserve classification and group promotion with no new effect", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state, true);
  const dm = await h.connect(f.dm);
  const group = uuidv7();
  const op = { t: "actor.outcome", plan: uuidv7(), targets: [{ target: { tokenId: f.goblin }, amount: 4 }] };
  await h.actor.op(dm.conn, ++dm.n, op, group, "setup");
  await h.flush();
  details(ack(dm, 1), [{ n: 1, scope: "setup", changed: true }]);
  const before = h.actor.committed.state;
  await h.actor.op(dm.conn, ++dm.n, op, group);
  await h.flush();
  details(ack(dm, 2), [{ n: 2, scope: "setup", changed: false }]);
  await h.actor.op(dm.conn, ++dm.n, op);
  await h.flush();
  details(ack(dm, 3), [{ n: 3, scope: "play", changed: false }]);
  assert.deepEqual(h.actor.committed.state, before);
});

test("build preflight has no state effect and thumbnail changes still count in None", async (t) => {
  const f = scopeFixture();
  f.state.scenes[f.sceneId]!.thumb = uuidv7();
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  const before = h.actor.committed.state;
  details(await dm.apply({ t: "build.ask", sceneId: f.sceneId, ops: [{ t: "build.paint", sceneId: f.sceneId, terrain: "stone", cells: ["1,1"] }], part: 0 }, uuidv7()), [{ n: 1, scope: "none", changed: false }]);
  assert.deepEqual(h.actor.committed.state, before);
  details(await dm.apply({ t: "scene.update", sceneId: f.sceneId, patch: { thumb: null } }), [{ n: 2, scope: "none", changed: true }]);
  details(await dm.apply({ t: "scene.update", sceneId: f.sceneId, patch: { thumb: null } }), [{ n: 3, scope: "none", changed: false }]);
});

test("hello opt-in is per connection and legacy strict events and command queues keep working", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const legacy = await h.connect(f.dm);
  const modern = await h.connect(f.dm, undefined, undefined, true);
  const first = await legacy.apply({ t: "room.update", name: "Old client save" });
  assert.equal(first.ackDetails, undefined);
  assert.ok(oldEventSchema.safeParse(first).success);
  const next = await modern.apply({ t: "room.update", name: "Modern save" });
  details(next, [{ n: 1, scope: "setup", changed: true }]);
  assert.equal(oldEventSchema.safeParse(next).success, false, "the old strict schema rejects the new field");
  assert.equal((await legacy.send({ t: "undo" })).rejects?.[0]?.message, "Reload to use Undo");
  assert.equal((await legacy.apply({ t: "log.chat", text: "Queue continues" })).ackDetails, undefined);
  for (const message of legacy.sent.filter((m) => m.t === "ev")) assert.ok(oldEventSchema.safeParse(message).success);
  const reconnected = await h.connect(f.dm);
  assert.equal((await reconnected.apply({ t: "room.update", name: "No opt-in on reconnect" })).ackDetails, undefined);
  // Re-syncing the same connection also re-negotiates the capability.
  modern.conn.helloAllowed = true;
  await h.actor.hello(modern.conn, { clientId: modern.clientId, resumeFrom: modern.n + 1 });
  assert.equal((await modern.apply({ t: "room.update", name: "No opt-in on resync" })).ackDetails, undefined);
});

test("equal player projections yield equal metadata despite hidden trap and private Log effects", async (t) => {
  const f = scopeFixture();
  f.state.tokens[f.goblin]!.visibility = "dm";
  const privateName = "Private preparation label";
  const trapId = uuidv7();
  const results = [];
  for (const hiddenEffects of [false, true]) {
    const state = structuredClone(f.state);
    if (hiddenEffects) {
      const plate = trap(trapId, { sceneId: f.sceneId, name: "Private trap name", zone: { cells: [{ x: 9, y: 3, w: 1, h: 1 }] } });
      state.traps[trapId] = { ...plate, rig: { ...plate.rig!, stops: false, foundOnSpring: false } };
    }
    const h = await ackActor(t, state, true);
    const dm = await h.connect(f.dm);
    const player = await h.connect(f.player);
    const samePlayer = await h.connect(f.player);
    const before = projectState(h.actor.committed.state, player.conn.viewer, { sceneId: null });
    await h.actor.op(dm.conn, ++dm.n, { t: "token.update", tokenId: f.goblin, patch: { name: privateName } });
    if (hiddenEffects) await h.actor.op(dm.conn, ++dm.n, { t: "log.whisper", to: [f.dm.id], text: "Private Log text" });
    await h.actor.op(player.conn, ++player.n, { t: "token.move", tokenId: f.pc, x: 9, y: 3 });
    await h.flush();
    const event = ack(player, 1);
    details(event, [{ n: 1, scope: "play", changed: true }]);
    assert.deepEqual(event?.acks, [1], "the event acknowledges no other client's command");
    assert.equal(samePlayer.sent.some((m) => m.t === "ev" && m.ackDetails !== undefined), false);
    const committed = h.actor.committed.state;
    const after = projectState(committed, player.conn.viewer, { sceneId: null });
    assert.equal(committed.trapLog.length > 0, hiddenEffects, "only the secret-bearing run has a private trap effect");
    assert.equal(committed.log.some((line) => line.kind === "whisper"), hiddenEffects, "only the secret-bearing run has a private Log write");
    if (hiddenEffects) assert.equal(committed.traps[trapId]!.state, "sprung");
    const serialized = JSON.stringify(player.sent.filter((m) => m.t === "ev"));
    for (const secret of [trapId, f.goblin, f.dm.id, privateName, "Private trap name", "Private Log text", dm.head("setup").id]) assert.ok(!serialized.includes(secret), "no private key, label, head or foreign metadata reaches the player's events");
    assert.deepEqual(Object.keys(event!.ackDetails![0]!).sort(), ["changed", "n", "recorded", "scope"]);
    await h.actor.op(player.conn, ++player.n, { t: "token.move", tokenId: f.pc, x: 9, y: 3 });
    await h.flush();
    details(ack(player, 2), [{ n: 2, scope: "play", changed: false }]);
    results.push({ before, after, effective: event!.ackDetails, noEffect: ack(player, 2)!.ackDetails });
  }
  assert.deepEqual(results[1], results[0], "different secret state and effects cannot change player projections or acknowledgment metadata");
});


test("oversized accepted Setup changes report no history and a size warning only to their sender", async (t) => {
  const f = scopeFixture();
  for (let group = 0; group < 11; group++) {
    const sceneId = uuidv7();
    f.state.scenes[sceneId] = scene(sceneId);
    for (let i = 0; i < 460; i++) {
      const id = uuidv7();
      f.state.tokens[id] = token(id, { sceneId, actor: { ref: f.bree } });
    }
  }
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  const second = await h.connect(f.dm);
  const player = await h.connect(f.player);
  await dm.apply({ t: "room.update", name: "An older Setup step" });
  const event = await dm.apply({ t: "character.delete", characterId: f.bree });
  assert.deepEqual(event.ackDetails, [{ n: 2, scope: "setup", changed: true, recorded: false, tooLarge: true }]);
  assert.equal(dm.history().setup?.undo.depth, 0);
  assert.equal(h.actor.committed.state.characters[f.bree], undefined);
  for (const other of [second, player]) assert.equal(other.sent.some((m) => m.t === "ev" && m.ackDetails !== undefined), false);
});

test("semantic acknowledgment hashing runs only after hello opt-in", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const legacy = await h.connect(f.dm);
  const modern = await h.connect(f.dm, undefined, undefined, true);
  let hashes = 0;
  const stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", function (...args: Parameters<typeof JSON.stringify>) {
    if (new Error().stack?.includes("acknowledgmentValueHash")) hashes++;
    return stringify(...args);
  });
  await legacy.apply({ t: "room.update", name: "Legacy save" });
  assert.equal(hashes, 0, "legacy saves must not compute opt-in acknowledgment values");
  await modern.apply({ t: "room.update", name: "Modern save" });
  assert.ok(hashes > 0, "opted-in saves compute their semantic effect");
});


test("bookkeeping-only changes can be effective without recording history", async (t) => {
  const f = scopeFixture();
  const key = `${f.sceneId}:0,0`;
  f.state.exploredTiles[key] = { sceneId: f.sceneId, tx: 0, ty: 0, rev: 0, bits: encodeTile(fullTileBits()) };
  const h = await ackActor(t, f.state);
  const dm = await h.connect(f.dm);
  const event = await dm.apply({ t: "fog.reset", sceneId: f.sceneId, to: "hidden" });
  assert.equal(h.actor.committed.state.exploredTiles[key], undefined);
  assert.deepEqual(event.ackDetails, [{ n: 1, scope: "play", changed: true, recorded: false }]);
  assert.equal(dm.history().play.undo.depth, 0);
});

test("recording acknowledgment extensions accept old payloads and enforce their bounds", () => {
  const old = { n: 1, scope: "setup", changed: true };
  assert.ok(opAcknowledgmentSchema.safeParse(old).success);
  assert.ok(opAcknowledgmentSchema.safeParse({ ...old, recorded: false, tooLarge: true }).success);
  for (const fields of [{ recorded: "true" }, { tooLarge: false }, { recorded: true, secret: "private" }]) {
    assert.equal(opAcknowledgmentSchema.safeParse({ ...old, ...fields }).success, false);
  }
});

test("an effective player HP change reports no history when that action is not eligible", async (t) => {
  const f = scopeFixture();
  const h = await ackActor(t, f.state);
  const player = await h.connect(f.player);
  const event = await player.apply({ t: "actor.hp", target: { characterId: f.bree }, change: { kind: "damage", amount: 4 } });
  assert.deepEqual(event.ackDetails, [{ n: 1, scope: "play", changed: true, recorded: false }]);
  assert.equal(player.history().play.undo.depth, 0);
});
