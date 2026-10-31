import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { keys } from "#shared/keys.ts";
import { LIMITS } from "#shared/limits.ts";
import type { Actor, RoomState } from "#shared/model.ts";
import type { SaveOutcomeLedger } from "#shared/saveOutcomeContract.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { opSchema } from "#shared/protocol.ts";
import { AT, customMonster, rng, token } from "#shared/testutil.ts";
import { scopeActor, scopeFixture, scopeObserver, until, type ScopeClient } from "./undoScopeTesting.ts";
import { UndoTable } from "./undoTesting.ts";

type Tracked = RoomState & { saveOutcomes?: SaveOutcomeLedger };
const ledger = (state: RoomState) => (state as Tracked).saveOutcomes ?? {};
const inline = (state: RoomState, id: string): Actor => (state.tokens[id]!.actor as { inline: Actor }).inline;

function tracked(target: string, id = uuidv7(), expectRevision = 0, plan = id, amount?: number) {
  return { t: "actor.outcome", label: "Fireball", plan, page: { id, expectRevision }, targets: [{ target: { tokenId: target }, ...(amount === undefined ? {} : { amount }) }] };
}

async function refused(client: ScopeClient, op: unknown) {
  const event = await client.send(op);
  assert.ok(event.rejects?.length, "operation must refuse");
  return event.rejects[0]!;
}

test("tracked zero-entity Apply records one step, duplicate receipt adds none, empty Undo/Redo transfers identity", async (t) => {
  const f = scopeFixture();
  f.state.monsters.resistant = customMonster("resistant", { resistances: "Fire" });
  inline(f.state, f.goblin).monsterId = "resistant";
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm, "dm", undefined, true);
  const player = await h.connect(f.player);
  const display = await scopeObserver(h.actor, { memberId: "display:abcdefghijkl", role: "player", display: true });
  const op = tracked(f.goblin);
  op.targets = [{ target: { tokenId: f.goblin } }];
  const noEffect = { ...op, targets: [{ target: { tokenId: f.goblin }, damage: { parts: [{ amount: 2, type: "fire" }], save: { result: "pass", onPass: "half", dex: true, evasion: false } } }] };
  await dm.apply(noEffect);
  assert.equal(dm.history().play.undo.depth, 1);
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.revision, 1);
  const head = dm.head().id;
  await dm.apply(noEffect);
  assert.equal(dm.history().play.undo.depth, 1);
  assert.equal(dm.head().id, head);
  const observed = [player.sent.length, display.sent.length];
  await dm.restore();
  assert.equal(dm.history().play.undo.depth, 0);
  assert.equal(dm.history().play.redo.depth, 1);
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.state, "undone");
  const undo = h.db.stored.findLast((stored) => stored.t === "sys.restore");
  assert.ok(undo && undo.t === "sys.restore");
  assert.deepEqual(undo.entries, []);
  assert.deepEqual((undo as unknown as { saveOutcome: unknown }).saveOutcome, { id: op.plan, plan: op.plan, expectRevision: 1, state: "undone" });
  await dm.restore("play", "redo");
  assert.equal(dm.history().play.undo.depth, 1);
  assert.equal(dm.history().play.redo.depth, 0);
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.revision, 3);
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.state, "applied");
  for (const [i, messages] of [player.sent, display.sent].entries()) {
    const bytes = JSON.stringify(messages.slice(observed[i]));
    for (const privateValue of [op.plan, "saveOutcome", "checkpoint", "Fireball", '"type":"correction"']) assert.ok(!bytes.includes(privateValue), privateValue);
  }
});

test("tracked outcomes never merge with their supplied gesture or adjacent movement, and page traffic preserves both Redo stacks", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const group = uuidv7();
  await dm.apply({ t: "token.move", tokenId: f.goblin, x: 6, y: 5 }, group);
  await dm.apply(tracked(f.goblin), group);
  await dm.apply(tracked(f.goblin), group);
  assert.equal(dm.history().play.undo.depth, 3);
  await dm.restore();
  await dm.apply({ t: "scene.update", sceneId: f.sceneId, patch: { name: "Prepared" } });
  await dm.restore("setup");
  const stacks = structuredClone(dm.history());
  const rollId = uuidv7();
  await dm.apply({ t: "roll.ask", reason: "savePage", request: { id: rollId, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: f.bree }] } });
  await dm.apply({ t: "roll.close", rollIds: [rollId], reason: "savePage" });
  assert.deepEqual(dm.history().play, stacks.play);
  assert.deepEqual(dm.history().setup, stacks.setup);
});

