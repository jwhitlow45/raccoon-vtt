import { z } from "zod";
import { LIMITS, serializedBytes } from "./limits.ts";
import type { ActorTarget } from "./protocol.ts";

export const SAVE_OUTCOME_OP_VERSION = 35;
export const SAVE_OUTCOME_SNAPSHOT_VERSION = 31;
export const SAVE_OUTCOME_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SAVE_OUTCOME_CLOCK_LEAD_MS = 5 * 60 * 1000;
export const SAVE_OUTCOME_RECORDS = 200;
export const SAVE_OUTCOME_RECORD_BYTES = 512;
export const SAVE_OUTCOME_LEDGER_BYTES = 100 * 1024;
export const SAVE_DRAFT_BYTES = 512 * 1024;

export type SaveOutcomeState = "applied" | "undone";
export type SaveOutcomeIdentity = { id: string; plan: string };
export type SaveOutcomePage = { id: string; expectRevision: number };

export type SaveOutcomeRecord = {
  memberId: string;
  plan: string;
  revision: number;
  state: SaveOutcomeState;
  firstAppliedAt: string;
  seq: number;
};

export type SaveOutcomeLedger = Record<string, SaveOutcomeRecord>;

export type SaveOutcomeTransition = SaveOutcomeIdentity & {
  expectRevision: number;
  state: SaveOutcomeState;
};

export type SaveRequestReplacement = { id: string; expectHash: string };
export type SavePageReason = "savePage";
export type SavePageAskFields = {
  reason?: SavePageReason;
  replaces?: SaveRequestReplacement[];
};
export type SavePageCloseFields = { reason?: SavePageReason };

export type SaveRechargeSpend = {
  target: ActorTarget;
  use: {
    kind: "ability";
    key: string;
    name: string;
    limit: "recharge";
    max: 1;
    min: 2 | 3 | 4 | 5 | 6;
    ifReady: true;
  };
  quiet?: true;
};

export type SaveOutcomeFields = {
  page?: SaveOutcomePage;
  recharge?: SaveRechargeSpend;
};
export type SaveOutcomeRestoreFields = {
  saveOutcome?: SaveOutcomeTransition;
};

const id = z.string().min(1).max(64);
const outcomeId = z.uuidv7();
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const state = z.enum(["applied", "undone"]);

export const saveOutcomePageSchema = z.strictObject({
  id: outcomeId,
  expectRevision: counter,
}) satisfies z.ZodType<SaveOutcomePage>;

export const saveOutcomeRecordSchema = z.strictObject({
  memberId: id,
  plan: outcomeId,
  revision: counter.min(1),
  state,
  firstAppliedAt: z.iso.datetime({ precision: 3 }),
  seq: counter,
}).refine((record) => serializedBytes(record) <= SAVE_OUTCOME_RECORD_BYTES, {
  message: "a save outcome record exceeds its byte limit",
}) satisfies z.ZodType<SaveOutcomeRecord>;

export const saveOutcomeLedgerSchema = z.record(outcomeId, saveOutcomeRecordSchema)
  .refine((ledger) => Object.keys(ledger).length <= SAVE_OUTCOME_RECORDS, { message: "too many save outcome records" })
  .refine((ledger) => serializedBytes(ledger) <= SAVE_OUTCOME_LEDGER_BYTES, { message: "the save outcome ledger exceeds its byte limit" }) satisfies z.ZodType<SaveOutcomeLedger>;

export const saveOutcomeTransitionSchema = z.strictObject({
  id: outcomeId,
  plan: outcomeId,
  expectRevision: counter,
  state,
}) satisfies z.ZodType<SaveOutcomeTransition>;

const replacements = z.array(z.strictObject({
  id,
  expectHash: z.string().regex(/^[0-9a-f]{32}$/),
})).min(1).max(LIMITS.openRollsPerRoom)
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, { message: "a roll request is replaced twice" });

export const savePageAskFieldsSchema = z.strictObject({
  reason: z.literal("savePage").optional(),
  replaces: replacements.optional(),
}).refine((fields) => fields.replaces === undefined || fields.reason === "savePage", {
  message: "only a save page replaces roll requests",
  path: ["reason"],
}) satisfies z.ZodType<SavePageAskFields>;

export const savePageCloseFieldsSchema = z.strictObject({
  reason: z.literal("savePage").optional(),
}) satisfies z.ZodType<SavePageCloseFields>;

// Match actor.use's target, key and single-line name rules without importing
// protocol.ts at runtime, since it will consume this contract.
export const saveRechargeSpendSchema = z.strictObject({
  target: z.union([z.strictObject({ tokenId: id }), z.strictObject({ characterId: id })]),
  use: z.strictObject({
    kind: z.literal("ability"),
    key: z.string().max(LIMITS.useKeyChars).regex(/^[a-z][A-Za-z]*:[a-z0-9]+(?:-[a-z0-9]+)*$/, "not an ability key"),
    name: z.string().max(LIMITS.useNameChars).regex(/^[^\p{Cc}\u2028\u2029]*$/u, "control characters are not allowed").min(1),
    limit: z.literal("recharge"),
    max: z.literal(1),
    min: z.literal([2, 3, 4, 5, 6]),
    ifReady: z.literal(true),
  }),
  quiet: z.literal(true).optional(),
}) satisfies z.ZodType<SaveRechargeSpend>;
