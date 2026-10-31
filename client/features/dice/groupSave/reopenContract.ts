import { z } from "zod";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { ABILITY_KEYS, CONDITION_KEYS, SKILL_KEYS } from "#shared/model.ts";
import {
  actorTargetSchema,
  castSchemas,
  clientOpSchema,
  combatUseSchemas,
  diceSchemas,
  dmToolSchemas,
  MAX_DAMAGE_PARTS,
  rollAnswerSchemas,
} from "#shared/protocol.ts";
import { DAMAGE_TYPES } from "#shared/rules/damage.ts";
import { SAVE_DRAFT_BYTES, type SaveOutcomeIdentity } from "#shared/saveOutcomeContract.ts";
import type { Page, PageCast } from "./chain.ts";
import type { RowState } from "./rows.ts";

export type SaveChoices = {
  sceneId: Page["sceneId"];
  phase: "setup" | "rolled";
  source: Page["source"];
  fill: Page["fill"];
  test: Page["test"];
  dc: Page["dc"];
  secret: Page["secret"];
  spell: Page["spell"];
  switches: Page["switches"];
  rows: Page["rows"];
  states: Record<string, Omit<RowState, "batch" | "status" | "says">>;
  outcome: Page["outcome"];
  rolls: { tag: string; holders: string[] }[];
  requests: { rollId: string; holders: string[] }[];
  dmRolls: { tag: string; holder: string }[];
  damage: { tag: string; amounts: (number | null)[]; imported?: true } | null;
  rolledAt?: string;
  cast?: Omit<PageCast, "closing">;
  castNote?: string;
};

export type SaveCheckpoint = {
  version: 1;
  pageId: string;
  plan: string;
  choices: SaveChoices;
};

export type SaveDraft = {
  version: 2;
  page: Page;
  tracking?: SaveOutcomeIdentity & { revision: number };
  beforeApply?: SaveCheckpoint;
  redoHeld?: SaveChoices;
};

export type SaveOutcomeCheck = "checking" | "applied" | "undone" | "unavailable";

export type SaveRerollIntent =
  | { kind: "saves"; holders: string[]; tag: string }
  | { kind: "ask"; holders: string[]; requestId: string }
  | { kind: "damage"; tag: string };

const id = z.string().min(1).max(64);
const holder = z.string().regex(/^(?:token|character):.{1,64}$/u);
const integer = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const counter = integer.min(0);
const iso = z.iso.datetime({ precision: 3 });
// Draft text can still be incomplete or invalid input. Preserve it within the
// storage budget instead of applying command validation to an unfinished form.
const text = z.string().max(SAVE_DRAFT_BYTES);
const way = z.enum(["fails", "ask", "server", "type"]);
const settle = z.enum(["sending", "committed", "refused", "unknown"]);
const phase = z.enum(["setup", "rolled"]);
const ability = z.enum(ABILITY_KEYS);
const holders = z.array(holder).max(LIMITS.outcomeTargets);
const withinDraftBytes = (value: unknown) => serializedBytes(value) <= SAVE_DRAFT_BYTES;
const byteLimit = { message: "a save draft exceeds its byte limit" };

const source = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("selection"), tokenIds: z.array(id).max(LIMITS.tokensPerScene), live: z.literal(true).optional(), except: id.optional() }),
  z.strictObject({ kind: z.literal("area"), templateId: id }),
  z.strictObject({ kind: z.literal("trap"), trapId: id, due: id, tokenIds: z.array(id).max(LIMITS.tokensPerScene) }),
]) satisfies z.ZodType<Page["source"]>;

const fill = z.strictObject({
  name: text,
  publicName: text.optional(),
  note: text.optional(),
  from: text,
  recharge: z.strictObject({ holder, key: combatUseSchemas.useKey }).optional(),
  damageType: z.enum(DAMAGE_TYPES).optional(),
  caster: id.optional(),
}).nullable() satisfies z.ZodType<Page["fill"]>;

const test = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("save"), ability }),
  z.strictObject({ kind: z.literal("check"), ability, skill: z.enum(SKILL_KEYS).optional() }),
  z.strictObject({ kind: z.literal("none") }),
]) satisfies z.ZodType<Page["test"]>;

