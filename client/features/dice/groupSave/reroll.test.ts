import assert from "node:assert/strict";
import { test } from "node:test";
import { keys } from "#shared/keys.ts";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import type { SavePageAskFields } from "#shared/saveOutcomeContract.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { newPage, type Page, type ServerRoll } from "./chain.ts";
import { askAgain, rerollSaves, settleAskAgain } from "./reroll.ts";
import type { RowBase, RowState } from "./rows.ts";

const base = (): Page => ({ ...newPage({ id: "page", sceneId: "scene", source: { kind: "selection", tokenIds: [] }, test: { kind: "save", ability: "dex" }, dc: 16, secret: false, spell: true, switches: { dcShown: false, resultShown: true }, fill: { name: "Secret trap", publicName: "Trap", from: "A trap" } }), phase: "rolled" });
function row(id: string, way: "server" | "ask" | "type" = "ask"): RowBase {
  return { holder: `token:${id}`, target: { tokenId: id }, tokenId: id, name: id, ways: [way], bonus: 2, skip: false, ...(way === "ask" ? { askRef: { tokenId: id } } : {}) };
}
const server = (id: string): ServerRoll => ({ holder: `token:${id}`, target: { tokenId: id }, bonus: 3, sources: [], extra: [] });
const request = (id: string, targets: RollTarget[]): RollRequest => ({ id, rev: 1, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 12, dcShown: false, resultShown: false, at: "2026-10-31T00:00:00.000Z", targets });
function askedPage(): Page {
  const page = base();
  page.rows = [row("alice"), row("bob"), row("carol")];
  page.requests = [{ rollId: "old", holders: page.rows.map(r => r.holder), state: "closed" }];
  for (const r of page.rows) page.states[r.holder] = { way: "ask", asked: { rollId: "old", dc: 12 } };
  page.states["token:alice"] = { ...page.states["token:alice"]!, answer: { tokenId: "alice", total: 19 }, mark: "pass", legendary: true, amount: 4 };
  page.states["token:carol"] = { ...page.states["token:carol"]!, answer: { tokenId: "carol", total: 18 } };
  return page;
}
const oldRequest = () => request("old", [{ tokenId: "alice", total: 19 }, { tokenId: "bob" }, { tokenId: "carol", total: 18 }]);
function sentAsk(step: ReturnType<typeof askAgain>, index = 0) {
  const command = step.send[index];
  assert.ok(command?.kind === "op" && command.op.t === "roll.ask");
  return command.op as typeof command.op & SavePageAskFields;
}

test("successful server rows reroll only the selected result and manual marks under a fresh public label", () => {
  const page = base();
  page.rows = [row("alice", "server"), row("bob", "server"), row("typed", "type")];
  const result: RowState = { way: "server", rolled: { formula: "1d20+2", faces: [19], total: 21 }, typed: 21, mark: "pass", legendary: true, amount: 8, evasion: true };
  page.states = { "token:alice": result, "token:bob": { ...result }, "token:typed": { way: "type", typed: 18 } };
  const step = rerollSaves(page, { holders: ["token:alice", "token:typed"], server: [server("alice"), server("bob"), server("typed")], tag: "again" });
  assert.equal(step.send.length, 1);
  const command = step.send[0];
  assert.ok(command?.kind === "dice");
  assert.equal(command.rolls.length, 1);
  assert.equal(command.rolls[0]!.formula, "1d20+3");
  assert.equal(command.rolls[0]!.label, "Trap: save again");
  assert.equal(command.to, "all");
  assert.equal(command.dc, undefined);
  assert.deepEqual(step.page.states["token:alice"], { way: "server", amount: 8, evasion: true, batch: { tag: "again", part: 0 } });
  assert.equal(step.page.states["token:bob"], page.states["token:bob"]);
  assert.equal(step.page.states["token:typed"], page.states["token:typed"]);
  assert.equal(page.states["token:alice"]!.rolled!.total, 21);
});

