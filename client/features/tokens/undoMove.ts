import type { HistoryActivation } from "../../state/history.ts";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RoomState, Token } from "#shared/model.ts";
import { isPoseOp, onPlayerUndoStack, type ClientOp } from "#shared/protocol.ts";
import { carriedIndex, holderOf } from "#shared/rules/attach.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { PendingOp, RoomView } from "../../state/types.ts";

/**
 * A player's latest moves on this device, so the token action bar can offer
 * "Undo move" on the tokens they moved (features 13). A player on a phone
 * has no keyboard, and the Draw tool's Undo is out of reach while moving
 * tokens.
 *
 * The server keeps the real stack (design 7.7), which holds a player's
 * drawings as well as their moves, and an undo always takes its newest step.
 * So the offers follow the ops this device queues, the way the server's
 * stack does: each move, or change of elevation or facing alone, goes on
 * top. Once the server takes the top one back for the bar, the one below it
 * is offered, so a drag and three height taps undo as four presses. A
 * drawing op, an undo or redo from anywhere else (Ctrl+Z, the Draw tool's
 * Undo), or a refusal of any of them or of the bar's undo ends them all.
 *
 * `ns` are a move's op numbers, all of one gesture, and a press names the
 * newest, so the server takes back that step or nothing. Another device's
 * ops never reach this one: after an undo or a drawing from the player's
 * laptop, the phone may still offer a move, and a press then does nothing
 * but say so.
 *
 * Marking the last move as not counting, or as counting again (the bar's
 * "Doesn't count"), is a step of the same kind, so it goes on top as an
 * offer with `mark`. While it is on top the bar offers no "Undo move",
 * and pressing "Doesn't count" again takes the mark back, which brings
 * the move's own offer back.
 */
export type Offer = { tokenIds: readonly string[]; ns: readonly number[]; group?: string; mark?: true };

export type Offers = {
  /** Oldest first, the newest on top. */
  offers: readonly Offer[];
  /** The bar's undo of the top offer on its way: its own `n`, and the offer's newest op it names. */
  undoing: { n: number; of: number } | null;
};

/** As many moves as the bar walks back. The server's stack keeps more, which Ctrl+Z still reaches. */
export const MAX_OFFERS = 20;

const NONE: Offers = { offers: [], undoing: null };

/** The offers, and the newest op number already looked at. */
type OfferState = Offers & { seen: number };

export const lastMoveSlot = scopeSlot(() => createStore<OfferState>(() => ({ ...NONE, seen: 0 })));

function newest(offer: Offer): number {
  return offer.ns[offer.ns.length - 1]!;
}

/** The offer the bar shows: the top one, unless its undo is on its way. */
export function offered(s: Offers): Offer | null {
  return s.undoing ? null : (s.offers[s.offers.length - 1] ?? null);
}

/**
 * The tokens a pose op's offer names: the tokens it moves, and for an
 * attach or a detach the holder too (docs/design-v1-attach.md 8.3), so a
 * Carry, a Drag, a Let go or a Put down sent from the holder's bar offers
 * Undo move there. `holderBefore` is the holder a token had before the op.
 */
function offerTokens(op: ClientOp, holderBefore: (tokenId: string) => string | undefined): string[] {
  if (op.t === "token.moveMany") return op.moves.map((m) => m.tokenId);
  if (op.t === "token.attach") return [op.tokenId, op.to];
  if (op.t === "token.detach") {
    const holder = holderBefore(op.tokenId);
    return holder === undefined ? [op.tokenId] : [op.tokenId, holder];
  }
  return "tokenId" in op ? [op.tokenId] : [];
}