test("page ask, answer, Apply, Undo, deliberate Undo reaches the preceding move and leaves old cards closed", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const player = await h.connect(f.player);
  await dm.apply({ t: "token.move", tokenId: f.goblin, x: 7, y: 5 });
  const rollId = uuidv7();
  const request = { id: rollId, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 13, dcShown: true, resultShown: true, targets: [{ characterId: f.bree }] };
  await dm.apply({ t: "roll.ask", reason: "savePage", request });
  await player.apply({ t: "roll.answer", rollId, target: { characterId: f.bree }, total: 18, tag: uuidv7() });
  await dm.apply({ t: "roll.close", rollIds: [rollId], reason: "savePage" });
  const op = tracked(f.goblin, undefined, 0, undefined, 2);
  await dm.apply(op);
  await dm.restore();
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.state, "undone");
  assert.equal(h.actor.committed.state.rolls[rollId], undefined);
  await dm.restore();
  assert.equal(h.actor.committed.state.tokens[f.goblin]?.x, f.state.tokens[f.goblin]?.x);
  await dm.apply({ t: "roll.ask", reason: "savePage", request: { ...request, id: uuidv7() } });
  assert.equal(Object.keys(h.actor.committed.state.rolls).length, 1);
  assert.equal(dm.history().play.undo.depth, 0);
});

test("whole-value replacement refuses after answer, Close and Undo Close even when rev matches the prepared value", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const coDm = await h.connect(f.otherDm);
  const player = await h.connect(f.player);
  const old = uuidv7();
  const request = { id: old, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 13, dcShown: true, resultShown: true, targets: [{ characterId: f.bree }] };
  await dm.apply({ t: "roll.ask", reason: "savePage", request });
  const original = h.actor.committed.state.rolls[old]!;
  const replacement = { t: "roll.ask", reason: "savePage", replaces: [{ id: old, expectHash: guardHash(keys.roll(old), original) }], request: { ...request, id: uuidv7() } };
  await player.apply({ t: "roll.answer", rollId: old, target: { characterId: f.bree }, total: 18, tag: uuidv7() });
  await coDm.apply({ t: "roll.close", rollIds: [old] });
  await coDm.restore();
  assert.equal(h.actor.committed.state.rolls[old]!.rev, original.rev);
  const saved = structuredClone(h.actor.committed.state);
  await refused(dm, replacement);
  assert.deepEqual(h.actor.committed.state, saved);
  assert.equal(h.actor.committed.state.rolls[old]!.targets[0]?.total, 18);
  assert.equal(h.actor.committed.state.rolls[replacement.request.id], undefined);
});

test("second device Undo shares status, co-DM reapply refuses, delayed A heads and original receipt cannot change B", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const one = await h.connect(f.dm);
  const two = await h.connect(f.dm);
  const co = await h.connect(f.otherDm);
  const a = tracked(f.goblin, undefined, 0, undefined, 2);
  await one.apply(a);
  await until(() => two.history().play.undo.head?.id === one.head().id || undefined, "shared head");
  await two.restore();
  const oldRedo = two.head("play", "redo").id;
  const b = tracked(f.goblin, a.plan, 2, uuidv7(), 3);
  await refused(co, b);
  await one.apply(b);
  const state = structuredClone(h.actor.committed.state);
  const headB = one.head().id;
  await refused(two, { t: "redo", head: oldRedo });
  await two.apply(a);
  assert.equal(two.head().id, headB);
  assert.deepEqual(h.actor.committed.state, state, "old receipt is resolved before new lifecycle admission");
  assert.equal(ledger(h.actor.committed.state)[a.plan]?.plan, b.plan);
  assert.equal(ledger(h.actor.committed.state)[a.plan]?.revision, 3);
});

