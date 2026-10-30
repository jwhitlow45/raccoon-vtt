import assert from "node:assert/strict";
import { test } from "node:test";
import {
  correctionLogEventSchema,
  historyCommandSchema,
  historyMessageSchema,
  opAcknowledgmentSchema,
  restoreHistoryFieldsSchema,
  type DiscardHistoryCommand,
  type HistoryMessage,
  type HpLogUndoCommand,
  type StackHistoryCommand,
} from "./undoContract.ts";

const HEAD = "ed2ac974-6d6a-4f26-8c30-80971f204a3d";
const EPOCH = "019a30d0-2770-7000-8000-000000000001";
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(schema.safeParse(value).success, JSON.stringify(value));
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(!schema.safeParse(value).success, JSON.stringify(value));
const summary = (): HistoryMessage => ({
  t: "history", epoch: EPOCH, seq: 0, serial: 0, watermark: 0,
  play: { undo: { head: { id: HEAD, label: "moving a token" }, depth: 1 }, redo: { head: null, depth: 0 } },
  setup: { undo: { head: null, depth: 0 }, redo: { head: { id: HEAD, label: "changing a sheet" }, depth: 1 } },
});

test("operation acknowledgments require a positive safe number, known scope and boolean effect with no private fields", () => {
  for (const scope of ["play", "setup", "none"]) for (const changed of [false, true]) {
    for (const n of [1, Number.MAX_SAFE_INTEGER]) {
      const detail = { n, scope, changed };
      assert.deepEqual(opAcknowledgmentSchema.parse(detail), detail);
    }
  }
  const detail = { n: 1, scope: "setup", changed: true };
  for (const n of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"]) bad(opAcknowledgmentSchema, { ...detail, n });
  for (const patch of [{ scope: "unknown" }, { changed: 1 }, { changed: "true" }, { privateLabel: "secret" }, { head: HEAD }, { key: "token:hidden" }]) bad(opAcknowledgmentSchema, { ...detail, ...patch });
  for (const field of ["n", "scope", "changed"] as const) {
    const { [field]: _missing, ...incomplete } = detail;
    bad(opAcknowledgmentSchema, incomplete);
  }
});

test("stack commands preserve explicit scopes and the omitted Play default", () => {
  const commands: StackHistoryCommand[] = [
    { t: "undo", head: HEAD }, { t: "undo", head: HEAD, scope: "play", of: 1, forget: 1 },
    { t: "undo", head: HEAD, scope: "setup", forget: 1 },
    { t: "redo", head: HEAD }, { t: "redo", head: HEAD, scope: "play", forget: 1 },
    { t: "redo", head: HEAD, scope: "setup", forget: 1 },
  ];
  for (const command of commands) assert.deepEqual(historyCommandSchema.parse(command), command);
  for (const t of ["undo", "redo"]) {
    bad(historyCommandSchema, { t, head: HEAD, scope: "none" });
    bad(historyCommandSchema, { t, head: HEAD, extra: true });
  }
  bad(historyCommandSchema, { t: "undo", head: HEAD, scope: "setup", of: 1 });
  for (const scope of [undefined, "play", "setup"]) bad(historyCommandSchema, { t: "redo", head: HEAD, scope, of: 1 });
  bad(historyCommandSchema, { t: "restore", head: HEAD });
});

test("a missing stack head gives the terminal reload message", () => {
  for (const t of ["undo", "redo"]) {
    for (const fields of [{}, { scope: "play" }, { scope: "setup" }, { forget: 1 }, { of: 1 }, { discard: true }]) {
      const parsed = historyCommandSchema.safeParse({ t, ...fields });
      assert.equal(parsed.success, false);
      if (!parsed.success) assert.equal(parsed.error.issues[0]?.message, "Reload to use Undo");
    }
  }
});

test("command heads are UUIDs and command numbers are positive safe integers", () => {
  for (const head of ["", "head", HEAD.slice(1), "g" + HEAD.slice(1), null, 1]) bad(historyCommandSchema, { t: "undo", head });
  for (const field of ["of", "forget"]) {
    for (const n of [1, Number.MAX_SAFE_INTEGER]) ok(historyCommandSchema, { t: "undo", head: HEAD, [field]: n });
    for (const n of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"]) bad(historyCommandSchema, { t: "undo", head: HEAD, [field]: n });
  }
});

test("HP Log Undo keeps the bounded log ID and excludes every stack field", () => {
  const command: HpLogUndoCommand = { t: "undo", log: "123:0" };
  assert.deepEqual(historyCommandSchema.parse(command), command);
  ok(historyCommandSchema, { t: "undo", log: "9".repeat(18) + ":" + "9".repeat(6) });
  for (const log of ["", "123", HEAD, "-1:0", "1:0.5", "9".repeat(19) + ":0", "1:" + "9".repeat(7)]) bad(historyCommandSchema, { t: "undo", log });
  for (const fields of [{ head: HEAD }, { scope: "play" }, { scope: "setup" }, { of: 1 }, { forget: 1 }, { discard: true }]) bad(historyCommandSchema, { ...command, ...fields });
  bad(historyCommandSchema, { t: "redo", log: "123:0" });
});

test("discard names a head in either direction and excludes of and forget", () => {
  for (const t of ["undo", "redo"] as const) {
    for (const scope of [undefined, "play", "setup"] as const) {
      const command: DiscardHistoryCommand = { t, head: HEAD, scope, discard: true };
      assert.deepEqual(historyCommandSchema.parse(command), command);
      for (const fields of [{ of: 1 }, { forget: 1 }, { log: "1:0" }, { discard: false }]) bad(historyCommandSchema, { ...command, ...fields });
    }
  }
});

test("history summaries accept player and DM shapes and require every coverage field", () => {
  const dm = summary();
  assert.deepEqual(historyMessageSchema.parse(dm), dm);
  const { setup: _setup, ...player } = dm;
  assert.deepEqual(historyMessageSchema.parse(player), player);
  for (const field of ["t", "epoch", "seq", "serial", "watermark", "play"] as const) {
    const { [field]: _missing, ...incomplete } = dm;
    bad(historyMessageSchema, incomplete);
  }
  bad(historyMessageSchema, { ...dm, t: "snapshot" });
  for (const field of ["seq", "serial", "watermark"] as const) {
    ok(historyMessageSchema, { ...dm, [field]: Number.MAX_SAFE_INTEGER });
    for (const n of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "0"]) bad(historyMessageSchema, { ...dm, [field]: n });
  }
});

test("each history stack has depth 0 to 50 and a null head exactly at zero", () => {
  for (const scope of ["play", "setup"] as const) {
    for (const direction of ["undo", "redo"] as const) {
      const message = summary();
      const set = (head: unknown, depth: unknown) => ({ ...message, [scope]: { ...message[scope], [direction]: { head, depth } } });
      const head = { id: HEAD, label: "moving a token" };
      ok(historyMessageSchema, set(null, 0));
      for (const depth of [1, 50]) ok(historyMessageSchema, set(head, depth));
      bad(historyMessageSchema, set(head, 0));
      for (const depth of [1, 50]) bad(historyMessageSchema, set(null, depth));
      for (const depth of [-1, 0.5, 51, Infinity, "1"]) bad(historyMessageSchema, set(head, depth));
    }
  }
});

test("epochs and all summary heads are UUIDs", () => {
  for (const id of ["", "opaque", HEAD.slice(1), "g" + HEAD.slice(1), null, 1]) {
    bad(historyMessageSchema, { ...summary(), epoch: id });
    for (const scope of ["play", "setup"] as const) {
      for (const direction of ["undo", "redo"] as const) {
        const message = summary();
        bad(historyMessageSchema, { ...message, [scope]: { ...message[scope], [direction]: { head: { id, label: "step" }, depth: 1 } } });
      }
    }
  }
});

test("retained heads name only the other scope with a direction and burial flag", () => {
  for (const scope of ["play", "setup"] as const) {
    const other = scope === "play" ? "setup" : "play";
    for (const direction of ["undo", "redo"]) {
      for (const buried of [false, true]) {
        const retained = { scope: other, direction, label: "changing a sheet", buried };
        const message = summary();
        const set = (value: unknown) => ({ ...message, [scope]: { undo: { head: { id: HEAD, label: "step", retained: value }, depth: 1 }, redo: { head: null, depth: 0 } } });
        ok(historyMessageSchema, set(retained));
        for (const fields of [{ scope }, { scope: "none" }, { direction: "retry" }, { buried: "false" }, { extra: true }]) bad(historyMessageSchema, set({ ...retained, ...fields }));
        for (const field of ["scope", "direction", "label", "buried"] as const) {
          const { [field]: _missing, ...incomplete } = retained;
          bad(historyMessageSchema, set(incomplete));
        }
      }
    }
  }
});

test("all summary objects are strict", () => {
  const message = summary();
  const stack = message.play.undo;
  for (const value of [
    { ...message, extra: true },
    { ...message, play: { ...message.play, extra: true } },
    { ...message, play: { ...message.play, undo: { ...stack, extra: true } } },
    { ...message, play: { ...message.play, undo: { ...stack, head: { ...stack.head, extra: true } } } },
  ]) bad(historyMessageSchema, value);
});

test("labels and correction names stop at 200 characters", () => {
  for (const size of [200, 201]) {
    const text = "x".repeat(size);
    const check = size === 200 ? ok : bad;
    const message = summary();
    check(historyMessageSchema, { ...message, play: { ...message.play, undo: { head: { id: HEAD, label: text }, depth: 1 } } });
    check(historyMessageSchema, { ...message, play: { ...message.play, undo: { head: { id: HEAD, label: "step", retained: { scope: "setup", direction: "undo", label: text, buried: false } }, depth: 1 } } });
    check(restoreHistoryFieldsSchema, { correction: { label: text } });
    for (const field of ["label", "name"]) check(correctionLogEventSchema, { type: "correction", from: "undo", scope: "play", [field]: text });
  }
});

test("restore history fields stay optional for stored legacy restores and reject live heads", () => {
  for (const value of [{}, { scope: "play" }, { scope: "setup", correction: { label: "changing a sheet" } }, { correction: { label: "step" } }]) assert.deepEqual(restoreHistoryFieldsSchema.parse(value), value);
  for (const value of [{ scope: "none" }, { head: HEAD }, { correction: {} }, { correction: { label: "step", name: "Bree" } }, { extra: true }]) bad(restoreHistoryFieldsSchema, value);
});

test("correction events require direction and scope and exclude private evidence fields", () => {
  for (const from of ["undo", "redo"]) {
    for (const scope of ["play", "setup"]) {
      const event = { type: "correction", from, scope };
      for (const fields of [{}, { label: "changing a sheet" }, { name: "Bree" }, { label: "changing a sheet", name: "Bree" }]) assert.deepEqual(correctionLogEventSchema.parse({ ...event, ...fields }), { ...event, ...fields });
      for (const fields of [{ type: "hp" }, { from: "discard" }, { scope: "none" }, { tokenId: "t1" }, { memberId: "p1" }, { total: 2 }]) bad(correctionLogEventSchema, { ...event, ...fields });
      for (const field of ["type", "from", "scope"] as const) {
        const { [field]: _missing, ...incomplete } = event;
        bad(correctionLogEventSchema, incomplete);
      }
    }
  }
});