test("reroll excludes gone, skipped, asked and already pending rows and refuses reuse of a tag", () => {
  const page = base();
  page.rows = [row("gone", "server"), row("skip", "server"), row("ask"), row("pending", "server")];
  page.states = { "token:gone": { way: "server", gone: true }, "token:skip": { way: "server", mark: "skip" }, "token:ask": { way: "ask" }, "token:pending": { way: "server" } };
  page.rolls = [{ tag: "old", holders: ["token:pending"], state: "sending" }];
  assert.deepEqual(rerollSaves(page, { holders: page.rows.map(r => r.holder), server: page.rows.map(r => server(r.tokenId)), tag: "next" }).send, []);
  const available = { ...page, states: { "token:pending": { way: "server" as const } }, rows: [row("pending", "server")], rolls: [{ ...page.rolls[0]!, state: "committed" as const }] };
  const reused = rerollSaves(available, { holders: ["token:pending"], server: [server("pending")], tag: "old" });
  assert.equal(reused.page, available);
  assert.ok(reused.error);
  assert.deepEqual(reused.send, []);
});

test("Ask again keeps results pending and replaces restored requests with their complete value hash", () => {
  const page = askedPage();
  const old = oldRequest();
  const step = askAgain(page, { holders: ["token:alice"], requests: { old }, requestIds: () => "fresh" });
  const op = sentAsk(step);
  assert.equal(op.reason, "savePage");
  assert.deepEqual(op.replaces, [{ id: "old", expectHash: guardHash(keys.roll("old"), old) }]);
  assert.deepEqual(op.request.targets, [{ tokenId: "alice" }, { tokenId: "bob" }]);
  assert.equal(op.request.dc, 16);
  assert.equal(op.request.dcShown, false);
  assert.equal(op.request.resultShown, true);
  assert.equal(op.request.note, "Trap: save again");
  assert.equal(op.request.spell, true);
  assert.equal(step.page.states, page.states);
  assert.equal(step.page.requests[0], page.requests[0]);
  assert.deepEqual(step.page.requests[1], { rollId: "fresh", holders: ["token:alice", "token:bob"], selected: ["token:alice"], replaces: ["old"], dc: 16, state: "sending" });
});

test("acceptance replaces selected references and marks while carried rows retain their copied choices", () => {
  const page = askedPage();
  const pending = askAgain(page, { holders: ["token:alice"], requests: { old: oldRequest() }, requestIds: () => "fresh" }).page;
  const settled = settleAskAgain({ ...pending, dc: 20 }, "fresh", { ok: true });
  assert.equal(settled.requests[0]!.state, "closed");
  assert.equal(settled.requests[1]!.state, "open");
  assert.deepEqual(settled.states["token:alice"], { way: "ask", amount: 4, asked: { rollId: "fresh", dc: 16 } });
  assert.deepEqual(settled.states["token:bob"], { way: "ask", asked: { rollId: "fresh", dc: 16 } });
  assert.equal(settled.states["token:carol"], page.states["token:carol"]);
  assert.equal(settleAskAgain(settled, "fresh", { ok: true }), settled);
});

test("stale replacement refusal keeps answers and refs, then an explicit retry excludes a newly answered carried row", () => {
  const page = askedPage();
  const old = oldRequest();
  const pending = askAgain(page, { holders: ["token:alice"], requests: { old }, requestIds: () => "fresh" }).page;
  const bob = { tokenId: "bob", total: 20 };
  const seen = { ...pending, states: { ...pending.states, "token:bob": { ...pending.states["token:bob"]!, answer: bob } } };
  const refused = settleAskAgain(seen, "fresh", { ok: false, message: "This request changed. Try again." });
  assert.equal(refused.states, seen.states);
  assert.equal(refused.requests[0], page.requests[0]);
  assert.equal(refused.requests[1]!.state, "refused");
  assert.equal(refused.requests[1]!.says, "This request changed. Try again.");
  const changed = { ...old, targets: [old.targets[0]!, bob, old.targets[2]!] };
  const retry = askAgain(refused, { holders: ["token:alice"], requests: { old: changed }, requestIds: () => "retry" });
  const op = sentAsk(retry);
  assert.deepEqual(op.request.targets, [{ tokenId: "alice" }]);
  assert.equal(op.replaces![0]!.expectHash, guardHash(keys.roll("old"), changed));
  assert.notEqual(op.replaces![0]!.expectHash, guardHash(keys.roll("old"), old));
  assert.equal(retry.page.states["token:bob"]!.answer, bob);
});

