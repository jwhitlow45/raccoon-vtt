import { saveOutcomeRecordSchema, type SaveOutcomeFields, type SaveOutcomeLedger, type SaveOutcomeState } from "#shared/saveOutcomeContract.ts";
import type { OpOf } from "#shared/protocol.ts";
import { apply, type Page, type Step } from "./chain.ts";
import { saveChoicesSchema, saveCheckpointSchema, type SaveChoices, type SaveDraft, type SaveOutcomeCheck } from "./reopenContract.ts";

export const OUTCOME_UNDONE = "Outcome undone. Change the DC, roll again, or apply again.";
export const OUTCOME_RESTORED = "Outcome restored. Undo it before changing this save.";
export const OUTCOME_UNAVAILABLE = "This save's outcome cannot be checked. Start a new group save to continue.";
export const SAVE_MEMORY_ONLY = "This save can reopen here until this tab closes.";

export type SaveReceipt = { plan: string; state: "sending" | "checking" | "unknown" | "committed" | "refused"; seq?: number; says?: string };
export type SaveReopen = Omit<SaveDraft, "version" | "page"> & {
  check: SaveOutcomeCheck | null;
  observed?: { revision: number; state: SaveOutcomeState };
  receipt?: SaveReceipt;
  notice?: string;
  memoryOnly?: boolean;
};
export type SaveSession = { page: Page; reopen: SaveReopen | null };
export type SaveAuthority = { ready: boolean; seq: number; memberId: string; ledger: SaveOutcomeLedger; sceneAvailable: boolean };

function copiedChoices(page: Page): SaveChoices {
  const { id: _id, plan: _plan, apply: _apply, applySays: _says, rollNow: _now, ...fields } = page;
  const source = page.source.kind === "trap" ? page.source : { kind: "selection" as const, tokenIds: page.rows.map(r => r.tokenId) };
  const cast = page.cast ? (({ closing: _closing, ...kept }) => kept)(page.cast) : undefined;
  return structuredClone({
    ...fields, source, phase: page.test.kind === "none" && page.phase === "setup" ? "setup" : "rolled",
    states: Object.fromEntries(Object.entries(page.states).map(([key, { batch: _batch, status: _status, says: _why, ...state }]) => [key, state])),
    rolls: page.rolls.filter(r => r.state === "committed").map(({ tag, holders }) => ({ tag, holders })),
    requests: page.requests.filter(r => r.state === "open" || r.state === "closed").map(({ rollId, holders }) => ({ rollId, holders })),
    dmRolls: page.dmRolls.filter(r => r.state === "committed").map(({ tag, holder }) => ({ tag, holder })),
    damage: page.damage?.state === "committed" ? { tag: page.damage.tag, amounts: page.damage.amounts?.map(n => n ?? null) ?? [], ...(page.damage.imported ? { imported: true as const } : {}) } : null,
    ...(cast ? { cast } : {}),
  });
}

/** An Apply checkpoint must fit the persisted contract before any command. */
export function captureChoices(page: Page): SaveChoices {
  return saveChoicesSchema.parse(copiedChoices(page));
}

function restoredChoices(pageId: string, copied: SaveChoices): Page {
  return {
    ...copied, id: pageId, plan: null, apply: "idle",
    rolls: copied.rolls.map(r => ({ ...r, state: "committed" })),
    requests: copied.requests.map(r => ({ ...r, state: "closed" })),
    dmRolls: copied.dmRolls.map(r => ({ ...r, state: "committed" })),
    damage: copied.damage ? { ...copied.damage, state: "committed", amounts: copied.damage.amounts.map(n => n ?? undefined) } : null,
  };
}

export function restoreChoices(pageId: string, choices: SaveChoices): Page {
  return restoredChoices(pageId, saveChoicesSchema.parse(choices));
}

export function draftOf({ page, reopen }: SaveSession): SaveDraft {
  return { version: 2, page, ...(reopen?.tracking ? { tracking: reopen.tracking } : {}), ...(reopen?.beforeApply ? { beforeApply: reopen.beforeApply } : {}), ...(reopen?.redoHeld ? { redoHeld: reopen.redoHeld } : {}) };
}

