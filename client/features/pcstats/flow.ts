import type { Character, PcStats } from "#shared/model.ts";
import { expectHash, type ExpectSubject } from "#shared/permissions.ts";
import { stableStringify } from "#shared/project.ts";
import { MAX_PC_ROLLS, type CharacterPatch, type DdbSyncPatch } from "#shared/protocol.ts";
import { resourcesAfter, type ResourceSent } from "#shared/rules/classResources.ts";
import type { FillMerge, PcFill } from "#shared/rules/pcFill.ts";
import { mergeFill } from "#shared/rules/pcFill.ts";
import { planSync, sameRecord, type SyncPlan, type SyncResult } from "#shared/rules/pcSync.ts";
import { resourcePart, sameButLevels } from "#shared/rules/resourceSync.ts";
import { draftDirty, type PcDraft } from "./draft.ts";
import { alsoSet, pendingCharacter, type AlsoKey, type AlsoLine, type AlsoSet } from "./fill.ts";

/**
 * The stat block editor's steps and its Save as one state machine
 * (docs/design-v1-pc-stats.md 7.2), free of React so a randomized test can
 * run it through many orders of taps and answers (flow.test.ts). The
 * editor's own fields change the draft through `edit`, a fill's "Use it"
 * through `use`, and nothing else does. A Save sends one op and nothing
 * more until its answer, and nothing is sent once the editor closed.
 *
 * D&D Beyond's "Get it" is one request at a time: a newer Get it, Back or
 * closing aborts the one in flight, and an answer that is not the latest
 * request's changes nothing.
 *
 * A D&D Beyond read is reviewed as a re-sync is (docs/design-v1-resync.md
 * 1.1): its ticks are the review's line ids, and its "Use it" carries the
 * block, the fields beside it and the sync record the editor worked out
 * from the draft as it is then, so Save sends the record with the block.
 * A later read before Save is reviewed against what the earlier one took
 * (`editorSyncPlan`), and its record replaces the earlier one.
 *
 * The class resources live beside the block, so a D&D Beyond read's Use it
 * holds their part of the result apart (`HeldResources`), planned against
 * the live list and the saved record (docs/design-v1-ddb-resources.md
 * 6.2). Where the held part and the pending record meet, each part comes
 * from its own source: the rolls' markers and the rest of the record from
 * the pending one, the resources' entries and `r:` markers, and the source
 * they are compared as, from the saved one. Save expects the list whenever
 * it writes it or the record's resource part, and a refusal reviews the
 * resources again.
 *
 * `step` returns the next state and the effects the editor runs: send the
 * Save's op, fetch or abort a D&D Beyond request, or close.
 */

export type Step = "block" | "paste" | "ddb" | "review";

/**
 * A fill being looked over: what it read, what it does to the block, and
 * the other fields it sets, ticked or not. A D&D Beyond read has `ticks`,
 * the re-sync review's, in place of `merge` and `lines`, which stay empty.
 */
export type Review = {
  fill: PcFill;
  merge?: FillMerge;
  lines: AlsoLine[];
  from: "paste" | "ddb";
  ticks?: ReadonlySet<string>;
  /** A Save refused because the class resources changed elsewhere: the review shows them alone, and its Use it sets them alone (6.2 c). */
  only?: "resources";
};

/**
 * A D&D Beyond read's class resources as its Use it left them (6.2 a): the
 * read and its ticks, for a review again after a refusal, and the hash of
 * the live list it was planned from, which Save expects. `list` is the
 * list Save sends when it changes the live one, and `levels` one that
 * changes only presets' `level` and `atLevel`, which rides with any other
 * write Save makes and is never unsaved alone (4.4, OP-19, D-261024-41).
 * `part` marks a change to the record's resource part. Held only when one
 * of these holds (6.2 d), and until Save lands, a read's Use it replaces
 * it, or the editor closes.
 */
export type HeldResources = { fill: PcFill; ticks: ReadonlySet<string>; list?: ResourceSent[]; levels?: ResourceSent[]; part?: true; expect: string };