/** The offers after this device queued `p`. Only players get them: a DM undoes from the top bar, where every change of theirs is. */
export function afterQueued(s: Offers, role: "dm" | "player", p: PendingOp, holderBefore: (tokenId: string) => string | undefined = () => undefined): Offers {
  const op = p.op;
  if (role !== "player") return NONE;
  const top = offered(s);
  if (op.t === "undo" && op.of !== undefined && top && op.of === newest(top)) return { offers: s.offers, undoing: { n: p.n, of: op.of } };
  if (op.t === "undo" || op.t === "redo") return NONE;
  if (!onPlayerUndoStack(op)) return s;
  if (!isPoseOp(op)) return NONE;
  const tokenIds = offerTokens(op, holderBefore);
  if (op.t === "token.countLeg") return { ...s, offers: [...s.offers, { tokenIds, ns: [p.n], mark: true as const }].slice(-MAX_OFFERS) };
  const last = s.offers[s.offers.length - 1];
  // The bands of one big gesture are one step on the server too.
  if (last && p.group !== undefined && last.group === p.group) {
    const merged: Offer = { tokenIds: [...last.tokenIds, ...tokenIds], ns: [...last.ns, p.n], group: p.group };
    return { ...s, offers: [...s.offers.slice(0, -1), merged] };
  }
  const offer: Offer = p.group === undefined ? { tokenIds, ns: [p.n] } : { tokenIds, ns: [p.n], group: p.group };
  return { ...s, offers: [...s.offers, offer].slice(-MAX_OFFERS) };
}

/**
 * The offers once the server answered some of this device's ops. A refused
 * move or a refused undo from the bar leaves this device unsure what the
 * stack holds, so every offer goes. The bar's undo answered without a
 * refusal took its offer back, and the one below shows.
 */
export function afterAnswers(s: Offers, pending: readonly PendingOp[], refused: readonly number[]): Offers {
  if (s.offers.some((o) => o.ns.some((n) => refused.includes(n)))) return NONE;
  const undoing = s.undoing;
  if (!undoing) return s;
  if (refused.includes(undoing.n)) return NONE;
  if (pending.some((p) => p.n === undoing.n)) return s;
  return { offers: s.offers.filter((o) => newest(o) !== undoing.of), undoing: null };
}

/**
 * The tokens a token's bar offers Undo move for (docs/design-v1-attach.md
 * 8.3): its own, its holders up the chain, since a rider's drag moves the
 * mount it directs, and what it carries itself, since an attach from its
 * bar names the carried token.
 */
export function barTokenIds(tokens: RoomState["tokens"] | undefined, token: Token): string[] {
  const out = [token.id];
  if (!tokens) return out;
  const seen = new Set(out);
  for (let up = holderOf(tokens, token); up && !seen.has(up.id); up = holderOf(tokens, up)) {
    out.push(up.id);
    seen.add(up.id);
  }
  for (const id of carriedIndex(tokens).get(token.id) ?? []) if (!seen.has(id)) out.push(id);
  return out;
}

/** Whether a bar for these tokens offers to take this move back. */
export function offersUndo(offer: Offer | null, tokenIds: readonly string[]): boolean {
  return offer !== null && offer.mark !== true && tokenIds.some((id) => offer.tokenIds.includes(id));
}

/** Whether the bar's "Doesn't count" takes back this device's own mark of the token's last move, rather than marking it anew. */
export function offersMarkUndo(offer: Offer | null, tokenId: string): boolean {
  return offer?.mark === true && offer.tokenIds.includes(tokenId);
}

/** The undo a press sends: of the move's newest op, so it takes back that move or nothing. */
export function undoOf(offer: Offer): HistoryActivation {
  return { of: newest(offer) };
}

/** Keeps a Room's offers in step with the ops its store queues and the answers it hears. Returns the unsubscribe. */
export function followOps(room: Pick<StoreApi<RoomView>, "getState" | "subscribe">, slot: StoreApi<OfferState>): () => void {
  const update = (view: RoomView) => {
    const was = slot.getState();
    let s: Offers = was;
    let seen = was.seen;
    // Each token's holder just before each queued op: as the server held it, then through this device's pending ops in order,
    // so a Let go queued behind the Carry it undoes still names the holder.
    const holders = new Map<string, string>();
    for (const [id, t] of Object.entries(view.confirmed?.tokens ?? {})) if (t?.attached) holders.set(id, t.attached.to);
    for (const p of view.pending) {
      if (p.n > seen) {
        s = afterQueued(s, view.you?.role ?? "player", p, (id) => holders.get(id));
        seen = p.n;
      }
      if (p.op.t === "token.attach") holders.set(p.op.tokenId, p.op.to);
      else if (p.op.t === "token.detach") holders.delete(p.op.tokenId);
    }
    s = afterAnswers(s, view.pending, view.refused ?? []);
    if (s.offers !== was.offers || s.undoing !== was.undoing || seen !== was.seen) slot.setState({ offers: s.offers, undoing: s.undoing, seen });
  };
  update(room.getState());
  return room.subscribe(update);
}