test("committed snapshots and changes keep lifecycle, hidden labels and drafts off player, display and View-as wires", async (t) => {
  const f = scopeFixture();
  f.state.tokens[f.goblin]!.visibility = "dm";
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const peer = await h.connect(f.dm);
  const player = await h.connect(f.player);
  const unrelated = await h.connect(f.unrelated);
  const display = await scopeObserver(h.actor, { memberId: "display:abcdefghijkl", role: "player", display: true });
  const preview = await scopeObserver(h.actor, { memberId: f.dm.id, role: "dm", previewOf: f.player.id });
  const op = { ...tracked(f.goblin, undefined, 0, undefined, 1), label: "Private hidden trap" };
  await dm.apply(op);
  await until(() => peer.sent.some((message) => JSON.stringify(message).includes(op.plan)) || undefined, "committed DM projection");
  await dm.restore();
  const freshPlayer = await h.connect(f.player);
  const freshPreview = await scopeObserver(h.actor, { memberId: f.dm.id, role: "dm", previewOf: f.player.id });
  for (const observer of [player, unrelated, display, preview, freshPlayer, freshPreview]) {
    const bytes = JSON.stringify(observer.sent);
    for (const secret of [op.plan, "saveOutcomes", "saveOutcome:", "firstAppliedAt", "beforeApply", "redoHeld", "checkpoint", "Private hidden trap"]) assert.ok(!bytes.includes(secret), secret);
    assert.ok(!bytes.includes('"type":"correction"'), "invisible lifecycle restoration writes no empty player notice");
  }
});

test("ledger and history are published only after commit, including a retry after storage failure", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const peer = await h.connect(f.dm);
  const before = structuredClone(peer.history());
  let attempted = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.db.beforeCommit = async () => {
    if (++attempted === 1) throw new Error("simulated transient commit failure");
    await gate;
  };
  const op = tracked(f.goblin);
  const pending = dm.apply(op);
  void pending.catch(() => undefined);
  try {
    await until(() => attempted >= 2 || undefined, "storage retry");
    assert.equal(ledger(h.actor.committed.state)[op.plan], undefined);
    assert.deepEqual(peer.history(), before);
  } finally {
    release();
  }
  await pending;
  await until(() => peer.history().play.undo.depth === 1 || undefined, "committed history");
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.revision, 1);
});

test("failed guarded whole Undo and HP log correction never change the applied lifecycle", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const co = await h.connect(f.otherDm);
  const op = tracked(f.goblin, undefined, 0, undefined, 2);
  await dm.apply(op);
  const log = h.actor.committed.state.log.findLast((line) => line.data?.type === "hp" && line.data.tokenId === f.goblin);
  assert.ok(log);
  await dm.apply({ t: "undo", log: log.id });
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.state, "applied");
  await co.apply({ t: "actor.hp", target: { tokenId: f.goblin }, change: { kind: "damage", amount: 1 } });
  await refused(dm, { t: "undo", head: dm.head().id });
  assert.equal(ledger(h.actor.committed.state)[op.plan]?.revision, 1);
});

for (const entityful of [false, true]) test(`evicted ${entityful ? "entityful step restores without recreating metadata" : "lifecycle-only step refuses and drops"}`, async (t) => {
  const f = scopeFixture();
  // The 200 outcomes below are a co-DM's Applies paced inside the DM roll budget and the room's op rate, which the actor's clock refills.
  let clock = Date.now();
  const h = await scopeActor(t, f.state, { now: () => clock });
  const dm = await h.connect(f.dm);
  const co = await h.connect(f.otherDm, "dm", () => clock);
  const first = tracked(f.goblin, undefined, 0, undefined, entityful ? 1 : undefined);
  await dm.apply(first);
  // Other-member outcomes evict status without replacing this member's history head.
  for (let i = 0; i < 200; i++) {
    clock += LIMITS.dmRollRefillMs;
    await co.apply(tracked(f.goblin));
  }
  assert.equal(ledger(h.actor.committed.state)[first.plan], undefined);
  const event = await dm.send({ t: "undo", head: dm.head().id });
  assert.equal(Boolean(event.rejects?.length), !entityful);
  assert.equal(dm.history().play.undo.depth, 0);
  assert.equal(dm.history().play.redo.depth, entityful ? 1 : 0);
  assert.equal(ledger(h.actor.committed.state)[first.plan], undefined);
  assert.equal(inline(h.actor.committed.state, f.goblin).hp.cur, inline(f.state, f.goblin).hp.cur);
});

