import type { StatBlock } from "#shared/model.ts";
import { stableStringify } from "#shared/project.ts";
import type { MonsterPatch } from "#shared/protocol.ts";
import type { OpAnswer, OpRefusal, UnknownCause } from "../../state/types.ts";
import { blockSaveOutcome, monsterPatch } from "./draft.ts";

/**
 * The save of one open companion stat block editor
 * (docs/design-v1-companion-stat-blocks.md 6.2), kept free of React so a
 * test can run it through many orders of answers, lost answers, snapshots
 * and edits from elsewhere (blockSave.test.ts).
 *
 * The editor saves one block, chosen as it opens, and diffs against the
 * block as it opened, then against each version it saved. It closes only
 * when the draft it holds is known to be stored: an answer for an older
 * draft advances the base and leaves the editor open with the rest to save.
 *
 * A create is never sent while an earlier one may still land. A lost
 * answer comes with how it was lost (state/types.ts UnknownCause): after a
 * reconnect's snapshot the view already shows what the op did, so it is
 * judged at once, but an op dropped as too old before any new snapshot
 * leaves the editor waiting, Save off, until the next snapshot says.
 */

type Sent = { kind: "create" | "update"; draft: StatBlock };

export type BlockSave = {
  /** What an update is diffed against: the block as the editor opened it, then each version this editor saved. Null until a new block's create lands. */
  base: StatBlock | null;
  /** The op awaiting its answer, with the draft it carried. */
  pending: Sent | null;
  /** An op whose answer was lost before the view could say what it did. Nothing more is sent until a snapshot after `after` does. */
  unsure: (Sent & { after: number }) | null;
  /** The last create sent: what the block holds if the view shows it later, whatever became of its answer. */
  created: StatBlock | null;
  /**
   * Lines a lost update set that the view does not show as set. Someone
   * may have changed them since it landed, so the base cannot say what the
   * server holds, and the next update sends them whatever the base says.
   */
  doubt: readonly (keyof StatBlock)[];
};

/** What the view holds of the block now. `snapshots` counts the snapshots this device has taken (store.ts). */
export type BlockLive = { stored: StatBlock | undefined; snapshots: number };

export type SaveIntent =
  | { kind: "busy" }
  | { kind: "saved" }
  | { kind: "create"; draft: StatBlock }
  | { kind: "update"; draft: StatBlock; patch: MonsterPatch };

export type SaveResult =
  /** The draft the editor holds is stored: it closes. */
  | { kind: "saved" }
  /** An older draft is stored and the base follows it. The editor stays open with the rest to save. */
  | { kind: "kept" }
  /** Not saved, in words for the editor's problem list. `retryInMs` keeps Save off that long. */
  | { kind: "problem"; text: string; retryInMs?: number }
  /** Waiting for a snapshot to say whether a lost op landed. */
  | { kind: "checking" };

export function openSave(existing: StatBlock | null): BlockSave {
  return { base: existing, pending: null, unsure: null, created: null, doubt: [] };
}

/** True while the editor waits on an answer or a snapshot, when its fields and Save are held. */
export function saveHeld(save: BlockSave): boolean {
  return save.pending !== null || save.unsure !== null;
}

/**
 * What Save does with this draft. A new block's create that the view shows
 * has landed, whatever became of its answer, so the base takes it and the
 * draft is diffed against it.
 */
export function planSave(save: BlockSave, draft: StatBlock, live: BlockLive): { save: BlockSave; intent: SaveIntent } {
  if (saveHeld(save)) return { save, intent: { kind: "busy" } };
  // Only the last create can have landed: each earlier one was refused or shown not to land before another was sent.
  const base = save.base ?? (live.stored ? (save.created ?? live.stored) : null);
  const next = base === save.base ? save : { ...save, base };
  if (base === null) return { save: next, intent: { kind: "create", draft } };
  const patch: Record<string, unknown> = { ...monsterPatch(base, draft) };
  for (const key of save.doubt) patch[key] = draft[key] ?? null;
  if (Object.keys(patch).length === 0) return { save: next, intent: { kind: "saved" } };
  return { save: next, intent: { kind: "update", draft, patch: patch as MonsterPatch } };
}