export function sessionOfDraft(draft: SaveDraft): SaveSession {
  const { version: _version, page, ...metadata } = draft;
  return { page, reopen: { ...metadata, check: metadata.tracking || page.apply === "taken" || page.phase === "applying" ? "checking" : null } };
}

function locked(input: SaveSession, check: "checking" | "unavailable"): SaveSession {
  const reopen = input.reopen;
  const notice = check === "unavailable" ? OUTCOME_UNAVAILABLE : undefined;
  if (reopen?.check === check && reopen.notice === notice) return { page: input.page, reopen };
  return { page: input.page, reopen: { ...reopen, check, notice } };
}

/** Only confirmed lifecycle metadata can authorize edits. Reconciliation emits no commands. */
export function reconcileSave(input: SaveSession, authority: SaveAuthority): SaveSession {
  const { page, reopen } = input;
  const tracking = reopen?.tracking;
  if (!tracking) {
    // Close the ask is final and has no applied outcome to reopen.
    if (page.cast?.closing) return { page, reopen: reopen?.check ? { ...reopen, check: null, notice: undefined } : reopen };
    if (page.phase === "applied" || page.apply === "taken" || page.phase === "applying") return locked(input, authority.ready ? "unavailable" : "checking");
    return { page, reopen };
  }
  if (!authority.ready) return locked(input, "checking");
  const attempt = page.phase === "applying" ? page.plan?.plan : undefined;
  const receipt = reopen.receipt?.plan === (attempt ?? tracking.plan) ? reopen.receipt : undefined;
  if (receipt?.seq !== undefined && authority.seq < receipt.seq) return locked(input, "checking");
  const raw = authority.ledger[tracking.id];
  const parsed = saveOutcomeRecordSchema.safeParse(raw);
  const current = parsed.success ? parsed.data : undefined;
  if (raw !== undefined && !current) return locked(input, "unavailable");
  if (current && (current.seq > authority.seq || current.revision < tracking.revision)) return locked(input, "checking");
  if (current && current.memberId !== authority.memberId) return locked(input, "unavailable");

  // A refused replacement leaves the older undone outcome intact. While B is
  // pending, redoHeld temporarily retains A's checkpoint, not a command queue.
  if (attempt && receipt?.state === "refused" && (!current && tracking.revision === 0 || tracking.revision > 0 && current?.plan === tracking.plan && current.revision >= tracking.revision)) {
    const checkpoint = reopen.beforeApply;
    if (!checkpoint || checkpoint.plan !== attempt || checkpoint.pageId !== page.id) return locked(input, "unavailable");
    const restored = restoreChoices(page.id, checkpoint.choices);
    if (tracking.revision === 0) return { page: { ...restored, apply: "refused", applySays: receipt.says }, reopen: { check: null, memoryOnly: reopen.memoryOnly } };
    const previous = reopen.redoHeld;
    if (!previous) return locked(input, "unavailable");
    return reconcileSave({
      page: { ...restored, apply: "refused", applySays: receipt.says },
      reopen: { tracking, check: "undone", observed: { revision: tracking.revision, state: "undone" }, beforeApply: { version: 1, pageId: page.id, plan: tracking.plan, choices: previous }, ...(current && current.revision > tracking.revision ? { redoHeld: checkpoint.choices } : {}), memoryOnly: reopen.memoryOnly },
    }, authority);
  }
  if (!current) {
    if (tracking.revision === 0 && attempt && (!receipt || receipt.state === "sending" || receipt.state === "checking")) return locked(input, "checking");
    return locked(input, "unavailable");
  }
  if (attempt && current.plan === tracking.plan && attempt !== tracking.plan && current.revision === tracking.revision && current.state === "undone") return locked(input, "checking");
  if (current.plan !== (attempt ?? tracking.plan)) return locked(input, "unavailable");
  if (reopen.observed?.revision === current.revision && reopen.observed.state !== current.state) return locked(input, "unavailable");
  const checkpoint = reopen.beforeApply;
  if (!checkpoint || checkpoint.pageId !== page.id || checkpoint.plan !== current.plan || !saveCheckpointSchema.safeParse(checkpoint).success) return locked(input, "unavailable");
  const nextTracking = { id: tracking.id, plan: current.plan, revision: current.revision };
  const newer = current.revision > tracking.revision;
  const replaceAttempt = attempt !== undefined && attempt !== tracking.plan;
  const metadata: SaveReopen = { ...reopen, tracking: nextTracking, check: current.state, observed: { revision: current.revision, state: current.state }, ...(replaceAttempt ? { redoHeld: undefined } : {}) };
  if (current.state === "undone") {
    if (newer || page.phase === "applying" || page.phase === "applied" || page.apply === "taken") return { page: restoreChoices(page.id, checkpoint.choices), reopen: { ...metadata, notice: OUTCOME_UNDONE } };
    if (reopen.check === "undone" && !newer && reopen.notice !== OUTCOME_UNAVAILABLE) return { page, reopen };
    return { page, reopen: { ...metadata, notice: OUTCOME_UNDONE } };
  }
  const wasEditable = page.phase === "setup" || page.phase === "rolled";
  let held = metadata.redoHeld;
  if (wasEditable) {
    // New edits can exceed the storage budget. Keep them in memory while the
    // draft writer reports that they cannot survive this tab closing.
    held = copiedChoices(page);
  }
  if (!newer && reopen.check === "applied" && page.phase === "applied") return { page, reopen };
  return { page: { ...page, phase: "applied", apply: "taken" }, reopen: { ...metadata, redoHeld: held, notice: wasEditable || current.revision > 1 && !attempt ? OUTCOME_RESTORED : undefined } };
}

