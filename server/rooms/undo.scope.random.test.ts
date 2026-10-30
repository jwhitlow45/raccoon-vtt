import assert from "node:assert/strict";
import { test } from "node:test";
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
