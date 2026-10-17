import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StatBlock } from "#shared/model.ts";
import { emptyStatBlock } from "#shared/statBlock.ts";
import { BLOCK_SAVES_TOO_FAST } from "#shared/limits.ts";
import type { MonsterPatch } from "#shared/protocol.ts";
import type { OpAnswer, UnknownCause } from "../../state/types.ts";
import { answerSave, markSent, openSave, planSave, saveGone, saveHeld, settleSave, type BlockSave, type BlockLive, type SaveResult } from "./blockSave.ts";
import { isDirty } from "./draft.ts";

const block = (over: Partial<StatBlock> = {}): StatBlock => ({ ...emptyStatBlock(), name: "Moth Spirit", ac: 12, ...over });
const live = (stored: StatBlock | undefined, snapshots = 1): BlockLive => ({ stored, snapshots });

/** Plans and sends a save, as the editor's Save does when the op goes out. */
function send(save: BlockSave, draft: StatBlock, view: BlockLive) {
  const { save: planned, intent } = planSave(save, draft, view);
  assert.ok(intent.kind === "create" || intent.kind === "update", `expected an op, got ${intent.kind}`);
  return { save: markSent(planned, intent), intent };
}

describe("a companion stat block editor's save (docs/design-v1-companion-stat-blocks.md 6.2)", () => {
  test("a new block: a create, taken, closes the editor with the base on what it stored", () => {
    const draft = block();
    const sent = send(openSave(null), draft, live(undefined));
    assert.equal(sent.intent.kind, "create");
    assert.ok(saveHeld(sent.save));
    assert.deepEqual(planSave(sent.save, draft, live(undefined)).intent, { kind: "busy" }, "a second Save sends nothing while one waits");
    const answered = answerSave(sent.save, { answer: "taken" }, draft, live(draft), "Bree");
    assert.deepEqual(answered.result, { kind: "saved" });
    assert.deepEqual(answered.save.base, draft);
  });

  test("an edit diffs against the block as it opened, so a co-owner's change to another line is kept", () => {
    const opened = block();
    const draft = block({ ac: 14 });
    const coOwner = block({ languages: "Sylvan" });
    const { intent } = send(openSave(opened), draft, live(coOwner));
    assert.equal(intent.kind, "update");
    assert.deepEqual(intent.kind === "update" && intent.patch, { ac: 14 } satisfies MonsterPatch);
    assert.deepEqual(planSave(openSave(opened), opened, live(coOwner)).intent, { kind: "saved" }, "an untouched draft sends nothing");
  });

  test("a lost create the reconnect's snapshot shows was stored: saved", () => {
    const draft = block();
    const sent = send(openSave(null), draft, live(undefined));
    assert.deepEqual(answerSave(sent.save, { answer: "unknown", cause: "snapshot" }, draft, live(draft, 2), "Bree").result, { kind: "saved" });
  });

  test("a lost create the snapshot does not show was not stored: the draft stays and Save sends the create again with the same id", () => {
    const draft = block();
    const sent = send(openSave(null), draft, live(undefined));
    const lost = answerSave(sent.save, { answer: "unknown", cause: "snapshot" }, draft, live(undefined, 2), "Bree");
    assert.deepEqual(lost.result, { kind: "problem", text: "The connection dropped before this stat block was saved. Save it again." });
    assert.equal(planSave(lost.save, draft, live(undefined, 2)).intent.kind, "create");
  });

  test("a create dropped as too old waits for the next snapshot, sending nothing, and then reads it", () => {
    const draft = block();
    const sent = send(openSave(null), draft, live(undefined, 3));
    const lost = answerSave(sent.save, { answer: "unknown", cause: "expired" }, draft, live(undefined, 3), "Bree");
    assert.deepEqual(lost.result, { kind: "checking" });
    assert.deepEqual(planSave(lost.save, draft, live(undefined, 3)).intent, { kind: "busy" }, "no second create while the first may still land");
    assert.equal(settleSave(lost.save, draft, live(undefined, 3)).result, null, "the same snapshot says nothing new");
    assert.deepEqual(settleSave(lost.save, draft, live(draft, 4)).result, { kind: "saved" });
    assert.equal(settleSave(lost.save, draft, live(undefined, 4)).result?.kind, "problem");
  });

  test("a create that landed after a lost answer saves a later change as an update, and waits for it", () => {
    // Create AC 12, its answer lost, the block shown later, the draft changed to AC 99, then Save.
    const first = block({ ac: 12 });
    const sent = send(openSave(null), first, live(undefined));
    const lost = answerSave(sent.save, { answer: "unknown", cause: "snapshot" }, first, live(undefined, 2), "Bree");
    const later = block({ ac: 99 });
    const again = planSave(lost.save, later, live(first, 3));
    assert.equal(again.intent.kind, "update");
    assert.deepEqual(again.intent.kind === "update" && again.intent.patch, { ac: 99 });
    const waiting = markSent(again.save, again.intent as Extract<typeof again.intent, { kind: "update" }>);
    assert.ok(saveHeld(waiting), "the editor waits for the update's answer");
    assert.deepEqual(answerSave(waiting, { answer: "taken" }, later, live(later, 3), "Bree").result, { kind: "saved" });
  });

  test("an answer for an older draft advances the base and keeps the editor open", () => {
    const sentDraft = block({ ac: 13 });
    const sent = send(openSave(block()), sentDraft, live(block()));
    const answered = answerSave(sent.save, { answer: "taken" }, block({ ac: 15 }), live(sentDraft), "Bree");
    assert.deepEqual(answered.result, { kind: "kept" });
    const next = planSave(answered.save, block({ ac: 15 }), live(sentDraft));
    assert.deepEqual(next.intent.kind === "update" && next.intent.patch, { ac: 15 }, "the rest goes as an update against what was stored");
  });

  test("a lost update is judged by its own lines: stored when each reads as it set it", () => {
    const opened = block();
    const draft = block({ ac: 16 });
    const sent = send(openSave(opened), draft, live(opened));
    assert.deepEqual(answerSave(sent.save, { answer: "unknown", cause: "snapshot" }, draft, live(block({ ac: 16, languages: "Sylvan" }), 2), "Bree").result, { kind: "saved" });
    assert.deepEqual(answerSave(sent.save, { answer: "unknown", cause: "snapshot" }, draft, live(opened, 2), "Bree").result, {
      kind: "problem",
      text: "The connection dropped before these changes were saved. Save them again.",
    });
  });

  test("a refusal keeps the draft with the server's words, and the saves budget keeps Save off for a refill", () => {
    const draft = block();
    const sent = send(openSave(null), draft, live(undefined));
    const capped = answerSave(sent.save, { answer: "refused", refusal: { message: "Bree keeps at most 100 stat blocks" } }, draft, live(undefined), "Bree");
    assert.deepEqual(capped.result, { kind: "problem", text: "Bree keeps at most 100 stat blocks." });
    const fast = answerSave(sent.save, { answer: "refused", refusal: { message: BLOCK_SAVES_TOO_FAST } }, draft, live(undefined), "Bree");
    assert.equal(fast.result.kind === "problem" && typeof fast.result.retryInMs, "number");
    assert.ok(!saveHeld(capped.save));
  });

  test("gone: a block deleted or no longer the viewer's, or a new block's character no longer theirs, and never while an answer is awaited", () => {
    assert.equal(saveGone(openSave(block()), live(undefined), true), true, "opened, then gone from the view");
    assert.equal(saveGone(openSave(block()), live(block()), true), false);
    assert.equal(saveGone(openSave(null), live(undefined), false), true, "a new block whose character left");
    assert.equal(saveGone(openSave(null), live(undefined), true), false);
    const sent = send(openSave(block()), block({ ac: 3 }), live(block()));
    assert.equal(saveGone(sent.save, live(undefined), true), false);
  });

  test("dirty reads the draft against the block as the editor opened, so a co-owner's edit then Cancel closes", () => {
    const opened = block({ ac: 12 });
    // The co-owner's AC 14 arrives in the view. The editor's draft is still what it opened with.
    assert.equal(isDirty(opened, opened, ""), false);
    assert.equal(isDirty(opened, block({ ac: 14 }), ""), true);
    assert.equal(isDirty(opened, opened, "Owl"), true, "text in the paste box counts");
  });
});

