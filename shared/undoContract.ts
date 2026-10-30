import { z } from "zod";

export type UndoScope = "play" | "setup" | "none";
export type HistoryScope = Exclude<UndoScope, "none">;
export type HistoryDirection = "undo" | "redo";

/** The sender's accepted command, classified against its own committed before/after states. */
export type OpAcknowledgment = {
  n: number;
  scope: UndoScope;
  /** A semantic state change the sender may read. Revisions and geometry cache versions alone do not count. */
  changed: boolean;
};

export type HistoryTarget = {
  head: string;
  scope?: HistoryScope;
  log?: never;
};

export type StackHistoryCommand = HistoryTarget & (
  | {
      t: "undo";
      scope?: "play";
      of?: number;
      forget?: number;
      discard?: never;
    }
  | {
      t: "undo";
      scope: "setup";
      of?: never;
      forget?: number;
      discard?: never;
    }
  | {
      t: "redo";
      of?: never;
      forget?: number;
      discard?: never;
    }
);

export type DiscardHistoryCommand = HistoryTarget & {
  t: HistoryDirection;
  discard: true;
  of?: never;
  forget?: never;
};

export type HpLogUndoCommand = {
  t: "undo";
  log: string;
  head?: never;
  scope?: never;
  of?: never;
  forget?: never;
  discard?: never;
};

export type HistoryBlocker = {
  scope: HistoryScope;
  direction: HistoryDirection;
  label: string;
  buried: boolean;
};

export type HistoryHead = {
  id: string;
  label: string;
  retained?: HistoryBlocker;
};

export type HistoryStack = {
  head: HistoryHead | null;
  depth: number;
};

export type ScopeHistory = {
  undo: HistoryStack;
  redo: HistoryStack;
};

export type HistoryMessage = {
  t: "history";
  epoch: string;
  seq: number;
  serial: number;
  watermark: number;
  play: ScopeHistory;
  setup?: ScopeHistory;
};

export type UndoGroupOptions = {
  group?: string;
  groupScope?: "setup";
};

export type RestoreHistoryFields = {
  scope?: HistoryScope;
  correction?: { label: string };
};

export type CorrectionLogEvent = {
  type: "correction";
  from: HistoryDirection;
  scope: HistoryScope;
  label?: string;
  name?: string;
};

const historyScope = z.enum(["play", "setup"]);
const historyDirection = z.enum(["undo", "redo"]);
const historyText = z.string().max(200);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const commandNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const opAcknowledgmentSchema = z.strictObject({
  n: commandNumber,
  scope: z.enum(["play", "setup", "none"]),
  changed: z.boolean(),
}) satisfies z.ZodType<OpAcknowledgment>;

const absent = z.never().optional();
const reloadMessage = "Reload to use Undo";
const targetFields = {
  head: z.uuid({ error: (issue) => issue.input === undefined ? reloadMessage : undefined }),
  scope: historyScope.optional(),
  log: absent,
};
const stackFields = { ...targetFields, forget: commandNumber.optional(), discard: absent };

// Role, origin, retention, and current-head checks need live room state.
export const historyCommandSchema = z.union([
  z.strictObject({ t: z.literal("undo"), ...stackFields, scope: z.literal("play").optional(), of: commandNumber.optional() }),
  z.strictObject({ t: z.literal("undo"), ...stackFields, scope: z.literal("setup"), of: absent }),
  z.strictObject({ t: z.literal("redo"), ...stackFields, of: absent }),
  z.strictObject({ t: z.literal("undo"), ...targetFields, discard: z.literal(true), of: absent, forget: absent }),
  z.strictObject({ t: z.literal("redo"), ...targetFields, discard: z.literal(true), of: absent, forget: absent }),
  z.strictObject({
    t: z.literal("undo"),
    // Keep the existing log ID format without importing protocol.ts, which will consume this contract.
    log: z.string().regex(/^\d{1,18}:\d{1,6}$/),
    head: absent,
    scope: absent,
    of: absent,
    forget: absent,
    discard: absent,
  }),
], {
  // The union's top-level issue is what a terminal protocol refusal displays.
  error: ({ input }) => {
    if (typeof input !== "object" || input === null || !("t" in input)) return undefined;
    if (input.t !== "undo" && input.t !== "redo") return undefined;
    if (("head" in input && input.head !== undefined) || ("log" in input && input.log !== undefined)) return undefined;
    return reloadMessage;
  },
}) satisfies z.ZodType<StackHistoryCommand | DiscardHistoryCommand | HpLogUndoCommand>;

function scopeHistorySchema(scope: HistoryScope) {
  const stack = z.strictObject({
    head: z.strictObject({
      id: z.uuid(),
      label: historyText,
      retained: z.strictObject({
        scope: z.literal(scope === "play" ? "setup" : "play"),
        direction: historyDirection,
        label: historyText,
        buried: z.boolean(),
      }).optional(),
    }).nullable(),
    depth: z.number().int().min(0).max(50),
  }).refine((s) => (s.head === null) === (s.depth === 0), { message: "an empty history has no head", path: ["head"] });
  return z.strictObject({ undo: stack, redo: stack });
}

export const historyMessageSchema = z.strictObject({
  t: z.literal("history"),
  epoch: z.uuid(),
  seq: counter,
  serial: counter,
  watermark: counter,
  play: scopeHistorySchema("play"),
  setup: scopeHistorySchema("setup").optional(),
}) satisfies z.ZodType<HistoryMessage>;

export const restoreHistoryFieldsSchema = z.strictObject({
  scope: historyScope.optional(),
  correction: z.strictObject({ label: historyText }).optional(),
}) satisfies z.ZodType<RestoreHistoryFields>;

export const correctionLogEventSchema = z.strictObject({
  type: z.literal("correction"),
  from: historyDirection,
  scope: historyScope,
  label: historyText.optional(),
  name: historyText.optional(),
}) satisfies z.ZodType<CorrectionLogEvent>;