/**
 * What a D&D Beyond review's Use it sets: the merged block and level, the
 * fields beside it, and the record Save sends, null when it equals the
 * saved one. Either way it replaces the record an earlier Use it made, so
 * a record equal to the saved one drops that earlier record.
 */
export type SyncUse = { stats: PcStats; level: number | undefined; also: AlsoSet; record: DdbSyncPatch | null; resources: HeldResources | null };

/**
 * A D&D Beyond read in the editor, planned as a re-sync against the
 * character as Save would leave it: the draft, the fields earlier fills set
 * beside it and their record. With no block yet, nothing typed and no
 * earlier fill's record, a first sync, which takes everything read. A
 * pending record means the draft is a block even when edited back to how
 * it opened, so a roll deleted since that fill is offered back, not added.
 */
export function editorSyncPlan(
  fill: PcFill,
  state: Pick<FlowState, "draft" | "also" | "record">,
  opened: { draft: PcDraft; had: boolean },
  saved: Pick<Character, "name" | "actor" | "ddbSync" | "resources">,
): SyncPlan {
  const block = opened.had || state.record !== null || draftDirty(opened.draft, state.draft) ? state.draft.stats : undefined;
  // The class resources plan against the live list and the saved record's part, never a pending record, whose new ids the live list lacks (6.2 b).
  const character = { ...pendingCharacter(saved, state.also, state.record), ...(saved.resources ? { resources: saved.resources } : {}) };
  const resourceRecord = saved.ddbSync
    ? { ...(saved.ddbSync.res ? { res: saved.ddbSync.res } : {}), ...(saved.ddbSync.gone ? { gone: saved.ddbSync.gone } : {}), ...(saved.ddbSync.from !== undefined ? { from: saved.ddbSync.from } : {}) }
    : null;
  return planSync({ mode: "editor", stats: block, level: state.draft.level, character, fill, resourceRecord });
}

/**
 * The character a review's Also set help reads: the saved one's HP, which
 * Save works the new maximum from (fill.ts alsoPatch), under the name Save
 * leaves. The pending character's HP would already hold an earlier fill's
 * maximum, and could read as full when the saved HP is not.
 */
export function editorHelpCharacter(plan: SyncPlan, saved: Pick<Character, "actor">): Pick<Character, "name" | "actor"> {
  return { name: plan.input.character.name, actor: saved.actor };
}

/**
 * A review's Use it, with its record compared with the saved one, and its
 * class resources held when they change the live list or the record's
 * resource part (`SyncUse`, 6.2). The result's record is already the
 * pending one with its resource part planned against the saved record's,
 * spliced and cut to 40 markers (pcSync.ts syncResult). After a refusal
 * (`only`), the draft and its rolls stay, so the record Save sends is the
 * pending one with only this review's resource part in it (6.2 c).
 */
export function editorSyncUse(result: SyncResult, saved: ExpectSubject | undefined, read: { fill: PcFill; ticks: ReadonlySet<string> }, only?: { pending: DdbSyncPatch | null }): SyncUse {
  // With nothing pending, the record Save keeps is the saved one, so that is the one the review's part goes into.
  const base = only ? (only.pending ?? withoutAt(saved?.ddbSync)) : null;
  const made = base ? spliceResources(base, result).record : result.record;
  const record = saved && sameRecord(made, saved.ddbSync) ? null : made;
  return { stats: result.stats, level: result.level, also: result.also, record, resources: heldResources(result, made, saved, read) };
}