/** xorshift32, so a failing sequence can be run again from its seed. */
function seeded(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

/**
 * Many random runs of one editor against a model of the server and the
 * store's queue: edits, saves, ops delivered and answered, answers lost to
 * a dropped connection, ops dropped as too old, snapshots, a co-owner's
 * edits, the block deleted, the character's ownership lost and back, and
 * Discard. The invariants the editor must keep in every run:
 *
 * 1. It closes as saved only when every line of the draft that differs
 *    from what it last wrote there (or opened with) is stored as the draft
 *    has it. A line it wrote and a co-owner changed since keeps theirs.
 * 2. Every op it sends names the block it opened with.
 * 3. A create is never sent while one is unanswered or unsure, nor once the
 *    server holds the block: the server never sees an id already in use.
 * 4. An update carries only lines the user changed, so a co-owner's change
 *    to another line is kept.
 * 5. Nothing is sent after it closes, and it never waits forever: once the
 *    connection settles it is either closed, gone, or free to save.
 */
describe("a stat block editor's save, through random sequences (process rule: state machines)", () => {
  type Op = { kind: "create" | "update"; id: string; draft: StatBlock; patch?: MonsterPatch };
  type Queued = { op: Op; delivered: boolean; result?: "taken" | "refused" };

  function run(seed: number, opened: StatBlock | null): void {
    const random = seeded(seed);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const ID = "block-1";
    const trace: string[] = [];
    const fail = (message: string): never => assert.fail(`seed ${seed}: ${message}\n${trace.join("\n")}`);

    const server = { exists: opened !== null, stored: opened as StatBlock | null, owned: true, lastWrite: opened as StatBlock | null, creates: 0, inUse: 0 };
    let connected = true;
    let snapshots = 1;
    let viewStored: StatBlock | undefined = opened ?? undefined;
    const queue: Queued[] = [];
    let save = openSave(opened);
    const initial = opened ?? block({ name: "Wisp" });
    let draft = initial;
    // The last value this editor's own ops wrote to each line the user edits.
    const ours: { name?: string; ac?: number } = {};
    let open = true;
    let closedSaved = false;
    let problem: string | null = null;

    const view = (): BlockLive => ({ stored: viewStored, snapshots });
    // The editor reads whether the character is the viewer's from its view, which lags the server while the connection is down.
    let viewOwned = true;
    const refresh = () => {
      viewStored = server.exists && server.owned && server.stored ? server.stored : undefined;
      viewOwned = server.owned;
    };
    const close = (why: string) => {
      if (!open) return;
      if (why === "saved") {
        // Every line the draft holds apart from what this editor last wrote to it, or opened with, is stored as the draft has it. A line it wrote and someone changed since keeps their later save.
        for (const key of ["name", "ac"] as const) {
          const mine = ours[key] ?? initial[key];
          const held = server.exists && server.stored?.[key] === draft[key];
          if (draft[key] !== mine && !held) fail(`closed with ${key} ${String(draft[key])}, which is not stored (this editor last wrote ${String(ours[key])})`);
        }
        closedSaved = true;
      }
      open = false;
    };
    const handle = (result: SaveResult | null) => {
      if (!result) return;
      if (result.kind === "saved") close("saved");
      else if (result.kind === "problem") problem = result.text;
    };
    const onAnswer = (answer: OpAnswer, cause?: UnknownCause) => {
      if (!open) return;
      const r = answerSave(save, { answer, ...(answer === "refused" ? { refusal: { message: "refused" } } : {}), ...(cause ? { cause } : {}) }, draft, view(), "Bree");
      save = r.save;
      handle(r.result);
    };
    const snapshot = () => {
      snapshots += 1;
      refresh();
      if (!open) return;
      const r = settleSave(save, draft, view());
      save = r.save;
      handle(r.result);
    };
    const apply = (q: Queued) => {
      const { op } = q;
      if (op.kind === "create") {
        server.creates += 1;
        if (server.exists) {
          server.inUse += 1;
          q.result = "refused";
        } else if (!server.owned) q.result = "refused";
        else {
          server.exists = true;
          server.stored = op.draft;
          server.lastWrite = op.draft;
          ours.name = op.draft.name;
          ours.ac = op.draft.ac;
          q.result = "taken";
        }
      } else if (!server.exists || !server.owned) q.result = "refused";
      else {
        server.stored = { ...server.stored!, ...(op.patch as Partial<StatBlock>) };
        server.lastWrite = server.stored;
        if (op.patch && "name" in op.patch) ours.name = op.patch.name;
        if (op.patch && "ac" in op.patch) ours.ac = op.patch.ac;
        q.result = "taken";
      }
      q.delivered = true;
    };

    for (let step = 0; step < 80; step++) {
      const event = pick(["edit", "edit", "save", "save", "deliver", "deliver", "ack", "ack", "drop", "reconnect", "expire", "coOwner", "delete", "ownership", "discard", "resync"] as const);
      trace.push(`${step} ${event}`);
      switch (event) {
        case "edit":
          // The fields are held while a save waits (MonsterEditor's fieldset).
          // Few values, so an edit often puts a line back as it was, or as a co-owner set it.
          if (open && !saveHeld(save)) draft = { ...draft, ...(random() < 0.5 ? { ac: pick([12, 13, 14]) } : { name: pick(["Wisp", "Moth Spirit"]) }) };
          break;
        case "save": {
          if (!open || saveGone(save, view(), viewOwned)) break;
          const planned = planSave(save, draft, view());
          save = planned.save;
          const intent = planned.intent;
          if (intent.kind === "saved") close("saved");
          else if (intent.kind === "create" || intent.kind === "update") {
            if (intent.kind === "create" && (server.exists || queue.some((q) => q.op.kind === "create"))) fail("a create sent while the block exists or another is unanswered");
            if (intent.kind === "update" && "languages" in intent.patch) fail("an update carried a line the user never changed, over a co-owner's");
            queue.push({ op: { kind: intent.kind, id: ID, draft: intent.draft, ...(intent.kind === "update" ? { patch: intent.patch } : {}) }, delivered: false });
            save = markSent(save, intent);
            problem = null;
          }
          break;
        }
        case "deliver": {
          const next = queue.find((q) => !q.delivered);
          if (connected && next) {
            apply(next);
            refresh();
          }
          break;
        }
        case "ack":
          if (connected && queue[0]?.delivered) {
            const q = queue.shift()!;
            onAnswer(q.result!);
          }
          break;
        case "drop":
          connected = false;
          break;
        case "expire":
          // Ops too old to send are dropped while the store prepares its hello, before the snapshot: some may have been delivered on the old socket.
          if (!connected && queue.length > 0) {
            const q = queue.shift()!;
            if (!q.delivered && random() < 0.5) apply(q);
            onAnswer("unknown", "expired");
          }
          break;
        case "reconnect":
          if (!connected) {
            connected = true;
            // The snapshot covers every op the server took: their answers are lost and told after it, as store.ts applySnapshot does.
            const settled = queue.filter((q) => q.delivered);
            queue.splice(0, queue.length, ...queue.filter((q) => !q.delivered));
            snapshot();
            settled.forEach(() => onAnswer("unknown", "snapshot"));
          }
          break;
        case "resync":
          if (connected) snapshot();
          break;
        case "coOwner":
          if (server.exists && server.stored) {
            // Another line, or one the user edits too, where the later save wins.
            server.stored = { ...server.stored, ...(random() < 0.5 ? { languages: pick(["Sylvan", "Common", ""]) } : { ac: pick([12, 13, 14]) }) };
            if (connected) refresh();
          }
          break;
        case "delete":
          if (random() < 0.3) {
            server.exists = false;
            server.stored = null;
            if (connected) refresh();
          }
          break;
        case "ownership":
          server.owned = !server.owned;
          if (connected) refresh();
          break;
        case "discard":
          if (random() < 0.2) open = false;
          break;
      }
      for (const q of queue) if (q.op.id !== ID) fail("an op named another block");
      const b = (x: StatBlock | null | undefined) => (x ? `${x.name}/${x.ac}` : "-");
      trace[trace.length - 1] += ` open=${open} pending=${save.pending?.kind ?? "-"} unsure=${save.unsure ? "y" : "n"} base=${b(save.base)} draft=${b(draft)} server=${server.exists ? b(server.stored) : "none"} last=${b(server.lastWrite)} view=${b(viewStored)} owned=${server.owned}/${viewOwned} up=${connected} queue=${queue.map((q) => `${q.op.kind}${q.delivered ? "!" : ""}`).join(",")}`;
    }

    // Settle: reconnect, deliver and answer everything, and take a snapshot.
    if (!connected) {
      connected = true;
      const settled = queue.filter((q) => q.delivered);
      queue.splice(0, queue.length, ...queue.filter((q) => !q.delivered));
      snapshot();
      settled.forEach(() => onAnswer("unknown", "snapshot"));
    }
    while (queue.length > 0) {
      const q = queue[0]!;
      if (!q.delivered) apply(q);
      queue.shift();
      refresh();
      onAnswer(q.result!);
    }
    snapshot();
    if (open) assert.ok(!saveHeld(save), `seed ${seed}: still waiting once everything settled\n${trace.join("\n")}`);
    // Owned and not deleted, a last Save closes it, unless a refusal holds it.
    if (open && server.owned && !saveGone(save, view(), true) && problem === null) {
      const planned = planSave(save, draft, view());
      save = planned.save;
      if (planned.intent.kind === "saved") close("saved");
      else if (planned.intent.kind === "create" || planned.intent.kind === "update") {
        if (planned.intent.kind === "create" && server.exists) fail("a create sent while the block exists");
        const q: Queued = { op: { kind: planned.intent.kind, id: ID, draft: planned.intent.draft, ...(planned.intent.kind === "update" ? { patch: planned.intent.patch } : {}) }, delivered: false };
        save = markSent(save, planned.intent);
        apply(q);
        refresh();
        onAnswer(q.result!);
      }
      assert.ok(!open || !server.owned || saveGone(save, view(), true), `seed ${seed}: a last Save on a reachable block left the editor open\n${trace.join("\n")}`);
    }
    assert.equal(server.inUse, 0, `seed ${seed}: the server saw a create for an id in use`);
    assert.ok(server.creates <= (opened ? 0 : server.creates), "an editor of an existing block never creates");
    if (closedSaved && !opened) assert.ok(server.creates >= 1, "a new block closed as saved was created");
  }

  test("a new block: 5000 random runs", () => {
    for (let seed = 1; seed <= 5000; seed++) run(seed, null);
  });

  test("an existing block: 5000 random runs", () => {
    for (let seed = 1; seed <= 5000; seed++) run(seed * 7919, block());
  });
});