/** The intent's op went out: its answer is awaited. */
export function markSent(save: BlockSave, intent: Extract<SaveIntent, { kind: "create" | "update" }>): BlockSave {
  return { ...save, pending: { kind: intent.kind, draft: intent.draft }, ...(intent.kind === "create" ? { created: intent.draft } : {}) };
}

/** The pending op's answer, judged against the draft the editor holds now. */
export function answerSave(
  save: BlockSave,
  answer: { answer: OpAnswer; refusal?: Pick<OpRefusal, "message">; cause?: UnknownCause },
  draft: StatBlock,
  live: BlockLive,
  characterName: string,
): { save: BlockSave; result: SaveResult } {
  const sent = save.pending;
  if (!sent) return { save, result: { kind: "kept" } };
  const idle = { ...save, pending: null };
  if (answer.answer === "taken") return stored(idle, sent, draft);
  if (answer.answer === "refused") {
    const outcome = blockSaveOutcome("refused", answer.refusal, characterName);
    return { save: idle, result: outcome.kind === "saved" ? { kind: "kept" } : outcome };
  }
  // Too old to send and dropped before any new snapshot: the view may still lack an op that committed.
  if (answer.cause === "expired") return { save: { ...idle, unsure: { ...sent, after: live.snapshots } }, result: { kind: "checking" } };
  return judge(idle, sent, draft, live);
}

/** A snapshot arrived: an op whose answer was lost is judged by what the view now shows. */
export function settleSave(save: BlockSave, draft: StatBlock, live: BlockLive): { save: BlockSave; result: SaveResult | null } {
  const unsure = save.unsure;
  if (!unsure || live.snapshots <= unsure.after) return { save, result: null };
  return judge({ ...save, unsure: null }, { kind: unsure.kind, draft: unsure.draft }, draft, live);
}

/**
 * Whether Save can no longer reach the block: a block that exists (opened,
 * or made by this editor) gone from the view, deleted or no longer the
 * viewer's, or for a new one, a character that is not there or not the
 * viewer's. Never while an answer is awaited, which says so itself.
 */
export function saveGone(save: BlockSave, live: BlockLive, characterYours: boolean): boolean {
  if (saveHeld(save)) return false;
  return save.base !== null ? live.stored === undefined : live.stored === undefined && !characterYours;
}

function stored(save: BlockSave, sent: Sent, draft: StatBlock): { save: BlockSave; result: SaveResult } {
  const next = { ...save, base: sent.draft, doubt: [] };
  return { save: next, result: same(sent.draft, draft) ? { kind: "saved" } : { kind: "kept" } };
}

/**
 * A lost answer, read from the view: a create landed if the block is
 * there, an update if every line it set reads as it set it. An update
 * that does not read so may still have landed with a line changed since,
 * so its lines are sent again with the next Save.
 */
function judge(save: BlockSave, sent: Sent, draft: StatBlock, live: BlockLive): { save: BlockSave; result: SaveResult } {
  const lines = sent.kind === "update" && save.base ? setLines(save, sent.draft) : [];
  if (landed(sent, lines, live)) return stored(save, sent, draft);
  if (sent.kind === "create") return { save, result: { kind: "problem", text: "The connection dropped before this stat block was saved. Save it again." } };
  return { save: { ...save, doubt: lines }, result: { kind: "problem", text: "The connection dropped before these changes were saved. Save them again." } };
}

/** The lines an update of this draft sets: those that differ from the base, and those in doubt. */
function setLines(save: BlockSave, draft: StatBlock): (keyof StatBlock)[] {
  const lines = new Set([...(Object.keys(monsterPatch(save.base!, draft)) as (keyof StatBlock)[]), ...save.doubt]);
  return [...lines];
}

function landed(sent: Sent, lines: readonly (keyof StatBlock)[], live: BlockLive): boolean {
  const now = live.stored;
  if (!now) return false;
  if (sent.kind === "create") return true;
  return lines.every((key) => stableStringify(now[key]) === stableStringify(sent.draft[key]));
}

function same(a: StatBlock, b: StatBlock): boolean {
  return stableStringify(a) === stableStringify(b);
}