function heldResources(result: SyncResult, record: DdbSyncPatch, saved: ExpectSubject | undefined, read: { fill: PcFill; ticks: ReadonlySet<string> }): HeldResources | null {
  if (!saved) return null;
  const after = result.resources !== undefined ? resourcesAfter(saved.resources, result.resources) : undefined;
  // A preset's level alone is not a change, so a spend meanwhile never refuses a Save over it alone (OP-19).
  const list = after !== undefined && !sameButLevels(after, saved.resources);
  const levels = after !== undefined && !list && stableStringify(after) !== stableStringify(saved.resources ?? []);
  // The record's resource part can change with no list read, as when a removed resource's entry becomes its marker (DDBBUILD-ASTRA-04).
  const part = resourcePart(record) !== resourcePart(saved.ddbSync);
  if (!list && !levels && !part) return null;
  const sent = result.resources!;
  return { fill: read.fill, ticks: read.ticks, ...(list ? { list: sent } : levels ? { levels: sent } : {}), ...(part ? { part: true as const } : {}), expect: expectHash(saved, "resources") };
}

function withoutAt(record: DdbSyncPatch | undefined): DdbSyncPatch | null {
  if (!record) return null;
  const { at: _at, ...rest } = record;
  return rest;
}

/**
 * The pending record with a resources-only review's part in place of its
 * own (6.2 c): its entries and `r:` markers from the review, every other
 * marker from the pending record, whose draft the review leaves as it is.
 * Oldest first in the review's order, before its cap, with a pending marker
 * the review dropped kept after the one before it, then 40 of either kind
 * together, cut once here (DDBBUILD-ASTRA-07).
 */
function spliceResources(pending: DdbSyncPatch, from: SyncResult): { record: DdbSyncPatch; dropped: SyncResult["goneDropped"] } {
  const { res: _res, gone: _gone, ...rest } = pending;
  const rolls = (pending.gone ?? []).filter((k) => !k.startsWith("r:"));
  const keep = new Set(rolls);
  const merged = from.markers.filter((k) => k.startsWith("r:") || keep.has(k));
  for (const [i, k] of rolls.entries()) {
    if (merged.includes(k)) continue;
    const before = rolls.slice(0, i).findLast((b) => merged.includes(b));
    merged.splice(before === undefined ? 0 : merged.indexOf(before) + 1, 0, k);
  }
  const cut = Math.max(0, merged.length - MAX_PC_ROLLS);
  const gone = merged.slice(cut);
  const dropped = merged.slice(0, cut).map((k) => {
    const name = from.markerNames[k];
    return name !== undefined ? { k, name } : { k };
  });
  return { record: { ...rest, ...(from.record.res ? { res: from.record.res } : {}), ...(gone.length > 0 ? { gone } : {}) }, dropped };
}

/**
 * The markers a resources-only review's splice cuts at 40 (OP-21), for the
 * review to name: the review's own cap counts the saved record's markers,
 * while Use it cuts the pending record's, so the two can differ. With no
 * record to splice into, Use it keeps the review's own record, so its own
 * cut is the one named.
 */
export function onlyGoneDropped(result: SyncResult, saved: ExpectSubject | undefined, pending: DdbSyncPatch | null): SyncResult["goneDropped"] {
  const base = pending ?? withoutAt(saved?.ddbSync);
  return base ? spliceResources(base, result).dropped : result.goneDropped;
}

/** Whether held class resources leave the editor unsaved: a list or a record part that changes, never levels alone (6.2 e). */
export function resourcesUnsaved(held: HeldResources | null): boolean {
  return held !== null && (held.list !== undefined || held.part === true);
}

/**
 * What Save adds for held class resources (6.2 d): the list when it
 * changes the live one, a levels-only list when the rest of the patch
 * writes anything (4.4, as syncPatch lets it ride), and `expect` whenever
 * it writes the list or the record's resource part.
 */
export function resourcesSave(held: HeldResources | null, rest: CharacterPatch): { resources?: ResourceSent[]; expect?: { resources: string } } {
  if (!held) return {};
  const resources = held.list ?? (held.levels && Object.keys(rest).length > 0 ? held.levels : undefined);
  const writesPart = held.part === true && rest.ddbSync !== undefined;
  if (resources === undefined && !writesPart) return {};
  return { ...(resources ? { resources } : {}), expect: { resources: held.expect } };
}