test("deterministic lifecycle sequences preserve one active outcome, monotonic revisions and stale-head isolation", async (t) => {
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const peer = await h.connect(f.dm);
  const random = rng(0x35b31);
  const first = tracked(f.goblin);
  await dm.apply(first);
  let revision = 1;
  let state = "applied";
  let current = first;
  for (let i = 0; i < 60; i++) {
    const oldRevision = revision;
    if (random() < 0.3) {
      const saved = structuredClone(h.actor.committed.state);
      await refused(peer, { t: random() < 0.5 ? "undo" : "redo", head: uuidv7() });
      assert.deepEqual(h.actor.committed.state, saved, "stale commands never consume the live head or mutate state");
    } else if (state === "applied") {
      await dm.restore();
      state = "undone";
      revision++;
    } else if (random() < 0.5) {
      await dm.restore("play", "redo");
      state = "applied";
      revision++;
    } else {
      current = tracked(f.goblin, first.plan, revision, uuidv7());
      await dm.apply(current);
      state = "applied";
      revision++;
    }
    const record = ledger(h.actor.committed.state)[first.plan];
    assert.equal(record?.revision, revision, `monotonic revision at sequence ${i}, previous ${oldRevision}`);
    assert.equal(record?.state, state, "only exact whole transitions unlock/relock");
    assert.equal(record?.plan, current.plan);
    assert.equal(Object.keys(ledger(h.actor.committed.state)).length, 1, "one identity per page");
  }
});

test("UNDO-A-SOL-05: helper and real actor both consume an invalid serialized restore", async (t) => {
  const f = scopeFixture();
  const hidden = uuidv7();
  f.state.tokens[f.goblin] = token(f.goblin, { sceneId: f.sceneId, ownerIds: [f.player.id], attached: { to: hidden, kind: "drag" } });
  f.state.tokens[hidden] = token(hidden, { sceneId: f.sceneId, visibility: "dm", attached: { to: f.goblin, kind: "drag" } });
  const table = new UndoTable(f.state);
  const playerViewer = { memberId: f.player.id, role: "player" as const };
  const dmViewer = { memberId: f.dm.id, role: "dm" as const };
  const move = { t: "token.move" as const, tokenId: f.goblin, x: 4, y: 3 };
  const remove = { t: "token.deleteMany" as const, tokenIds: [f.goblin, hidden] };
  assert.equal(table.play(playerViewer, move), "ok");
  assert.equal(table.play(dmViewer, remove), "ok");
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const player = await h.connect(f.player);
  await player.apply(move);
  await dm.apply(remove);
  const rejected = await refused(player, { t: "undo", head: player.head().id });
  assert.equal(rejected.code, "invalid");
  assert.match(table.undo(playerViewer), /server op sys.restore does not validate/);
  assert.equal(player.history().play.undo.depth, 0);
  assert.equal(table.stacks.depth(f.player.id).undo, player.history().play.undo.depth, "helper must consume the same unusable head as the actor");
  assert.equal(table.stacks.depth(f.player.id).redo, 0);
});

test("helper and real actor both record a lifecycle-only outcome and transfer its identity through Undo and Redo", async (t) => {
  const f = scopeFixture();
  const table = new UndoTable(f.state);
  const dmViewer = { memberId: f.dm.id, role: "dm" as const };
  // The helper's ops carry the fixed test time, so its tracking id is made then.
  const helperPlan = uuidv7(Date.parse(AT));
  assert.equal(table.play(dmViewer, opSchema.parse(tracked(f.goblin, helperPlan))), "ok");
  const h = await scopeActor(t, f.state);
  const dm = await h.connect(f.dm);
  const op = tracked(f.goblin);
  await dm.apply(op);
  const depths = () => [table.stacks.depth(f.dm.id), { undo: dm.history().play.undo.depth, redo: dm.history().play.redo.depth }];
  assert.deepEqual(depths(), [{ undo: 1, redo: 0 }, { undo: 1, redo: 0 }], "an outcome with no entity inverse is still one step");
  for (const from of ["undo", "redo"] as const) {
    assert.equal(table.restore(dmViewer, from), "ok");
    await dm.restore("play", from);
    assert.equal(ledger(table.state)[helperPlan]?.state, ledger(h.actor.committed.state)[op.plan]?.state);
    assert.equal(table.stacks.peek(f.dm.id, from === "undo" ? "redo" : "undo")?.saveOutcome?.id, helperPlan, "the restored step keeps its identity");
  }
  assert.deepEqual(depths(), [{ undo: 1, redo: 0 }, { undo: 1, redo: 0 }]);
  assert.equal(ledger(table.state)[helperPlan]?.revision, 3);
});