const row = z.strictObject({
  holder,
  target: actorTargetSchema,
  tokenId: id,
  askRef: actorTargetSchema.optional(),
  name: text,
  ways: z.array(way).min(1).max(4),
  bonus: integer.nullable(),
  fails: z.enum(CONDITION_KEYS).optional(),
  why: text.optional(),
  skip: z.boolean(),
}) satisfies z.ZodType<Page["rows"][number]>;

const rolled = z.strictObject({
  ...diceSchemas.diceResult.shape,
  label: text.optional(),
  tokenId: id.optional(),
  characterId: id.optional(),
  seen: z.literal(true).optional(),
  seenBy: z.array(id).max(LIMITS.membersPerRoom).optional(),
  critOn: diceSchemas.critOn.optional(),
  initiative: z.literal(true).optional(),
  save: ability.optional(),
  hidden: z.literal(true).optional(),
  type: z.enum(DAMAGE_TYPES).optional(),
}) satisfies z.ZodType<NonNullable<RowState["rolled"]>>;

const answerFields = {
  choice: dmToolSchemas.rollChoiceIndex.optional(),
  total: dmToolSchemas.rollTotal.optional(),
  result: dmToolSchemas.rollResult.optional(),
  noRoll: z.literal(true).optional(),
  tag: id.optional(),
  dice: diceSchemas.diceResult.optional(),
  typedBonus: z.literal(true).optional(),
  mark: dmToolSchemas.rollResult.optional(),
  changed: rollAnswerSchemas.rollChange.optional(),
};
const answer = z.strictObject({
  tokenId: id.optional(),
  characterId: id.optional(),
  ...answerFields,
  by: id.optional(),
  previous: z.strictObject(answerFields).optional(),
  change: rollAnswerSchemas.rollChange.optional(),
  retype: z.literal(true).optional(),
}).refine((value) => (value.tokenId === undefined) !== (value.characterId === undefined), {
  message: "a roll answer names one token or one character",
}) satisfies z.ZodType<NonNullable<RowState["answer"]>>;

const choiceState = z.strictObject({
  way,
  mark: z.enum(["fail", "pass", "skip"]).optional(),
  typed: dmToolSchemas.rollTotal.optional(),
  rolled: rolled.optional(),
  answer: answer.optional(),
  asked: z.strictObject({ rollId: id, dc: dmToolSchemas.rollDc.optional() }).optional(),
  amount: z.union([integer, text]).optional(),
  typedBonus: integer.min(-20).max(30).optional(),
  legendary: z.boolean().optional(),
  evasion: z.boolean().optional(),
  qualifiedOn: z.array(z.string().min(1).max(2_000)).max(100).optional(),
  conditions: z.enum(["on", "off"]).optional(),
  gone: z.boolean().optional(),
}) satisfies z.ZodType<SaveChoices["states"][string]>;

const rowState = z.strictObject({
  ...choiceState.shape,
  batch: z.strictObject({ tag: id, part: counter.max(LIMITS.diceBatchesPerTag - 1) }).optional(),
  status: z.enum(["notRolled", "unknown", "notAsked"]).optional(),
  says: text.optional(),
}) satisfies z.ZodType<RowState>;

const outcome = z.strictObject({
  damage: text,
  onPass: z.enum(["half", "none"]),
  conditions: z.array(z.enum(CONDITION_KEYS)).max(LIMITS.outcomeEffectsEach),
  lasts: z.strictObject({
    mode: z.enum(["none", "turnStart", "turnEnd", "rounds"]),
    rounds: integer.min(1).max(1_000),
    anchor: id,
  }),
  saveEnds: z.strictObject({ ability, dc: dmToolSchemas.rollDc.nullable() }).nullable(),
  slot: integer.min(1).max(9).optional(),
}) satisfies z.ZodType<Page["outcome"]>;

const castAsk = z.strictObject({
  ...castSchemas.castInput.shape,
  rev: counter,
  by: id,
  rolled: z.array(castSchemas.castRolled).min(1).max(LIMITS.diceBatchesPerTag * LIMITS.diceRollsPerOp).optional(),
  at: iso,
}).refine((value) => (value.area === undefined) !== (value.targets === undefined), {
  message: "an ask names an area or its targets, one of the two",
}) satisfies z.ZodType<PageCast["ask"]>;

