import type { StoreApi } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import type { SaveOutcomeLedger } from "#shared/saveOutcomeContract.ts";
import type { RoomView } from "../../../state/types.ts";
import type { RoomViewStore } from "../../../state/view.ts";
import type { ReceiptTracker } from "../useReceipt.ts";
import { creatureKey } from "../options.ts";
import { askAnswered, markGone, syncRequests, type Page } from "./chain.ts";
import { writeSaveDraft } from "./draftStorage.ts";
import { SAVE_ANNOUNCED, type SaveDraft } from "./reopenContract.ts";
import { draftOf, reconcileSave, SAVE_MEMORY_ONLY, type SaveAuthority, type SaveReceipt, type SaveReopen, type SaveSession } from "./reopen.ts";
import type { GroupSaveState } from "./store.ts";

export type SaveLifecycleOptions = {
  store: StoreApi<GroupSaveState>;
  room: RoomViewStore;
  receipts: ReceiptTracker;
  notify?(text: string): void;
  persist?(roomId: string, draft: SaveDraft | null): boolean;
};

/** The server's time as this device reckons it: its own clock moved by the offset it learned, or its own clock until it has one. */
export function serverTime(room: Pick<RoomView, "serverOffset">, now: number = Date.now()): number {
  return now + (room.serverOffset ?? 0);
}

export function authorityOf(room: RoomView, page: Page): SaveAuthority {
  const confirmed = room.confirmed as (NonNullable<RoomView["confirmed"]> & { saveOutcomes?: SaveOutcomeLedger }) | null | undefined;
  const seq = room.seq;
  return {
    ready: room.confirmedReady === true && confirmed !== null && confirmed !== undefined && room.connection === "open" && !room.ended && room.you?.role === "dm" && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0,
    seq: seq ?? 0,
    memberId: room.you?.memberId ?? "",
    ledger: confirmed?.saveOutcomes ?? {},
    sceneAvailable: room.sceneId === page.sceneId && !!confirmed?.scenes[page.sceneId] && !room.sceneLoad?.requested,
    now: serverTime(room),
    pendingPlans: new Set(room.pending?.flatMap(pending => pending.op.t === "actor.outcome" ? [pending.op.plan] : []) ?? []),
  };
}

type Binding = { count: number; stop(): void };
const bindings = new WeakMap<StoreApi<GroupSaveState>, Binding>();
// Keep announcement identities through React's effect remounts for this room.
const announcements = new WeakMap<StoreApi<GroupSaveState>, Set<string>>();

function sameReceipt(a: SaveReceipt | undefined, b: SaveReceipt): boolean {
  return a?.plan === b.plan && a.state === b.state && a.seq === b.seq && a.says === b.says;
}