export type FlowState = {
  step: Step;
  draft: PcDraft;
  /** The fields beside the block the last "Use it" set, sent with the next Save. */
  also: AlsoSet;
  /** The sync record a D&D Beyond "Use it" made, sent with the next Save (docs/design-v1-resync.md 1.1). */
  record: DdbSyncPatch | null;
  /** The class resources a D&D Beyond "Use it" set, sent with the next Save (docs/design-v1-ddb-resources.md 6.2). */
  resources: HeldResources | null;
  review: Review | null;
  /** A Save's op waits for its answer. */
  saving: boolean;
  closed: boolean;
  /** The D&D Beyond request in flight, by its number. */
  get: number | null;
  nextGet: number;
  /** Why the last Get it read nothing, in the step's words. */
  error: string | null;
};

export type FlowEvent =
  | { t: "edit"; update(draft: PcDraft): PcDraft }
  | { t: "open"; step: "paste" | "ddb" }
  | { t: "back" }
  /** A fill read, with its review's lines worked out against the character as it is now, and a D&D Beyond read's ticks. */
  | { t: "read"; fill: PcFill; lines: AlsoLine[]; ticks?: ReadonlySet<string> }
  | { t: "toggle"; key: AlsoKey }
  /** A D&D Beyond review's tick, or a bulk button's ticks. */
  | { t: "tick"; id: string }
  | { t: "ticks"; ticks: ReadonlySet<string> }
  /** Use it. A D&D Beyond review's carries what it sets. */
  | { t: "use"; sync?: SyncUse }
  | { t: "save" }
  /** A Save's answer. `stale` when the server refused it because the class resources changed elsewhere. */
  | { t: "saved"; answer: "taken" | "refused" | "unknown"; stale?: boolean }
  | { t: "close" }
  | { t: "get" }
  /** A D&D Beyond request's answer: its fill and lines, or why it read nothing. */
  | { t: "got"; id: number; result: { fill: PcFill; lines: AlsoLine[]; ticks?: ReadonlySet<string> } | { error: string } };

export type FlowEffect = { kind: "send" } | { kind: "close" } | { kind: "fetch"; id: number } | { kind: "abort"; id: number };

export function openFlow(draft: PcDraft): FlowState {
  return { step: "block", draft, also: {}, record: null, resources: null, review: null, saving: false, closed: false, get: null, nextGet: 1, error: null };
}

/** The request in flight, aborted, for a step that leaves it behind. */
function dropGet(state: FlowState): { state: FlowState; effects: FlowEffect[] } {
  return state.get === null ? { state, effects: NONE } : { state: { ...state, get: null }, effects: [{ kind: "abort", id: state.get }] };
}

const NONE: FlowEffect[] = [];