test("revision resets cannot hide a carried answer from the replacement hash", () => {
  const page = askedPage();
  const original = oldRequest();
  const changed = { ...original, rev: 1, targets: original.targets.map(t => t.tokenId === "bob" ? { ...t, total: 18 } : t) };
  const first = sentAsk(askAgain(page, { holders: ["token:alice"], requests: { old: original }, requestIds: () => "first" }));
  const second = sentAsk(askAgain(page, { holders: ["token:alice"], requests: { old: changed }, requestIds: () => "second" }));
  assert.notEqual(first.replaces![0]!.expectHash, second.replaces![0]!.expectHash);
  assert.deepEqual(second.request.targets, [{ tokenId: "alice" }]);
});

test("each old request is retired in one command and new-only targets form separate bounded requests", () => {
  const page = base();
  page.rows = [row("alice"), row("bob"), row("new")];
  page.states = { "token:alice": { way: "ask", asked: { rollId: "a" } }, "token:bob": { way: "ask", asked: { rollId: "b" } }, "token:new": { way: "ask" } };
  page.requests = [{ rollId: "a", state: "closed", holders: ["token:alice"] }, { rollId: "b", state: "closed", holders: ["token:bob"] }];
  let next = 0;
  const step = askAgain(page, { holders: page.rows.map(r => r.holder), requests: { a: request("a", [{ tokenId: "alice" }]), b: request("b", [{ tokenId: "bob" }]) }, requestIds: () => `fresh${++next}` });
  assert.equal(step.send.length, 3);
  assert.deepEqual(sentAsk(step, 0).replaces!.map(r => r.id), ["a"]);
  assert.deepEqual(sentAsk(step, 1).replaces!.map(r => r.id), ["b"]);
  assert.equal(sentAsk(step, 2).replaces, undefined);
  assert.deepEqual(sentAsk(step, 2).request.targets, [{ tokenId: "new" }]);
});

test("capacity is checked after retirement and before any command is sent", () => {
  const page = askedPage();
  const requests: Record<string, RollRequest> = { old: oldRequest() };
  for (let i = 0; i < 19; i++) requests[`unrelated${i}`] = request(`unrelated${i}`, [{ tokenId: `other${i}` }]);
  assert.equal(askAgain(page, { holders: ["token:alice"], requests, requestIds: () => "fresh" }).send.length, 1);
  const freshOnly = { ...page, requests: [], states: { "token:alice": { way: "ask" as const } } };
  const rejected = askAgain(freshOnly, { holders: ["token:alice"], requests, requestIds: () => "fresh" });
  assert.equal(rejected.page, freshOnly);
  assert.deepEqual(rejected.send, []);
  assert.ok(rejected.error);
});

test("overlapping restored requests refuse unchanged if selected and carried targets cannot fit together", () => {
  const page = askedPage();
  page.requests.push({ rollId: "also", state: "closed", holders: ["token:alice"] });
  const old = request("old", [{ tokenId: "alice", total: 19 }, ...Array.from({ length: 49 }, (_, i) => ({ tokenId: `left${i}` }))]);
  const also = request("also", [{ tokenId: "alice", total: 19 }, { tokenId: "extra" }]);
  const step = askAgain(page, { holders: ["token:alice"], requests: { old, also }, requestIds: () => "fresh" });
  assert.equal(step.page, page);
  assert.deepEqual(step.send, []);
  assert.match(step.error ?? "", /50|fit/);
});