export function saveEditable(input: SaveSession, authority: SaveAuthority): boolean {
  if (!authority.ready || !authority.sceneAvailable) return false;
  const checked = reconcileSave(input, authority);
  if (checked.page.phase !== "setup" && checked.page.phase !== "rolled" || checked.page.apply === "unknown" || checked.page.apply === "sending" || checked.page.apply === "taken") return false;
  return checked.reopen?.tracking ? checked.reopen.check === "undone" : checked.reopen?.check !== "unavailable" && checked.reopen?.check !== "checking";
}

export function prepareSave(input: SaveSession, plan: OpOf<"actor.outcome"> & SaveOutcomeFields, authority: SaveAuthority): SaveSession & Pick<Step, "send" | "error"> {
  const current = reconcileSave(input, authority);
  if (!saveEditable(current, authority)) return { ...current, send: [], error: current.reopen?.check === "unavailable" ? OUTCOME_UNAVAILABLE : "Wait for this save's confirmed state." };
  if (current.page.requests.some(request => request.state === "sending") || current.page.rolls.some(roll => roll.state === "sending") || current.page.damage?.state === "sending") return { ...current, send: [], error: "Wait for the current rolls and requests to finish." };
  let choices: SaveChoices;
  try { choices = captureChoices(current.page); } catch { return { ...current, send: [], error: "This save's choices could not be kept. Check the save before applying." }; }
  const beforeApply = saveCheckpointSchema.safeParse({ version: 1, pageId: current.page.id, plan: plan.plan, choices });
  if (!beforeApply.success) return { ...current, send: [], error: "This save's choices could not be kept. Check the save before applying." };
  const tracking = current.reopen?.tracking ?? { id: plan.plan, plan: plan.plan, revision: 0 };
  const op = { ...plan, page: { id: tracking.id, expectRevision: tracking.revision } };
  const step = apply(current.page, op);
  if (!step.send.length) return { ...current, send: [], ...(step.error ? { error: step.error } : {}) };
  return {
    page: step.page, send: step.send,
    reopen: { tracking, beforeApply: beforeApply.data, ...(current.reopen?.beforeApply && tracking.revision > 0 ? { redoHeld: current.reopen.beforeApply.choices } : {}), check: "checking", receipt: { plan: plan.plan, state: "sending" }, memoryOnly: current.reopen?.memoryOnly },
  };
}

export function resumeSaveEdits(input: SaveSession, authority: SaveAuthority): SaveSession {
  const current = reconcileSave(input, authority);
  if (!saveEditable(current, authority) || !current.reopen?.redoHeld) return current;
  return { page: restoredChoices(current.page.id, structuredClone(current.reopen.redoHeld)), reopen: { ...current.reopen, redoHeld: undefined, notice: OUTCOME_UNDONE } };
}