const choiceCast = z.strictObject({
  ask: castAsk,
  who: text,
  blocked: text.optional(),
  says: text.optional(),
}) satisfies z.ZodType<NonNullable<SaveChoices["cast"]>>;

const commonFields = {
  // A setup page can exist before a scene is available.
  sceneId: z.string().max(64),
  source,
  fill,
  test,
  dc: dmToolSchemas.rollDc.nullable(),
  secret: z.boolean(),
  spell: z.boolean(),
  switches: z.strictObject({ dcShown: z.boolean(), resultShown: z.boolean() }),
  rows: z.array(row).max(LIMITS.outcomeTargets),
  outcome,
  rolledAt: iso.optional(),
  castNote: text.optional(),
};

// Roll references can accumulate across explicit rerolls. The aggregate byte
// limit bounds that history without treating old references as pending work.
export const saveChoicesSchema = z.strictObject({
  ...commonFields,
  phase,
  states: z.record(holder, choiceState),
  rolls: z.array(z.strictObject({ tag: id, holders })).max(SAVE_DRAFT_BYTES),
  requests: z.array(z.strictObject({ rollId: id, holders })).max(SAVE_DRAFT_BYTES),
  dmRolls: z.array(z.strictObject({ tag: id, holder })).max(SAVE_DRAFT_BYTES),
  damage: z.strictObject({
    tag: id,
    amounts: z.array(integer.nullish().transform((amount) => amount ?? null)).max(MAX_DAMAGE_PARTS),
    imported: z.literal(true).optional(),
  }).nullable(),
  cast: choiceCast.optional(),
}).refine(withinDraftBytes, byteLimit) satisfies z.ZodType<SaveChoices>;

export const saveCheckpointSchema = z.strictObject({
  version: z.literal(1),
  pageId: id,
  plan: z.uuidv7(),
  choices: saveChoicesSchema,
}).refine(withinDraftBytes, byteLimit) satisfies z.ZodType<SaveCheckpoint>;

// Use the protocol's complete outcome validator so stored plans gain its new
// fields and guards when the shared contract is wired into production.
const outcomePlan = clientOpSchema.options.find((schema) => "shape" in schema && schema.shape.t.value === "actor.outcome")! as z.ZodType<NonNullable<Page["plan"]>>;
const page = z.strictObject({
  ...commonFields,
  id,
  phase: z.enum(["setup", "rolled", "applying", "applied"]),
  states: z.record(holder, rowState),
  rolls: z.array(z.strictObject({ tag: id, holders, state: settle, says: text.optional() })).max(SAVE_DRAFT_BYTES),
  requests: z.array(z.strictObject({ rollId: id, holders, state: z.enum(["sending", "open", "refused", "closed"]), says: text.optional() })).max(SAVE_DRAFT_BYTES),
  dmRolls: z.array(z.strictObject({ tag: id, holder, state: settle, says: text.optional() })).max(SAVE_DRAFT_BYTES),
  damage: z.strictObject({
    tag: id,
    state: settle,
    // JSON stores sparse slots as null. Page still uses undefined for a slot
    // without a result, while checkpoints use null explicitly.
    amounts: z.array(integer.nullish().transform((amount) => amount ?? undefined)).max(MAX_DAMAGE_PARTS).optional(),
    says: text.optional(),
    imported: z.literal(true).optional(),
  }).nullable(),
  plan: outcomePlan.nullable(),
  apply: z.enum(["idle", "sending", "unknown", "refused", "taken"]),
  applySays: text.optional(),
  rollNow: z.strictObject({ sources: z.array(z.strictObject({ kind: z.enum(["adv", "dis"]), from: text })).max(SAVE_DRAFT_BYTES) }).optional(),
  cast: z.strictObject({ ...choiceCast.shape, closing: phase.optional() }).optional(),
}) satisfies z.ZodType<Page>;

export const saveDraftSchema = z.strictObject({
  version: z.literal(2),
  page,
  tracking: z.strictObject({ id: z.uuidv7(), plan: z.uuidv7(), revision: counter }).optional(),
  beforeApply: saveCheckpointSchema.optional(),
  redoHeld: saveChoicesSchema.optional(),
}).refine(withinDraftBytes, byteLimit) satisfies z.ZodType<SaveDraft>;
