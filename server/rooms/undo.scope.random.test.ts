import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { rng } from "#shared/testutil.ts";
import type { HistoryDirection, HistoryScope } from "#shared/undoContract.ts";
import { scopeActor, scopeFixture, type ScopeClient } from "./undoScopeTesting.ts";

const SEEDS = [0x51a7, 0xc0ffee, 0x290405, 0x290406, 0x72489, 0x34a30];
const SCOPES: HistoryScope[] = ["play", "setup"];
const DIRECTIONS: HistoryDirection[] = ["undo", "redo"];
const programs = ["cross-redo", "forward-conflict", "stale", "pose"] as const;

for (const seed of SEEDS) test(`undo-scope-random: seed ${seed}`, async (t) => {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const trace: string[] = [];
  try {
    // Every seed covers all programs. Values, device, scope, direction, conflict recovery and reconnects vary.
    const schedule = Array.from({ length: 3 }, () => {
      const shuffled = [...programs];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      return shuffled;
    }).flat();
    for (const [round, program] of schedule.entries()) {
      trace.push(`${round}:${program}`);
      const f = scopeFixture();
      const h = await scopeActor(t, f.state);
      let first = await h.connect(f.dm);
      const second = await h.connect(f.dm);
      const external = await h.connect(f.otherDm);
      const player = await h.connect(f.player);
      const unrelated = await h.connect(f.unrelated);
      const dm = () => pick([first, second]);
      const current = () => h.actor.committed.state;
      const hp0 = f.state.characters[f.bree]!.actor.hp.cur;
      const ac0 = f.state.characters[f.bree]!.actor.ac;
      const ac1 = ac0 + 1 + Math.floor(random() * 6);
      const amount = 1 + Math.floor(random() * 4);
      const edit = (value: number) => ({ t: "character.update", characterId: f.bree, patch: { actor: { ac: value } } });
      const hit = () => ({ t: "actor.hp", target: { characterId: f.bree }, change: { kind: "damage", amount } });
      const stacks = () => ({ play: first.history().play, setup: first.history().setup });
      first.history();

      const admission = async (scope: HistoryScope, direction: HistoryDirection) => {
        trace.push(`quota:${scope}:${direction}`);
        const client = dm();
        const before = current();
        const histories = stacks();
        const head = client.head(scope, direction).id;
        h.actor.readOnly = true;
        try {
          const event = await client.send({ t: direction, scope, head });
          assert.equal(event.rejects?.[0]?.code, "quota");
          assert.deepEqual(current(), before, "admission refusal is atomic, including log and memory");
          assert.deepEqual(stacks(), histories, "admission preserves both directions, ids and retention");
        } finally {
          h.actor.readOnly = false;
        }
      };
      const retained = async (scope: HistoryScope, direction: HistoryDirection, blockerScope: HistoryScope, blockerDirection: HistoryDirection) => {
        const client = dm();
        const head = client.head(scope, direction);
        const blocker = client.head(blockerScope, blockerDirection);
        const before = current();
        const event = await client.send({ t: direction, scope, head: head.id });
        assert.equal(event.rejects?.length, 1);
        assert.deepEqual(current(), before, "retained refusal changes no target or log");
        const kept = client.head(scope, direction);
        assert.equal(kept.id, head.id);
        assert.deepEqual(kept.retained, { scope: blockerScope, direction: blockerDirection, label: blocker.label, buried: false }, "retention names an actual prerequisite in this member's other scope");
        return kept;
      };
      const refuseStale = async (scope: HistoryScope, direction: HistoryDirection, head: string) => {
        const before = current();
        const histories = stacks();
        const event = await first.send({ t: direction, scope, head });
        assert.equal(event.rejects?.length, 1);
        assert.deepEqual(current(), before, "a delayed command cannot partially restore a replacement");
        assert.deepEqual(stacks(), histories, "a delayed command consumes no replacement head");
      };

      if (program === "cross-redo") {
        await dm().apply(edit(ac1));
        await dm().apply(hit());
        await dm().restore("play");
        await dm().restore("setup");
        const old = await retained("play", "redo", "setup", "redo");
        await admission(pick(SCOPES), "redo");
        await dm().restore("setup", "redo");
        await dm().restore("play", "redo");
        assert.equal(current().characters[f.bree]!.actor.ac, ac1);
        assert.equal(current().characters[f.bree]!.actor.hp.cur, hp0 - amount);
        assert.equal(first.history().setup?.undo.depth, 1);
        assert.equal(first.history().play.undo.depth, 1);
        await refuseStale("play", "redo", old.id);
      } else if (program === "forward-conflict") {
        const earlier = pick(SCOPES);
        const later = earlier === "play" ? "setup" : "play";
        await dm().apply(earlier === "play" ? hit() : edit(ac1));
        await dm().apply(later === "play" ? hit() : edit(ac1));
        const kept = await retained(earlier, "undo", later, "undo");
        const recovery = pick(["discard", "resolve", "external"] as const);
        trace.push(`${earlier}:${recovery}`);
        if (recovery === "resolve") {
          await admission(later, "undo");
          await dm().restore(later);
          await dm().restore(earlier);
          assert.equal(current().characters[f.bree]!.actor.ac, ac0);
          assert.equal(current().characters[f.bree]!.actor.hp.cur, hp0);
        } else {
          if (recovery === "external") await external.apply(edit(ac1 + 10));
          const before = current();
          const opposite = first.history()[earlier]!.redo;
          const event = await dm().send({ t: "undo", scope: earlier, head: kept.id, ...(recovery === "discard" ? { discard: true } : {}) });
          assert.equal(event.rejects?.length ?? 0, recovery === "discard" ? 0 : 1);
          assert.deepEqual(current(), before, "discard and externally conflicted Retry write no game change");
          assert.equal(first.history()[earlier]!.undo.depth, 0, "discard or an unattributable conflict drops only the requested head");
          assert.deepEqual(first.history()[earlier]!.redo, opposite, "a refused or discarded step creates no opposite entry");
        }
      } else if (program === "stale") {
        const scope = pick(SCOPES);
        const direction = pick(DIRECTIONS);
        const action = (value: number) => scope === "setup" ? edit(value) : { t: "token.move", tokenId: f.goblin, x: value, y: 3 };
        await dm().apply(action(8));
        if (direction === "redo") await dm().restore(scope);
        const queued = first.head(scope, direction).id;
        const beforeReconnect = stacks();
        const epoch = first.history().epoch;
        h.actor.detach(first.conn);
        first = await h.connect(f.dm);
        assert.equal(first.history().epoch, epoch, "reconnecting to the same actor keeps its epoch");
        assert.deepEqual(stacks(), beforeReconnect, "reconnect recovers this member's histories");
        await second.restore(scope, direction);
        await second.apply(action(12));
        if (direction === "redo") await second.restore(scope);
        assert.notEqual(first.head(scope, direction).id, queued);
        await refuseStale(scope, direction, queued);
        await admission(scope, direction);
        await dm().restore(scope, direction);
      } else {
        const from = { x: f.state.tokens[f.goblin]!.x, y: f.state.tokens[f.goblin]!.y };
        const to = { x: 6 + Math.floor(random() * 8), y: 6 };
        await dm().apply({ t: "token.move", tokenId: f.goblin, ...to });
        await dm().apply({ t: "token.update", tokenId: f.goblin, patch: { name: `Captain ${seed}`, actor: { ac: ac1 } } });
        for (const direction of DIRECTIONS) {
          await admission("play", direction);
          await dm().restore("play", direction);
          const token = current().tokens[f.goblin]!;
          assert.deepEqual({ x: token.x, y: token.y }, direction === "undo" ? from : to);
          assert.equal(token.name, `Captain ${seed}`);
          assert.ok("inline" in token.actor);
          assert.equal(token.actor.inline.ac, ac1, "pose restore preserves the later setup value");
        }
      }
      const beforeChat = stacks();
      await dm().apply({ t: "log.chat", text: `Sequence ${round}` });
      assert.deepEqual(stacks(), beforeChat, "unrecorded chat preserves all four stacks");
      const privateHeads = new Set([first, second].flatMap((client) => client.sent.flatMap((message) => message.t === "history" ? SCOPES.flatMap((scope) => DIRECTIONS.map((direction) => message[scope]?.[direction].head?.id).filter((id): id is string => Boolean(id))) : [])));
      for (const viewer of [player, unrelated]) {
        assert.equal(viewer.history().setup, undefined, "players receive no Setup history");
        for (const head of privateHeads) assert.ok(!JSON.stringify(viewer.sent).includes(head), "no private head reaches any player frame");
      }
      assert.equal(external.history().play.undo.depth, 0, "co-DM never inherits this member's Play history");
      await h.actor.shutdown({ code: 1012, snapshot: false });
    }
  } catch (error) {
    if (error instanceof Error) error.message += `\nseed=${seed}\ntrace=${trace.join(" > ")}`;
    throw error;
  }
});

