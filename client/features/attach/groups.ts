import { LIMITS } from "#shared/limits.ts";
import type { Token } from "#shared/model.ts";
import { carriedGroup, carriedIndex, fullRect, holderOf, publicMembers, type SeenByAll } from "#shared/rules/attach.ts";
import type { PlacedToken } from "#shared/rules/footprint.ts";
import { displayName } from "../../lib/scene.ts";

/**
 * What a group of attached tokens looks like on the map and moves like
 * under a finger (docs/design-v1-attach.md 4.2 and 4.4), as plain
 * functions for node --test. Every one reads the links of this viewer's
 * own copy through one children index (carriedIndex), kept per tokens
 * record, so the draw order, the drag and the group line share it.
 */

type Tokens = Readonly<Record<string, Token | undefined>>;

/** A carried token drawn inset, to this share of its size, so the mount's edge and ring show around it. */
export const COVER_INSET = 0.7;

/** Whether a carried token's footprint covers its holder's whole footprint, as a Small rider on a Medium mastiff does (4.2, 4.4). */
export function coversHolder(carried: PlacedToken, holder: PlacedToken): boolean {
  const a = fullRect(carried);
  const b = fullRect(holder);
  const eps = 1e-9;
  return a.x <= b.x + eps && a.y <= b.y + eps && a.x + a.w >= b.x + b.w - eps && a.y + a.h >= b.y + b.h - eps;
}

/** Whether a token draws inset: it sits on a holder in this copy and covers it. */
export function drawsInset(tokens: Tokens, token: Token): boolean {
  const link = token.attached;
  if (!link || link.kind === "drag") return false;
  const holder = holderOf(tokens, token) as Token | undefined;
  return holder !== undefined && coversHolder(token, holder);
}

/**
 * The tokens in the order they draw (4.4): each carried token right after
 * its holder, whatever its layer, what it carries in turn right after it,
 * in token id order, so a torch on the objects layer shows on the hand
 * holding it. A holder not in the list leaves its tokens where they stood.
 * A loop the rules let stand is drawn whole, from its first token in the
 * list's order.
 */
export function drawOrder<T extends Token>(list: readonly T[], tokens: Tokens): T[] {
  const index = carriedIndex(tokens);
  const inList = new Map(list.map((t) => [t.id, t]));
  // Without one link in the list there is nothing to reorder, the common case.
  if (!list.some((t) => t.attached !== undefined && inList.has(t.attached.to))) return [...list];
  const out: T[] = [];
  const placed = new Set<string>();
  const emit = (t: T) => {
    placed.add(t.id);
    out.push(t);
    for (const id of index.get(t.id) ?? []) {
      const child = inList.get(id);
      if (child && !placed.has(id)) emit(child);
    }
  };
  for (const t of list) {
    const to = t.attached?.to;
    if (!placed.has(t.id) && (to === undefined || !inList.has(to) || holderOf(tokens, t) === undefined)) emit(t);
  }
  for (const t of list) if (!placed.has(t.id)) emit(t);
  return out;
}

/**
 * The token a drag that starts on `token` moves (4.2): a rider of a
 * controlled mount drags the mount, since it "moves on your turn as you
 * direct it", and so does a carried token that covers its holder, which
 * could never move within it. Up the chain while that holds. Any other
 * token drags itself.
 */
export function dragLead(tokens: Tokens, token: Token): Token {
  let at = token;
  const seen = new Set<string>([at.id]);
  for (;;) {
    const holder = holderOf(tokens, at) as Token | undefined;
    const link = at.attached;
    if (!holder || !link || seen.has(holder.id)) return at;
    const steered = link.kind === "ride" && link.steer === true;
    if (!steered && !(link.kind !== "drag" && coversHolder(at, holder))) return at;
    seen.add(holder.id);
    at = holder;
  }
}

/** The words when a drag would move a mount the viewer may not move (4.2). */
export function carriesText(mount: Token, rider: Token): string {
  return `${displayName(mount)} carries ${displayName(rider)}. Tap Get off to step down.`;
}

/**
 * What a drag of `leadId` takes along in this copy, after the lead itself:
 * its group stopping at the other tokens the drag names, at most a group's
 * limit, so a frame moves no more nodes than a 20-token selection does
 * (11).
 */