test("a pending replacement blocks another retirement of the same request, including another selected row", () => {
  const page = askedPage();
  const pending = askAgain(page, { holders: ["token:alice"], requests: { old: oldRequest() }, requestIds: () => "fresh" }).page;
  assert.deepEqual(askAgain(pending, { holders: ["token:bob"], requests: { old: oldRequest() }, requestIds: () => "another" }).send, []);
  assert.equal(pending.requests.length, 2);
});

test("duplicate request IDs fail the entire preflight without creating an earlier replacement", () => {
  const page = base();
  page.rows = Array.from({ length: 51 }, (_, i) => row(`r${i}`));
  page.states = Object.fromEntries(page.rows.map(r => [r.holder, { way: "ask" }]));
  const step = askAgain(page, { holders: page.rows.map(r => r.holder), requests: {}, requestIds: () => "duplicate" });
  assert.equal(step.page, page);
  assert.deepEqual(step.send, []);
  assert.ok(step.error);
});

test("applied pages and No save pages cannot reroll or ask", () => {
  for (const page of [{ ...askedPage(), phase: "applied" as const }, { ...askedPage(), test: { kind: "none" as const } }]) {
    assert.deepEqual(askAgain(page, { holders: ["token:alice"], requests: {}, requestIds: () => "fresh" }).send, []);
    assert.deepEqual(rerollSaves(page, { holders: ["token:alice"], server: [server("alice")], tag: "fresh" }).send, []);
  }
});


test("randomized answer and replacement ordering preserves copied choices until accepted and never resends automatically", () => {
  let seed = 0x6b1d;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  let page = askedPage();
  const requests: Record<string, RollRequest> = { old: oldRequest() };
  let ids = 0;
  for (let i = 0; i < 300; i++) {
    const selected = random() % 2 ? "token:alice" : "token:bob";
    const before = page;
    const step = askAgain(page, { holders: [selected], requests, requestIds: () => `fresh-${++ids}` });
    assert.equal(step.page.states, before.states, `seed step ${i}: a pending ask preserves all copied choices`);
    assert.equal(step.send.length, 1);
    const op = sentAsk(step);
    assert.ok(op.request.targets.length <= 50);
    const race = random() % 3 === 0;
    for (const replace of op.replaces ?? []) {
      const old = requests[replace.id]!;
      assert.equal(replace.expectHash, guardHash(keys.roll(old.id), old));
      if (race) {
        const target = old.targets.find(t => `token:${t.tokenId}` !== selected);
        if (target) target.total = ((target.total ?? 0) + 1) % 21;
        else old.note = `changed-${i}`;
        assert.notEqual(replace.expectHash, guardHash(keys.roll(old.id), old));
      }
    }
    const called = ids;
    page = settleAskAgain(step.page, op.request.id, race ? { ok: false, message: "Changed meanwhile." } : { ok: true });
    assert.equal(ids, called, `seed step ${i}: settlement never allocates another request`);
    if (race) {
      assert.equal(page.states, before.states, `seed step ${i}: refusal keeps references and results`);
    } else {
      for (const replace of op.replaces ?? []) delete requests[replace.id];
      requests[op.request.id] = { ...op.request, rev: 1, at: "2026-10-31T00:00:00.000Z" };
      assert.equal(page.states[selected]!.asked!.rollId, op.request.id);
      assert.equal(page.states[selected]!.answer, undefined);
      assert.equal(page.states[selected]!.mark, undefined);
      assert.ok((op.replaces ?? []).every(old => !requests[old.id]), `seed step ${i}: old and replacement never stay live together`);
    }
    assert.equal(settleAskAgain(page, op.request.id, { ok: true }), page, `seed step ${i}: duplicate settlement is inert`);
  }
});