type ModelValue = { x: number; name: string };
type ModelEntry = {
  id: string;
  label: string;
  before: ModelValue;
  after: ModelValue;
  order: number;
  retained?: { scope: HistoryScope; direction: HistoryDirection; label: string; buried: boolean };
};
type Model = Record<HistoryScope, Record<HistoryDirection, ModelEntry[]>>;

for (const seed of [17, 42, 97, 101]) test(`undo-scope-model: seed ${seed}`, async (t) => {
  let randomState = seed;
  const random = (n: number) => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return (randomState >>> 8) % n;
  };
  const trace: string[] = [];
  const f = scopeFixture();
  const h = await scopeActor(t, f.state);
  let one = await h.connect(f.dm);
  const two = await h.connect(f.dm);
  const external = await h.connect(f.otherDm);
  const player = await h.connect(f.player);
  const model: Model = { play: { undo: [], redo: [] }, setup: { undo: [], redo: [] } };
  const seenHeads = new Set<string>();
  let order = 0;
  const coverage = { fresh: 0, external: 0, noEffect: 0, stale: 0, admission: 0, discard: 0, restored: 0, retained: 0, dropped: 0 };
  const value = (): ModelValue => {
    const token = h.actor.committed.state.tokens[f.goblin]!;
    return { x: token.x, name: token.name };
  };
  const same = (a: ModelValue, b: ModelValue) => a.x === b.x && a.name === b.name;
  const fresh = (client: ScopeClient, scope: HistoryScope, direction: HistoryDirection, before: ModelValue, after: ModelValue, label?: string) => {
    const head = client.head(scope, direction);
    assert.ok(!seenHeads.has(head.id), "a fresh head is never reused, even after its entry leaves the model");
    seenHeads.add(head.id);
    model[scope][direction].push({ id: head.id, label: label ?? head.label, before, after, order: ++order });
    if (model[scope][direction].length > 50) model[scope][direction].shift();
  };
  const check = () => {
    const history = one.history();
    for (const scope of SCOPES) for (const direction of DIRECTIONS) {
      const expected = model[scope][direction];
      const actual = history[scope]![direction];
      assert.equal(actual.depth, expected.length, "bounded depth tracks only its scope and direction");
      assert.equal(actual.head?.id, expected.at(-1)?.id, "the current head matches the independent model");
      assert.deepEqual(actual.head?.retained, expected.at(-1)?.retained, "retention has the exact prerequisite");
    }
    assert.deepEqual(two.history().play, history.play, "devices share committed Play");
    assert.deepEqual(two.history().setup, history.setup, "devices share committed Setup");
    const privateBytes = JSON.stringify(player.sent);
    assert.equal(player.history().setup, undefined, "players get no Setup history");
    for (const head of seenHeads) assert.ok(!privateBytes.includes(head), "no other member's head reaches any player frame");
  };
  try {
    for (let turn = 0; turn < 80; turn++) {
      if (turn === 23 || turn === 53) {
        h.actor.detach(one.conn);
        one = await h.connect(f.dm);
        check();
      }
      const client = random(2) ? one : two;
      const kind = random(10);
      const scope: HistoryScope = random(2) ? "play" : "setup";
      const direction: HistoryDirection = random(2) ? "undo" : "redo";
      const before = value();
      trace.push(`${turn}:${kind}:${scope}:${direction}`);
      if (kind < 3) {
        const after = scope === "play" ? { ...before, x: random(20) + 1 } : { ...before, name: `Setup ${turn}` };
        await client.apply(scope === "play" ? { t: "token.move", tokenId: f.goblin, x: after.x, y: 3 } : { t: "token.update", tokenId: f.goblin, patch: { name: after.name } });
        if (!same(before, after)) {
          coverage.fresh++;
          model[scope].redo = [];
          fresh(client, scope, "undo", before, after);
        }
        assert.deepEqual(value(), after);
      } else if (kind === 3) {
        coverage.external++;
        await external.apply({ t: "token.move", tokenId: f.goblin, x: 40 + random(10), y: 3 });
      } else if (kind === 4) {
        coverage.noEffect++;
        const old = client.history();
        await client.apply(random(2) ? { t: "token.move", tokenId: f.goblin, x: before.x, y: 3 } : { t: "log.chat", text: "No history mutation" });
        assert.deepEqual(client.history().play, old.play, "None and no-effect preserve Play");
        assert.deepEqual(client.history().setup, old.setup, "None and no-effect preserve Setup");
        assert.equal(client.history().serial, old.serial, "None and no-effect preserve serial");
      } else {
        const stack = model[scope][direction];
        const entry = stack.at(-1);
        const discard = kind === 5 && entry?.retained !== undefined;
        const stale = kind === 6 || !entry;
        const admission = kind === 7 && !stale;
        const state = h.actor.committed.state;
        const old = client.history();
        h.actor.readOnly = admission;
        let event: Awaited<ReturnType<ScopeClient["send"]>>;
        try {
          event = await client.send({ t: direction, scope, head: stale ? uuidv7() : entry.id, ...(discard ? { discard: true } : {}) });
        } finally {
          h.actor.readOnly = false;
        }
        if (stale || admission) {
          coverage[stale ? "stale" : "admission"]++;
          assert.equal(event.rejects?.length, 1);
          assert.deepEqual(h.actor.committed.state, state, "stale or admission refusal is atomic");
          assert.deepEqual(client.history().play, old.play, "stale or admission refusal preserves Play");
          assert.deepEqual(client.history().setup, old.setup, "stale or admission refusal preserves Setup");
        } else if (discard) {
          coverage.discard++;
          assert.equal(event.rejects?.length ?? 0, 0);
          stack.pop();
          assert.deepEqual(h.actor.committed.state, state, "discard writes no game state");
        } else {
          const conflict = scope === "play" ? before.x !== entry.after.x : !same(before, entry.after);
          if (!conflict) {
            coverage.restored++;
            assert.equal(event.rejects?.length ?? 0, 0, JSON.stringify(event.rejects));
            const after = scope === "play" ? { ...before, x: entry.before.x } : entry.before;
            assert.deepEqual(value(), after, "restore is whole-value or pose-only as scoped");
            stack.pop();
            fresh(client, scope, direction === "undo" ? "redo" : "undo", before, after, entry.label);
          } else {
            assert.equal(event.rejects?.length, 1);
            assert.deepEqual(h.actor.committed.state, state, "a state-conflict refusal is atomic");
            const other = scope === "play" ? "setup" : "play";
            const candidates = DIRECTIONS.flatMap((d) => model[other][d].map((e, index, all) => ({ e, d, buried: index < all.length - 1 })))
              .filter((c) => scope === "play" ? before.x === c.e.after.x : same(before, c.e.after))
              .sort((a, b) => b.e.order - a.e.order);
            const candidate = candidates[0];
            if (candidate) {
              coverage.retained++;
              entry.retained = { scope: other, direction: candidate.d, label: candidate.e.label, buried: candidate.buried };
            } else {
              coverage.dropped++;
              stack.pop();
            }
          }
        }
      }
      check();
    }
    t.diagnostic(`seed=${seed} actions=80 coverage=${JSON.stringify(coverage)}`);
  } catch (error) {
    if (error instanceof Error) error.message += `\nseed=${seed}\ntrace=${trace.join(" > ")}`;
    throw error;
  }
});
