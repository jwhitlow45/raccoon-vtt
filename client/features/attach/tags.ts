import type { Encounter, InitEntry, RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { carriedIndex, holderOf, isCreature } from "#shared/rules/attach.ts";
import { sortedEntries } from "../encounter/logic.ts";
import { joinWords } from "../measure/movement.ts";
import { displayName } from "../../lib/scene.ts";
import { attachAllowed, type AttachViewer, type RightsView } from "./rights.ts";

/**
 * The words a link adds to the token panel's name block and the tracker's
 * rows (docs/design-v1-attach.md 4.5 and 7.1), as plain functions for
 * node --test. They read only the links in the viewer's own copy (8.5), so
 * a player never reads a link their projection left out, and every name is
 * as the viewer sees it.
 */

type Tokens = Readonly<Record<string, Token | undefined>>;

/** What a carried token is to its holder, in the name block's words: "Riding Warhorse", "On Bree", "Dragged by Thorn". */
export function linkTag(tokens: Tokens, token: Token): string | null {
  const holder = holderOf(tokens, token) as Token | undefined;
  const link = token.attached;
  if (!holder || !link) return null;
  const name = displayName(holder);
  if (link.kind === "ride") return `Riding ${name}`;
  if (link.kind === "drag") return `Dragged by ${name}`;
  return `On ${name}`;
}

/** What a holder carries directly, by name in token id order: "Carries Bree and Torch". */
export function carriesTag(tokens: Tokens, token: Token): string | null {
  const names = (carriedIndex(tokens).get(token.id) ?? []).flatMap((id) => {
    const t = tokens[id];
    return t ? [displayName(t)] : [];
  });
  return names.length > 0 ? `Carries ${joinWords(names)}` : null;
}

/** The name block's link tags: what carries this token, then what it carries. */
export function panelLinkTags(tokens: Tokens, token: Token): string[] {
  return [linkTag(tokens, token), carriesTag(tokens, token)].filter((t): t is string => t !== null);
}

/**
 * The rider panel's Controlled or Independent (4.5), for whoever may
 * attach the pair (rights.ts): the DM, or a player who may move both, and
 * in a fight only on the rider's own turn. Null on anything but a ride
 * this copy holds both ends of.
 */
export type SteerChoice = { holderId: string; holderName: string; riderName: string; controlled: boolean };

export function steerChoice(view: RightsView, viewer: AttachViewer, rider: Token): SteerChoice | null {
  const holder = holderOf(view.tokens, rider) as Token | undefined;
  if (!holder || rider.attached?.kind !== "ride" || !attachAllowed(view, viewer, "ride", rider, holder)) return null;
  return { holderId: holder.id, holderName: displayName(holder), riderName: displayName(rider), controlled: rider.attached.steer === true };
}

/**
 * What a ride's Controlled or Independent means, as the Help line under the
 * two words (docs/design-v1-look-pass-2.md 2.7), which is also the
 * choice's description: "Warhorse moves on Thorn's turn."
 */
export function steerWords(controlled: boolean, holderName: string, riderName: string): string {
  return controlled ? `${holderName} moves on ${riderName}'s turn.` : `${holderName} keeps its own turn.`;
}

/** Ride's two words, the same in the Attach list and the rider's panel. */
export const STEER_OPTIONS = [
  { value: "controlled", label: "Controlled" },
  { value: "independent", label: "Independent" },
] as const;

/**
 * Changing it: a plain `token.attach` of the same ride where the rider
 * sits, which the reducer takes as a change of control, with no mounting
 * cost (shared/reducer/attach.ts withMountCost).
 */
export function steerOp(rider: Token, holderId: string, controlled: boolean): ClientOp {
  return { t: "token.attach", tokenId: rider.id, to: holderId, kind: "ride", ...(controlled ? { steer: true as const } : {}), x: rider.x, y: rider.y, elevation: rider.elevation };
}

/**
 * The creature that directs this mount (7.1): the first rider, in token id
 * order, that rides it by a controlled ride in this copy.
 */
export function controllingRider(tokens: Tokens, mount: Token): Token | undefined {
  for (const id of carriedIndex(tokens).get(mount.id) ?? []) {
    const t = tokens[id];
    if (t?.attached?.kind === "ride" && t.attached.steer === true && isCreature(t)) return t;
  }
  return undefined;
}

/** A tracker row's link words (4.5): a rider's "Riding Warhorse", and a controlled mount's "Controlled by Bree: ..." */
export type RowLink = { riding: string | null; controlled: string | null };

export function rowLink(tokens: Tokens, token: Token | undefined): RowLink {
  if (!token) return { riding: null, controlled: null };
  const riding = token.attached?.kind === "ride" ? linkTag(tokens, token) : null;
  const rider = controllingRider(tokens, token);
  const name = rider ? displayName(rider) : "";
  return { riding, controlled: rider ? `Controlled by ${name}: moves and acts on ${name}'s turn (Dash, Disengage or Dodge)` : null };
}

/**
 * Whether the row only marks time this round (7.1): its mount shared a
 * rider's turn in it, so its movement, actions and Reaction were that
 * turn's. The tracker reads it muted.
 */
export function marksTime(encounter: Pick<Encounter, "round"> | null | undefined, entry: Pick<InitEntry, "markRound">): boolean {
  return encounter !== null && encounter !== undefined && entry.markRound !== undefined && entry.markRound === encounter.round;
}

/** The rider's row: by its token, or by its character on a row with no token (shared/permissions.ts ownTurnOr reads it so). */
function riderRow(entries: readonly InitEntry[], rider: Token): InitEntry | undefined {
  const ref = "ref" in rider.actor ? rider.actor.ref : undefined;
  return entries.find((e) => e.tokenId === rider.id) ?? (ref !== undefined ? entries.find((e) => e.tokenId === undefined && e.characterId === ref) : undefined);
}

/**
 * The DM's "Move after Bree" on a controlled mount's acting row (7.1): a
 * ride taken while the mount's own row acts moves no row, so once its turn
 * is done the DM can put it right after its rider with the rider's value.
 * The value and the order go as one gesture. Null when the
 * row is not the acting one, it has no controlling rider with a row and a
 * value, or it already stands right after that row with that value.
 */
export function moveAfterRider(view: Pick<RoomState, "tokens" | "encounter">, entry: InitEntry): { riderName: string; ops: ClientOp[] } | null {
  const encounter = view.encounter;
  if (!encounter || encounter.activeEntryId !== entry.id || entry.tokenId === undefined) return null;
  const mount = view.tokens[entry.tokenId];
  const rider = mount ? controllingRider(view.tokens, mount) : undefined;
  const row = rider ? riderRow(encounter.entries, rider) : undefined;
  if (!rider || !row || row.id === entry.id || row.value === null) return null;
  const value = row.value;
  const order = sortedEntries(encounter.entries.map((e) => (e.id === entry.id ? { ...e, value } : e))).filter((e) => e.id !== entry.id);
  const at = order.findIndex((e) => e.id === row.id);
  const ids = [...order.slice(0, at + 1).map((e) => e.id), entry.id, ...order.slice(at + 1).map((e) => e.id)];
  const now = sortedEntries(encounter.entries).map((e) => e.id);
  if (entry.value === value && now.indexOf(entry.id) === now.indexOf(row.id) + 1) return null;
  const ops: ClientOp[] = [];
  if (entry.value !== value) ops.push({ t: "encounter.setValue", entryId: entry.id, value });
  ops.push({ t: "encounter.reorder", entryIds: ids });
  return { riderName: displayName(rider), ops };
}