/** A retained draft follows confirmed state even while its panel is closed. */
export function bindSaveLifecycle(options: SaveLifecycleOptions): () => void {
  const { store, room, receipts } = options;
  let binding = bindings.get(store);
  if (!binding) {
    const notices = announcements.get(store) ?? new Set<string>();
    announcements.set(store, notices);
    const persist = options.persist ?? writeSaveDraft;
    let savedPage: Page | null | undefined;
    let savedReopen: SaveReopen | null | undefined;
    let running = false;
    let again = false;
    let stopped = false;
    const lookedUp = new Set<string>();
    const outcomePlans = new Set<string>();
    const initial = store.getState();
    for (const key of initial.reopen?.announced ?? []) notices.add(key);
    const restoredRequests = new Set(initial.restored ? initial.page?.requests.filter(request => request.state === "sending").map(request => request.rollId) : []);
    const queuedRequests = new Map<string, number>();

    const announce = (key: string, text: string) => {
      if (notices.has(key)) return;
      notices.add(key);
      options.notify?.(text);
    };

    const update = () => {
      if (stopped) return;
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const held = store.getState();
          const view = room.getState();
          const pendingAsks = new Set(view.pending?.flatMap(pending => pending.op.t === "roll.ask" ? [pending.op.request.id] : []) ?? []);
          for (const id of pendingAsks) queuedRequests.set(id, view.snapshots ?? 0);
          if (!held.page) {
            if (held.reopen) store.setState({ reopen: null });
            if ((held.restored || savedPage !== undefined) && (savedPage !== null || savedReopen !== null)) {
              persist(view.roomId, null);
              savedPage = null;
              savedReopen = null;
            }
            continue;
          }

          let current: SaveSession = { page: held.page, reopen: held.reopen };
          const plan = current.page.phase === "applying" ? current.page.plan?.plan : undefined;
          if (plan) outcomePlans.add(plan);
          if (current.reopen?.tracking) outcomePlans.add(current.reopen.tracking.plan);
          for (const ownedPlan of outcomePlans) receipts.announced(ownedPlan);
          if (plan) {
            let receipt = receipts.state(plan);
            // A restored in-flight Apply has no mounted watcher to look it up.
            // Fresh preparation keeps its sending marker until dispatch starts.
            if (!receipt && !lookedUp.has(plan) && current.reopen?.receipt?.state !== "sending") {
              lookedUp.add(plan);
              void receipts.lookup(plan);
              receipt = receipts.state(plan);
            }
            if (receipt) {
              const next: SaveReceipt = {
                plan,
                state: receipt.state,
                ...((receipt.state === "committed" || receipt.state === "refused") && receipt.seq !== undefined ? { seq: receipt.seq } : {}),
                ...(receipt.state === "refused" ? { says: receipt.text } : {}),
              };
              if (!sameReceipt(current.reopen?.receipt, next)) current = { ...current, reopen: { ...current.reopen, check: current.reopen?.check ?? "checking", receipt: next } };
            }
          }

          const authority = authorityOf(view, current.page);
          const receipt = current.reopen?.receipt;
          current = reconcileSave(current, authority);
          if (authority.ready && authority.sceneAvailable && (current.page.phase === "setup" || current.page.phase === "rolled") && (!current.reopen?.tracking || current.reopen.check === "undone")) {
            const confirmed = view.confirmed as RoomState;
            let page = syncRequests(current.page, confirmed.rolls, (target) => creatureKey(confirmed, target));
            for (const request of page.requests) {
              const queuedAt = queuedRequests.get(request.rollId);
              // A fresh preparation precedes dispatch. Only a reloaded request
              // or a covering snapshot can settle an ask whose answer was lost.
              const settledQueue = restoredRequests.has(request.rollId) || queuedAt !== undefined && (view.snapshots ?? 0) > queuedAt;
              if (request.state === "sending" && settledQueue && view.pending && !pendingAsks.has(request.rollId) && !confirmed.rolls[request.rollId]) {
                page = askAnswered(page, request.rollId, { ok: false, message: "The ask could not be confirmed. Ask again to continue." });
              }
              if (page.requests.find(held => held.rollId === request.rollId)?.state !== "sending") {
                restoredRequests.delete(request.rollId);
                queuedRequests.delete(request.rollId);
              }
            }
            page = markGone(page, view.sceneId, (row) => confirmed.tokens[row.tokenId] !== undefined);
            current = { ...current, page };
          }

          // The page's own announcements, chosen before the draft is written, so a reload that restores the draft never makes them again.
          const said: { key: string; text: string }[] = [];
          // The receipt as it stood before reconciliation, which drops it once a refusal has restored the choices.
          if (receipt?.state === "refused" && receipt.says && authority.ready && (receipt.seq === undefined || authority.seq >= receipt.seq)) said.push({ key: JSON.stringify([current.page.id, receipt.plan, "refused"]), text: receipt.says });
          const tracked = current.reopen?.tracking;
          if (current.reopen?.notice) said.push({ key: JSON.stringify([current.page.id, tracked?.id, tracked?.plan, tracked?.revision, current.reopen.notice]), text: current.reopen.notice });
          else if (tracked && current.reopen?.check === "applied") said.push({ key: JSON.stringify([current.page.id, tracked.id, tracked.plan, tracked.revision, "applied"]), text: `${current.page.fill?.name ?? "Group save"}: applied. Undo takes it all back.` });
          const fresh = said.filter(item => !notices.has(item.key));
          if (fresh.length > 0 && current.reopen) current = { ...current, reopen: { ...current.reopen, announced: [...(current.reopen.announced ?? []), ...fresh.map(item => item.key)].slice(-SAVE_ANNOUNCED) } };

          if (current.page !== savedPage || current.reopen !== savedReopen) {
            const saved = persist(view.roomId, draftOf(current));
            if (!saved && !current.reopen?.memoryOnly) current = { ...current, reopen: { ...current.reopen, check: current.reopen?.check ?? null, memoryOnly: true } };
            else if (saved && current.reopen?.memoryOnly) current = { ...current, reopen: { ...current.reopen, memoryOnly: false } };
            savedPage = current.page;
            savedReopen = current.reopen;
          }
          if (current.page !== held.page || current.reopen !== held.reopen) store.setState(current);
          for (const item of fresh) announce(item.key, item.text);
          if (current.reopen?.memoryOnly) announce(`${current.page.id}:memory`, SAVE_MEMORY_ONLY);
        } while (again);
      } finally {
        running = false;
      }
    };

    const subscriptions = [store.subscribe(update), room.subscribe(update), receipts.subscribe(update)];
    binding = { count: 0, stop: () => { stopped = true; for (const stop of subscriptions) stop(); } };
    bindings.set(store, binding);
    update();
  }
  binding.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--binding.count === 0) {
      binding.stop();
      bindings.delete(store);
    }
  };
}