export function stepFlow(state: FlowState, event: FlowEvent): { state: FlowState; effects: FlowEffect[] } {
  if (state.closed) return { state, effects: NONE };
  switch (event.t) {
    case "edit":
      // While a Save waits, the draft it sent is the draft: the fields hold still until its answer.
      if (state.saving) return { state, effects: NONE };
      return { state: { ...state, draft: event.update(state.draft) }, effects: NONE };
    case "open":
      return { state: { ...state, step: event.step, error: null }, effects: NONE };
    case "back": {
      if (state.step === "review") return { state: { ...state, step: state.review?.from ?? "block", review: null }, effects: NONE };
      const dropped = dropGet(state);
      return { state: { ...dropped.state, step: "block", error: null }, effects: dropped.effects };
    }
    case "get": {
      if (state.step !== "ddb") return { state, effects: NONE };
      const dropped = dropGet(state);
      const id = state.nextGet;
      return { state: { ...dropped.state, get: id, nextGet: id + 1, error: null }, effects: [...dropped.effects, { kind: "fetch", id }] };
    }
    case "got": {
      // A stale or aborted request's answer changes nothing.
      if (state.get !== event.id || state.step !== "ddb") return { state, effects: NONE };
      const result = event.result;
      if ("error" in result) return { state: { ...state, get: null, error: result.error }, effects: NONE };
      const reviewed = result.ticks ? { ticks: result.ticks } : { merge: mergeFill(state.draft.stats, result.fill) };
      return { state: { ...state, get: null, step: "review", review: { fill: result.fill, lines: result.lines, from: "ddb", ...reviewed } }, effects: NONE };
    }
    case "read": {
      if (state.step !== "paste" && state.step !== "ddb") return { state, effects: NONE };
      // Pasted JSON read while a Get it waits: the paste wins, and the request goes.
      const dropped = dropGet(state);
      const reviewed = event.ticks ? { ticks: event.ticks } : { merge: mergeFill(state.draft.stats, event.fill) };
      return { state: { ...dropped.state, step: "review", review: { fill: event.fill, lines: event.lines, from: state.step, ...reviewed } }, effects: dropped.effects };
    }
    case "toggle": {
      const review = state.review;
      if (!review || state.step !== "review") return { state, effects: NONE };
      const lines = review.lines.map((l) => (l.key === event.key ? { ...l, on: !l.on } : l));
      return { state: { ...state, review: { ...review, lines } }, effects: NONE };
    }
    case "tick": {
      const review = state.review;
      if (!review?.ticks || state.step !== "review") return { state, effects: NONE };
      const ticks = new Set(review.ticks);
      if (ticks.has(event.id)) ticks.delete(event.id);
      else ticks.add(event.id);
      return { state: { ...state, review: { ...review, ticks } }, effects: NONE };
    }
    case "ticks": {
      const review = state.review;
      if (!review?.ticks || state.step !== "review") return { state, effects: NONE };
      return { state: { ...state, review: { ...review, ticks: event.ticks } }, effects: NONE };
    }
    case "use": {
      const review = state.review;
      if (!review || state.step !== "review" || state.saving) return { state, effects: NONE };
      if (review.ticks) {
        // A D&D Beyond review: the editor merged it from the draft as it is now, so it never undoes an edit made since it was read.
        const sync = event.sync;
        if (!sync) return { state, effects: NONE };
        // After a refusal the review was of the class resources alone: the draft, its rolls and Also set stay (6.2 c).
        if (review.only === "resources") return { state: { ...state, step: "block", review: null, record: sync.record, resources: sync.resources }, effects: NONE };
        const draft: PcDraft = { stats: sync.stats, level: sync.level };
        return { state: { ...state, step: "block", review: null, draft, also: { ...state.also, ...sync.also }, record: sync.record, resources: sync.resources }, effects: NONE };
      }
      const also = { ...state.also, ...alsoSet(review.fill, review.lines) };
      // The block is merged again from the draft as it is now, so the review never undoes an edit made since it was read.
      const merged = mergeFill(state.draft.stats, review.fill).stats;
      const draft: PcDraft = { stats: merged, level: also.level ?? state.draft.level };
      return { state: { ...state, step: "block", review: null, draft, also }, effects: NONE };
    }
    case "save":
      if (state.saving || state.step !== "block") return { state, effects: NONE };
      return { state: { ...state, saving: true }, effects: [{ kind: "send" }] };
    case "saved":
      if (!state.saving) return { state, effects: NONE };
      if (event.answer === "taken") return { state: { ...state, saving: false, closed: true }, effects: [{ kind: "close" }] };
      // Nothing was saved because the class resources changed elsewhere: they are reviewed again, from the read Use it held, with no new fetch (6.2 c).
      if (event.stale && state.resources) {
        const held = state.resources;
        return { state: { ...state, saving: false, step: "review", review: { fill: held.fill, lines: [], from: "ddb", ticks: held.ticks, only: "resources" } }, effects: NONE };
      }
      // A refusal, or a lost answer, leaves the draft as it was, for the player to act on.
      return { state: { ...state, saving: false }, effects: NONE };
    case "close": {
      const dropped = dropGet(state);
      return { state: { ...dropped.state, closed: true }, effects: [...dropped.effects, { kind: "close" }] };
    }
  }
}
