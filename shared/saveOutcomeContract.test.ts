import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "./ids.ts";
import { serializedBytes } from "./limits.ts";
import { MAX_OP_AGE_MS } from "./pendingOps.ts";
import {
  SAVE_DRAFT_BYTES, SAVE_OUTCOME_CLOCK_LEAD_MS, SAVE_OUTCOME_LEDGER_BYTES,
  SAVE_OUTCOME_OP_VERSION, SAVE_OUTCOME_RECORD_BYTES, SAVE_OUTCOME_RECORDS,
  SAVE_OUTCOME_RETENTION_MS, SAVE_OUTCOME_SNAPSHOT_VERSION,
  saveOutcomeLedgerSchema, saveOutcomePageSchema, saveOutcomeRecordSchema,
  saveOutcomeTransitionSchema, savePageAskFieldsSchema, savePageCloseFieldsSchema,
  saveRechargeSpendSchema,
} from "./saveOutcomeContract.ts";

const id = uuidv7();
const record = { memberId: "dm", plan: id, revision: 1, state: "applied", firstAppliedAt: "2026-10-31T12:00:00.000Z", seq: 0 };
const spend = { target: { tokenId: "dragon" }, use: { kind: "ability", key: "srd:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5, ifReady: true } };

test("save contract fixes versions, pending age and independent retention/storage limits", () => {
  assert.deepEqual([SAVE_OUTCOME_OP_VERSION, SAVE_OUTCOME_SNAPSHOT_VERSION], [35, 31]);
  assert.equal(MAX_OP_AGE_MS, 12 * 60 * 60 * 1000);
  assert.equal(SAVE_OUTCOME_RETENTION_MS, 24 * 60 * 60 * 1000);
  assert.equal(SAVE_OUTCOME_CLOCK_LEAD_MS, 5 * 60 * 1000);
  assert.deepEqual([SAVE_OUTCOME_RECORDS, SAVE_OUTCOME_RECORD_BYTES, SAVE_OUTCOME_LEDGER_BYTES, SAVE_DRAFT_BYTES], [200, 512, 102400, 524288]);
});

test("save page and transition require UUIDv7 identities and safe nonnegative revisions", () => {
  assert.ok(saveOutcomePageSchema.safeParse({ id, expectRevision: 0 }).success);
  assert.ok(saveOutcomeTransitionSchema.safeParse({ id, plan: id, expectRevision: Number.MAX_SAFE_INTEGER, state: "undone" }).success);
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1"]) {
    assert.equal(saveOutcomePageSchema.safeParse({ id, expectRevision: invalid }).success, false);
    assert.equal(saveOutcomeTransitionSchema.safeParse({ id, plan: id, expectRevision: invalid, state: "undone" }).success, false);
  }
  for (const invalid of ["page-1", "550e8400-e29b-41d4-a716-446655440000", ""]) {
    assert.equal(saveOutcomePageSchema.safeParse({ id: invalid, expectRevision: 0 }).success, false);
    assert.equal(saveOutcomeTransitionSchema.safeParse({ id, plan: invalid, expectRevision: 1, state: "undone" }).success, false);
  }
  assert.equal(saveOutcomePageSchema.safeParse({ id, expectRevision: 0, extra: true }).success, false);
  assert.equal(saveOutcomeTransitionSchema.safeParse({ id, plan: id, expectRevision: 1, state: "missing" }).success, false);
  assert.equal(saveOutcomeTransitionSchema.safeParse({ id, plan: id, expectRevision: 1, state: "undone", rev: 1 }).success, false);
});

test("stored lifecycle records reject generic rev, invalid counters and non-envelope timestamps", () => {
  assert.ok(saveOutcomeRecordSchema.safeParse(record).success);
  for (const patch of [
    { rev: 1 }, { revision: 0 }, { revision: -1 }, { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { seq: -1 }, { seq: 0.5 },
    { seq: Number.MAX_SAFE_INTEGER + 1 }, { memberId: "" }, { memberId: "x".repeat(65) },
    { firstAppliedAt: "yesterday" }, { firstAppliedAt: "2026-10-31T12:00:00Z" },
    { state: "unknown" }, { plan: "old-plan" },
  ]) assert.equal(saveOutcomeRecordSchema.safeParse({ ...record, ...patch }).success, false, JSON.stringify(patch));
  const tooLarge = { ...record, memberId: "界".repeat(64) };
  assert.ok(serializedBytes(tooLarge) <= SAVE_OUTCOME_RECORD_BYTES);
  assert.ok(saveOutcomeRecordSchema.safeParse(tooLarge).success);
  const escaped = { ...record, memberId: "\ud800".repeat(64), revision: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER };
  assert.ok(serializedBytes(escaped) > SAVE_OUTCOME_RECORD_BYTES);
  assert.equal(saveOutcomeRecordSchema.safeParse(escaped).success, false, "JSON escapes count toward stored bytes");
});

test("ledger validates map keys, records and the record-count cap", () => {
  assert.ok(saveOutcomeLedgerSchema.safeParse({}).success);
  assert.ok(saveOutcomeLedgerSchema.safeParse({ [id]: record }).success);
  assert.equal(saveOutcomeLedgerSchema.safeParse({ arbitrary: record }).success, false);
  assert.equal(saveOutcomeLedgerSchema.safeParse({ [id]: { ...record, rev: 1 } }).success, false);
  const full = Object.fromEntries(Array.from({ length: 200 }, () => [uuidv7(), record]));
  assert.ok(saveOutcomeLedgerSchema.safeParse(full).success);
  assert.equal(saveOutcomeLedgerSchema.safeParse({ ...full, [uuidv7()]: record }).success, false);
  // Unicode and maximum counters remain bounded after JSON serialization.
  const wideRecord = { ...record, memberId: "😀".repeat(32), revision: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER };
  const wide = Object.fromEntries(Array.from({ length: 200 }, () => [uuidv7(), wideRecord]));
  assert.ok(saveOutcomeRecordSchema.safeParse(wideRecord).success);
  assert.ok(serializedBytes(wide) <= SAVE_OUTCOME_LEDGER_BYTES);
  const escapedRecord = { ...record, memberId: "\ud800".repeat(50), revision: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER };
  assert.ok(saveOutcomeRecordSchema.safeParse(escapedRecord).success);
  const overBytes = Object.fromEntries(Array.from({ length: 200 }, () => [uuidv7(), escapedRecord]));
  assert.ok(serializedBytes(overBytes) > SAVE_OUTCOME_LEDGER_BYTES);
  assert.equal(saveOutcomeLedgerSchema.safeParse(overBytes).success, false, "map keys count toward the aggregate byte cap");
});

test("page reasons are optional, strict and replacement lists are bounded unique whole-value hashes", () => {
  for (const schema of [savePageAskFieldsSchema, savePageCloseFieldsSchema]) {
    assert.ok(schema.safeParse({}).success);
    assert.ok(schema.safeParse({ reason: "savePage" }).success);
    assert.equal(schema.safeParse({ reason: "other" }).success, false);
    assert.equal(schema.safeParse({ reason: "savePage", extra: true }).success, false);
  }
  const replacement = { id: "old", expectHash: "0123456789abcdef0123456789abcdef" };
  const fields = { reason: "savePage", replaces: [replacement] };
  assert.ok(savePageAskFieldsSchema.safeParse(fields).success);
  assert.equal(savePageAskFieldsSchema.safeParse({ replaces: [replacement] }).success, false);
  assert.equal(savePageAskFieldsSchema.safeParse({ ...fields, replaces: [] }).success, false);
  assert.equal(savePageAskFieldsSchema.safeParse({ ...fields, replaces: [replacement, replacement] }).success, false);
  for (const hash of ["A".repeat(32), "a".repeat(31), "g".repeat(32), 1]) {
    assert.equal(savePageAskFieldsSchema.safeParse({ ...fields, replaces: [{ ...replacement, expectHash: hash }] }).success, false);
  }
  const list = Array.from({ length: 20 }, (_, i) => ({ ...replacement, id: `r${i}` }));
  assert.ok(savePageAskFieldsSchema.safeParse({ reason: "savePage", replaces: list }).success);
  assert.equal(savePageAskFieldsSchema.safeParse({ reason: "savePage", replaces: [...list, { ...replacement, id: "r20" }] }).success, false);
  assert.equal(savePageCloseFieldsSchema.safeParse(fields).success, false);
});

test("embedded recharge accepts exactly the existing restricted ability spend", () => {
  assert.ok(saveRechargeSpendSchema.safeParse(spend).success);
  assert.ok(saveRechargeSpendSchema.safeParse({ ...spend, target: { characterId: "pc" }, quiet: true }).success);
  for (const patch of [{ kind: "resist" }, { limit: "day" }, { max: 2 }, { min: 1 }, { min: 7 }, { ifReady: false }, { key: "bad key" }, { name: "bad\nname" }, { back: true }]) {
    assert.equal(saveRechargeSpendSchema.safeParse({ ...spend, use: { ...spend.use, ...patch } }).success, false, JSON.stringify(patch));
  }
  for (const patch of [{ back: true }, { plan: id }, { quiet: false }, { target: { tokenId: "dragon", characterId: "pc" } }]) {
    assert.equal(saveRechargeSpendSchema.safeParse({ ...spend, ...patch }).success, false);
  }
});