export function groupMembers(tokens: Tokens, leadId: string, named: ReadonlySet<string> = new Set()): string[] {
  return carriedGroup(tokens, leadId, named).slice(1, 1 + LIMITS.groupTokens);
}

/**
 * The dragged creatures of a group that walk beside the lead (4.2): among
 * its public members, those whose own link is a drag. What rides is never
 * tested against walls, and a dragged creature players cannot all see is
 * the server's to stop, unseen.
 */
export function dragWalkers(tokens: Tokens, leadId: string, seen: SeenByAll, named: ReadonlySet<string> = new Set()): Token[] {
  const out: Token[] = [];
  for (const id of publicMembers(tokens, leadId, seen, named).slice(1)) {
    const t = tokens[id];
    if (t?.attached?.kind === "drag") out.push(t);
  }
  return out;
}

/** A tether's two ends, the dragged creature's center and its holder's, and the holder whose ring color it takes. */
export type Tether = { id: string; holderId: string; from: { x: number; y: number }; to: { x: number; y: number } };

/** Every drag link on the scene this copy holds both ends of, in token id order (4.4). */
export function tethers(tokens: Tokens, sceneId: string, at: (t: Token) => { x: number; y: number } = (t) => t): Tether[] {
  const out: Tether[] = [];
  for (const [holderId, ids] of carriedIndex(tokens)) {
    const holder = tokens[holderId];
    if (!holder || holder.sceneId !== sceneId) continue;
    for (const id of ids) {
      const t = tokens[id];
      if (t?.attached?.kind !== "drag") continue;
      out.push({ id, holderId, from: center(t, at(t)), to: center(holder, at(holder)) });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function center(t: Token, p: { x: number; y: number }): { x: number; y: number } {
  const r = fullRect({ ...t, x: p.x, y: p.y });
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * The group line in the bar (4.4): "On Warhorse" or "Dragged by Thorn" on a
 * carried token, and on a holder what it carries, each a button that
 * selects it, so a phone reaches a rider that hides its mount.
 */
export type GroupLine = { holder: { id: string; text: string } | null; carried: { id: string; name: string; token: Token }[] };

export function groupLine(tokens: Tokens, token: Token): GroupLine {
  const holder = holderOf(tokens, token) as Token | undefined;
  const up = holder && token.attached ? { id: holder.id, text: token.attached.kind === "drag" ? `Dragged by ${displayName(holder)}` : `On ${displayName(holder)}` } : null;
  const carried = (carriedIndex(tokens).get(token.id) ?? []).flatMap((id) => {
    const t = tokens[id];
    return t ? [{ id, name: displayName(t), token: t }] : [];
  });
  return { holder: up, carried };
}

/**
 * The tokens a drag names (4.2): its lead, then the rest of the selection
 * that moves with it, each a rider of a controlled mount or a covering
 * token turned into the mount it moves, and one a viewer may not move that
 * way left where it is. A token whose holder, or a holder above it, is
 * named too is left out, since it goes with that holder, so each token
 * moves once.
 */
export function dragNamed<T extends Token>(tokens: Tokens, lead: T, followers: readonly T[], byId: ReadonlyMap<string, T>, movesLead: (token: T) => boolean): T[] {
  const named = new Map<string, T>([[lead.id, lead]]);
  for (const f of followers) {
    const up = dragLead(tokens, f);
    const moved = up.id === f.id ? f : byId.get(up.id);
    if (!moved || named.has(moved.id) || (moved !== f && !movesLead(moved))) continue;
    named.set(moved.id, moved);
  }
  const ridesOnNamed = (t: T): boolean => {
    const seen = new Set<string>([t.id]);
    for (let up = holderOf(tokens, t); up && !seen.has(up.id); up = holderOf(tokens, up)) {
      if (named.has(up.id)) return true;
      seen.add(up.id);
    }
    return false;
  };
  return [...named.values()].filter((t) => t.id === lead.id || !ridesOnNamed(t));
}

/** Why a player's drop of a token they may only re-seat is put back (6): it would leave its holder. */
export function reseatText(carried: Token, holder: Token): string {
  const where = carried.attached?.kind === "drag" ? `within 5 ft of ${displayName(holder)}` : `on ${displayName(holder)}`;
  return `You can only move ${displayName(carried)} ${where}.`;
}
