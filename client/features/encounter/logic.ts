import type { Effect, Encounter, InitEntry, LogEntry, RoomState, Token } from "#shared/model.ts";
import type { ClientOp, EntryInput } from "#shared/protocol.ts";
import { MAX_ENTRIES_PER_OP } from "#shared/protocol.ts";
import type { ProjectedActor } from "#shared/project.ts";
import { withheldWhereItStands } from "#shared/project.ts";
import { hpLess } from "#shared/rules/hp.ts";
import { actsOnCharacterTurn } from "#shared/reducer/companions.ts";
import { advantageHint, compareEntries, rowCharacter } from "#shared/rules/initiative.ts";
import { displayName } from "../../lib/scene.ts";

/**
 * The initiative tracker's decisions, kept free of React and the DOM so they
 * run under plain Node tests. Everything here reads the client's view, which
 * for a player is the projection (design section 7.3): hidden rows, hidden
 * names and secret HP are already gone, so these helpers only decide how to
 * show what arrived.
 */

/** The bounds `encounter.setValue` accepts (shared/protocol.ts). */
export const MIN_VALUE = -50;
export const MAX_VALUE = 100;

export function sortedEntries(entries: readonly InitEntry[]): InitEntry[] {
  return [...entries].sort(compareEntries);
}

// ---------------------------------------------------------------- typing values

export type ParsedValue = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * One typed initiative result: whatever the physical die or the D&D Beyond
 * app said. The app's own rolls happen on the server (autoRoll.ts for
 * monsters) and never pass through this parser. An empty box clears the value.
 * iOS keyboards and pasted text can carry a typographic minus sign, so it
 * counts as a plain one.
 */
export function parseInitiative(text: string): ParsedValue {
  const t = text.trim().replace(/−/g, "-");
  if (t === "") return { ok: true, value: null };
  if (!/^[+-]?\d{1,3}$/.test(t)) return { ok: false, error: "Type a whole number, like 14." };
  const n = Number(t);
  if (n < MIN_VALUE || n > MAX_VALUE) return { ok: false, error: `Use a number from ${MIN_VALUE} to ${MAX_VALUE}.` };
  // Number("-0") is -0, which JSON would send as 0 anyway.
  return { ok: true, value: n === 0 ? 0 : n };
}

/** The text a value box starts with. */
export function valueText(value: number | null): string {
  return value === null ? "" : String(value);
}

// ---------------------------------------------------------------- groups

export type EntryGroup = { key: string; entryIds: string[] };

/**
 * Rows the DM can type one value for: identical monsters share a `groupKey`
 * (the SRD id, or the base name), and every other row stands alone. Groups
 * keep the table's order, by their first row.
 */
export function groupEntries(entries: readonly InitEntry[]): EntryGroup[] {
  const byKey = new Map<string, EntryGroup>();
  const out: EntryGroup[] = [];
  for (const entry of entries) {
    const key = entry.groupKey !== undefined ? `group:${entry.groupKey}` : `entry:${entry.id}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, entryIds: [] };
      byKey.set(key, group);
      out.push(group);
    }
    group.entryIds.push(entry.id);
  }
  return out;
}

/** One input of the "enter several values" form: a single row, or a whole group sharing one value. */
export type ValueField = { key: string; entryIds: string[]; text: string };

export type ValueChanges = { values: { entryId: string; value: number | null }[]; errors: Record<string, string> };

/**
 * What one `encounter.setValues` should carry for the form: every row whose
 * value the form changes, and an error per field that does not parse. Rows
 * that already hold the typed value are left out, so saving an untouched
 * form sends nothing.
 */
export function valueChanges(fields: readonly ValueField[], current: (entryId: string) => number | null): ValueChanges {
  const values: ValueChanges["values"] = [];
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const parsed = parseInitiative(field.text);
    if (!parsed.ok) {
      errors[field.key] = parsed.error;
      continue;
    }
    for (const entryId of field.entryIds) {
      if (current(entryId) !== parsed.value) values.push({ entryId, value: parsed.value });
    }
  }
  return { values, errors };
}

// ---------------------------------------------------------------- tie order

/** The run of rows around `index` that share its value: the only rows a drag may reorder. `end` is exclusive. */
export function tieRun(entries: readonly InitEntry[], index: number): { start: number; end: number } {
  const value = entries[index]?.value;
  let start = index;
  let end = index + 1;
  while (start > 0 && entries[start - 1]!.value === value) start--;
  while (end < entries.length && entries[end]!.value === value) end++;
  return { start, end };
}

/**
 * Moves a row within its tie and returns the ids `encounter.reorder` needs,
 * or null when nothing moves. In 2024 the DM decides ties, and the order is
 * value first, so a row can never be dragged past a different value.
 *
 * Only the tie's own rows are sent: the reducer gives the listed rows the
 * lowest tieOrders in the given order, and every other row keeps its order
 * behind them, which leaves every other tie exactly as it was.
 */
export function reorderTie(entries: readonly InitEntry[], entryId: string, toIndex: number): string[] | null {
  const from = entries.findIndex((e) => e.id === entryId);
  if (from < 0) return null;
  const { start, end } = tieRun(entries, from);
  const to = Math.min(end - 1, Math.max(start, toIndex));
  if (to === from) return null;
  const ids = entries.slice(start, end).map((e) => e.id);
  ids.splice(from - start, 1);
  ids.splice(to - start, 0, entryId);
  return ids;
}

/**
 * Where a dragged row lands: the number of other rows whose middle is above
 * the pointer. `mids` are the rows' vertical centers, measured when the drag
 * began, in table order. A row below the dragged one counts once the
 * pointer reaches its middle, as one above it does once the pointer leaves
 * it: the drag stops at the last middle of its tie, and with both counted
 * only past their middles a row dragged down never took the last place.
 */
export function dropIndex(mids: readonly number[], from: number, y: number): number {
  let index = 0;
  for (let i = 0; i < mids.length; i++) {
    if (i !== from && (i < from ? mids[i]! < y : mids[i]! <= y)) index++;
  }
  return index;
}

// ---------------------------------------------------------------- whose row

/** The view as tracker helpers read it. Players' views are projections, so most fields can be missing. */
export type TrackerView = Pick<RoomState, "tokens" | "characters">;

/**
 * Whether the viewer owns the creature behind a row, through its token or
 * its character, the same rule the server applies to End Turn
 * (shared/permissions.ts). An owner's projection carries the owner lists.
 */
export function ownsEntry(view: TrackerView, memberId: string, entry: Pick<InitEntry, "tokenId" | "characterId">): boolean {
  if (entry.tokenId !== undefined) {
    const token = view.tokens[entry.tokenId];
    if (!token) return false;
    if ((token.ownerIds ?? []).includes(memberId)) return true;
    const ref = "ref" in token.actor ? token.actor.ref : undefined;
    return ref !== undefined && (view.characters[ref]?.ownerIds ?? []).includes(memberId);
  }
  if (entry.characterId !== undefined) return (view.characters[entry.characterId]?.ownerIds ?? []).includes(memberId);
  return false;
}

/** Whether any player owns the creature, directly or through its character. The DM answers for the rest. */
export function playerOwnedEntry(view: TrackerView, target: { tokenId?: string; characterId?: string }): boolean {
  if (target.tokenId !== undefined) {
    const token = view.tokens[target.tokenId];
    if (!token) return false;
    if ((token.ownerIds ?? []).length > 0) return true;
    const ref = "ref" in token.actor ? token.actor.ref : undefined;
    return ref !== undefined && (view.characters[ref]?.ownerIds ?? []).length > 0;
  }
  if (target.characterId !== undefined) return (view.characters[target.characterId]?.ownerIds ?? []).length > 0;
  return false;
}

/** The actor behind a row as this viewer received it: owners and the DM get it whole, others a public cut. */
export function entryActor(view: TrackerView, entry: Pick<InitEntry, "tokenId" | "characterId">): ProjectedActor | undefined {
  if (entry.tokenId !== undefined) {
    const token = view.tokens[entry.tokenId];
    if (!token) return undefined;
    if ("inline" in token.actor) return token.actor.inline as ProjectedActor;
    return view.characters[token.actor.ref]?.actor as ProjectedActor | undefined;
  }
  if (entry.characterId !== undefined) return view.characters[entry.characterId]?.actor as ProjectedActor | undefined;
  return undefined;
}

export function entryName(view: TrackerView, entry: Pick<InitEntry, "tokenId" | "characterId" | "label">): string {
  if (entry.tokenId !== undefined) {
    const token = view.tokens[entry.tokenId];
    if (token) return displayName(token);
    // A DM's view holds one scene's tokens, so a row can point at a creature on another one.
    return entry.label ?? "Creature on another scene";
  }
  if (entry.characterId !== undefined) {
    const character = view.characters[entry.characterId];
    if (character) return character.name;
  }
  return entry.label ?? "Unknown creature";
}

/**
 * Whether this view cannot place the row's creature: its token stands on a
 * scene the view does not hold, and the DM gave the row no label, so its
 * name is the placeholder entryName gives. Its picture is then the "?" of
 * an unknown creature: initials of the placeholder ("CO") read as a name,
 * the same for every such row.
 */
export function onAnotherScene(view: TrackerView, entry: Pick<InitEntry, "tokenId" | "label">): boolean {
  return entry.tokenId !== undefined && view.tokens[entry.tokenId] === undefined && entry.label === undefined;
}

/**
 * Which disposition a row's picture rings itself with: its token's, or an
 * ally's for a character with no token here, as party members are. The "?"
 * of an unknown creature (onAnotherScene) takes the neutral ring (OP-10),
 * since nothing in this view says whose side it is on, and the ally ring
 * called it a friend.
 */
export function portraitDisposition(token: Pick<Token, "disposition"> | undefined, unknown: boolean): Token["disposition"] {
  if (unknown) return "neutral";
  return token?.disposition ?? "ally";
}

export function isDefeated(actor: Pick<ProjectedActor, "life"> | undefined): boolean {
  return actor?.life === "dead";
}

// ---------------------------------------------------------------- what a row shows

export type HpView =
  | { kind: "none" }
  | { kind: "exact"; cur: number; max: number; temp: number }
  | { kind: "bar"; fraction: number }
  | { kind: "label"; label: string };

/**
 * A row's HP from whatever the projection sent: numbers for the DM, owners
 * and visible party HP, a rounded bar or a label for monsters set that way,
 * and nothing when the creature's HP is hidden.
 */
export function hpView(actor: ProjectedActor | undefined): HpView {
  const hp = actor?.hp;
  if (hp && Number.isFinite(hp.cur) && Number.isFinite(hp.max) && hp.max > 0) {
    return { kind: "exact", cur: hp.cur, max: hp.max, temp: hp.temp ?? 0 };
  }
  if (typeof actor?.hpBar === "number" && Number.isFinite(actor.hpBar)) {
    return { kind: "bar", fraction: Math.min(1, Math.max(0, actor.hpBar)) };
  }
  if (actor?.hpLabel) return { kind: "label", label: actor.hpLabel };
  if (actor?.life === "dead") return { kind: "label", label: "Dead" };
  if (actor?.life === "dying" || actor?.life === "stable") return { kind: "label", label: "Dying" };
  return { kind: "none" };
}

/**
 * The AC a row shows in its shield (docs/design-v1-combat-flow.md 3.3):
 * whatever AC this viewer's copy holds, which is every creature's for the
 * DM and a player's own creatures' for them, since the projection sends no
 * other. None for an AC of 0, a dead creature (a corpse's AC answers
 * nothing, and the map's badge hides on the dead too), or a creature with
 * no HP to show, such as an effect (hpLess).
 */
export function rowAc(actor: ProjectedActor | undefined, token?: Pick<Token, "kind"> & { companion?: unknown }): number | null {
  const ac = actor?.ac;
  if (typeof ac !== "number" || !(ac > 0)) return null;
  if (actor?.life === "dead" || hpLess(actor, token)) return null;
  return ac;
}

/**
 * The roll reminder next to a row (design 9.4): the DM's hand-set reminder,
 * or else what the creature's effects say. Invisible rolls with advantage,
 * Surprised or Incapacitated with disadvantage.
 */
export function rollReminder(entry: Pick<InitEntry, "advantage">, effects: readonly Effect[] | undefined): "adv" | "dis" | undefined {
  return entry.advantage ?? advantageHint([...(effects ?? [])]);
}

// ---------------------------------------------------------------- turns

/**
 * Whether the fight's first turn has started. A player's view can lack the
 * active row (design 7.3), so the projection says it outright, and the DM's
 * full view answers from the active row.
 */
export function hasStarted(encounter: Pick<Encounter, "activeEntryId" | "started">): boolean {
  return encounter.started ?? encounter.activeEntryId !== null;
}

/**
 * Whose turn it is, as far as this viewer may know: `name` for the strip's
 * short label, `line` for the tracker's heading. Before Start nobody acts,
 * and after it a row the viewer cannot see is "another creature".
 */
export function whoseTurn(input: { dm: boolean; started: boolean; activeName: string | null; yours: boolean }): { name: string; line: string } {
  const { activeName } = input;
  if (activeName !== null) return { name: activeName, line: input.yours ? "Your turn" : `${activeName}'s turn` };
  if (!input.started) return { name: "Not started", line: input.dm ? "Press Start for the first turn" : "The fight has not started yet" };
  return { name: "Another creature", line: "Another creature's turn" };
}

/** How the tracker's round header shows (docs/design-v1-combat-flow.md 3.1): full and sticky, one compact sticky row, or full and scrolling with the list. */
export type RoundHeaderForm = "full" | "compact" | "static";

/** The compact header's one row: the buttons' touch height. */
export const COMPACT_HEADER_PX = 44;

/** What the header's form is measured from, in the scroller's pixels, borders included. */
export type RoundHeaderRoom = {
  /** The scroller's whole height with its padding: `clientHeight`. */
  scroller: number;
  /** The header in full, as it sticks: the pane's top padding it takes back, its rows and its bottom border. */
  fullHeader: number;
  /** The header as one compact row, measured the same way. */
  compactHeader: number;
  /** A standard row, one with no companions under it and its options closed, with the gap to the next row. */
  row: number;
};

/** Standard rows a sticky header leaves room for under it. With two, any scroll offset shows one whole row. */
export const ROWS_UNDER_HEADER = 2;

/**
 * The header's form (docs/design-v1-combat-flow.md 3.1): full and sticky
 * while the scroller holds the full header and two standard rows, one
 * compact sticky row while it holds the compact header and two rows, and
 * otherwise full and scrolling with the list, so a short panel still
 * shows its rows.
 *
 * Two rows are enough because a stuck header hides at most the part of
 * one row above it: the next row starts within one row interval of the
 * header's bottom and ends within two. A taller row, with companions
 * under it, may not fit whole, and focus reaches its controls through
 * their scroll margin.
 */
export function roundHeaderForm(room: RoundHeaderRoom): RoundHeaderForm {
  const rows = ROWS_UNDER_HEADER * room.row;
  if (room.scroller >= room.fullHeader + rows) return "full";
  if (room.scroller >= room.compactHeader + rows) return "compact";
  return "static";
}

/** An order narrower than this, such as the very short sheet's 243 px, has no room to spare beside a row's name. */
export const NARROW_ORDER_PX = 320;

/**
 * Whether a DM's row keeps the drag handle's 44 px slot (design 9.4): a
 * tied row draws its handle there, and in a wide order an untied row keeps
 * the empty slot so every name lines up. A narrow order gives an untied
 * row's slot to its name. A width of 0, not yet measured, keeps it.
 */
export function keepsDragSlot(orderPx: number, tied: boolean): boolean {
  return tied || orderPx === 0 || orderPx >= NARROW_ORDER_PX;
}

type TurnPress = Extract<ClientOp, { t: "encounter.next" | "encounter.prev" }>;

/**
 * Next, Start, End Turn or Previous, naming the turn the press ends by its
 * row and round (features section 10). The server moves a turn only for the
 * press that names it, so a player's End Turn and the DM's Next at the same
 * moment, or two DM devices, never skip a creature. A press while this
 * device still waits on one of the same kind names that one's turn again:
 * the DM's Next is predicted, so the screen already shows the next turn,
 * and naming it would make a double tap move two. A press of the other kind
 * is a change of mind and names the turn on screen.
 */
export function turnOp(t: TurnPress["t"], room: { view: { encounter: Pick<Encounter, "activeEntryId" | "round"> | null } | null; pending: readonly { op: ClientOp }[] }): TurnPress {
  const last = room.pending.findLast((p): p is { op: TurnPress } => p.op.t === "encounter.next" || p.op.t === "encounter.prev");
  if (last && last.op.t === t && last.op.from !== undefined) return { t, from: last.op.from };
  const encounter = room.view?.encounter;
  return { t, from: { entry: encounter?.activeEntryId ?? null, round: encounter?.round ?? 1 } };
}

export type TurnStatus = "yours" | "none";

/**
 * Whether the viewer's creature is acting now.
 *
 * There is no "up next" for players. Their view lacks hidden rows and rows
 * under fog (design 7.3), so a guess from it can name them while a fogged
 * goblin acts first. The server could say for sure, but then a missing
 * banner, where the visible order says "you", would tell the player that
 * something unseen acts in between, a turn before it acts. A banner that
 * is sometimes wrong and one that gives away an ambush are both worse than
 * none.
 */
export function turnStatus(input: { entries: readonly InitEntry[]; activeEntryId: string | null; mine(entry: InitEntry): boolean }): TurnStatus {
  const active = input.activeEntryId === null ? undefined : input.entries.find((e) => e.id === input.activeEntryId);
  return active && input.mine(active) ? "yours" : "none";
}

/** Which turn the status was computed for, so a banner fires once per turn. */
export type TurnMark = { key: string; status: TurnStatus };

export function turnMark(encounter: { round: number; activeEntryId: string | null } | null, status: TurnStatus): TurnMark {
  return { key: encounter ? `${encounter.round}:${encounter.activeEntryId ?? ""}` : "", status };
}

/**
 * The banner to show when the turn changes. The first look after the page
 * opens shows the banner quietly: the browser would refuse a sound without
 * a tap anyway, and a reload is not news.
 */
export function turnAlert(prev: TurnMark | null, next: TurnMark): { kind: "yours"; loud: boolean } | null {
  if (next.status === "none") return null;
  if (prev && prev.key === next.key && prev.status === next.status) return null;
  return { kind: next.status, loud: prev !== null };
}

/**
 * The strip's rows: the active one and the few after it, in turn order and
 * passing over defeated rows the way `next` would. With no active row the
 * DM sees who starts, and a player sees nobody, since a hidden creature may
 * be acting.
 */
export function upcoming(input: {
  entries: readonly InitEntry[];
  activeEntryId: string | null;
  count: number;
  fromTop: boolean;
  skip(entry: InitEntry): boolean;
}): { current: InitEntry | null; next: InitEntry[] } {
  const { entries, count } = input;
  const index = input.activeEntryId === null ? -1 : entries.findIndex((e) => e.id === input.activeEntryId);
  const current = index >= 0 ? entries[index]! : null;
  if (!current && !input.fromTop) return { current: null, next: [] };
  const next: InitEntry[] = [];
  for (let step = 1; step <= entries.length && next.length < count; step++) {
    const entry = entries[(index + step + entries.length) % entries.length]!;
    if (entry === current) break;
    if (input.skip(entry)) continue;
    next.push(entry);
  }
  return { current, next };
}

/**
 * The initiative strip's rows for this viewer (features section 10): the
 * acting row, and for the DM alone the next few. A player's order leaves
 * out hidden and fogged creatures, so who comes next could be wrong there,
 * and it is never shown (see turnStatus).
 */
export function stripRows(input: {
  dm: boolean;
  entries: readonly InitEntry[];
  activeEntryId: string | null;
  count: number;
  skip(entry: InitEntry): boolean;
}): { current: InitEntry | null; next: InitEntry[] } {
  return upcoming({ entries: input.entries, activeEntryId: input.activeEntryId, count: input.dm ? input.count : 0, fromTop: input.dm, skip: input.skip });
}

// ---------------------------------------------------------------- adding rows

export type AddMode = "selected" | "scene" | "visible";

function tokenOrder(a: Token, b: Token): number {
  const an = displayName(a);
  const bn = displayName(b);
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Tokens the DM can add from the scene on screen. Objects (chests, doors)
 * and the dead are left out of the whole-scene modes, and either can still
 * be added by selecting it. "Visible" means what players can see: not
 * hidden, and not withheld where it stands by the rule projections use,
 * which reads the DM's fog and the party's explored ground merged, and on a
 * vision scene the party's sight (design 13.4 and 13.6). The DM's view
 * holds both layers and the sight tiles of the scene on screen, so a fog
 * check alone would leave out every monster the party sees in explored
 * ground.
 */
export function addCandidates(view: RoomState, sceneId: string | null, mode: AddMode, selectedId: string | null): Token[] {
  if (sceneId === null) return [];
  const taken = new Set((view.encounter?.entries ?? []).map((e) => e.tokenId).filter((id) => id !== undefined));
  const out: Token[] = [];
  for (const token of Object.values(view.tokens)) {
    if (!token || token.sceneId !== sceneId || taken.has(token.id)) continue;
    // A companion that acts on its character's turn takes no row of its own, which the server refuses anyway (docs/design-v1-combat-flow.md 3.6.7).
    if (actsOnCharacterTurn(token)) continue;
    if (mode === "selected") {
      if (token.id === selectedId) out.push(token);
      continue;
    }
    if (token.kind === "object" || isDefeated(entryActor(view, { tokenId: token.id }))) continue;
    if (mode === "visible" && (token.visibility === "dm" || withheldWhereItStands(view, token))) continue;
    out.push(token);
  }
  return out.sort(tokenOrder);
}

/** A player's own creatures on their scene that are not in the fight yet. */
export function ownCandidates(view: Pick<RoomState, "tokens" | "characters" | "encounter">, memberId: string, sceneId: string | null): Token[] {
  if (sceneId === null) return [];
  const taken = new Set((view.encounter?.entries ?? []).map((e) => e.tokenId).filter((id) => id !== undefined));
  return Object.values(view.tokens)
    .filter((t) => t && t.sceneId === sceneId && t.kind !== "object" && !taken.has(t.id) && !actsOnCharacterTurn(t) && ownsEntry(view, memberId, { tokenId: t.id }))
    .sort(tokenOrder);
}

/**
 * The companions listed under a row (docs/design-v1-combat-flow.md 3.6.7):
 * those in this viewer's copy that act on the row's character's turn,
 * listed under it, by name. The row's character is `rowCharacter`'s, the
 * one the server's Reaction reset reads, so a row naming one player's
 * token and another's character nests its token's character's companions
 * only. A companion on another scene, or one the viewer cannot see, is not
 * in the copy, so it is not nested.
 */
export function nestedCompanions(view: Pick<RoomState, "tokens">, entry: Pick<InitEntry, "tokenId" | "characterId">): Token[] {
  const characterId = rowCharacter(view, entry);
  if (characterId === undefined) return [];
  return Object.values(view.tokens)
    .filter((t): t is Token => !!t && t.companion?.turn === "shared" && t.companion.of === characterId)
    .sort(tokenOrder);
}

/** New rows for tokens, cut into batches the op schema accepts. The reducer fills groups, hidden flags and scores. */
export function entryBatches(tokens: readonly Token[], newId: () => string): EntryInput[][] {
  const inputs: EntryInput[] = tokens.map((t) => ({ id: newId(), tokenId: t.id }));
  const batches: EntryInput[][] = [];
  for (let i = 0; i < inputs.length; i += MAX_ENTRIES_PER_OP) batches.push(inputs.slice(i, i + MAX_ENTRIES_PER_OP));
  return batches;
}

/**
 * Monster rows still waiting for a value that have a 2024 initiative score
 * (10 + Dex modifier), for rooms that use scores instead of rolls. The same
 * rule `encounter.add` applies (shared/rules/initiative.ts scoredValue), for
 * rows added before the setting was turned on.
 */
export function scoreFills(view: TrackerView, entries: readonly InitEntry[]): { entryId: string; value: number }[] {
  const out: { entryId: string; value: number }[] = [];
  for (const entry of entries) {
    if (entry.value !== null || entry.tokenId === undefined) continue;
    const token = view.tokens[entry.tokenId];
    if (!token || token.kind === "pc") continue;
    const score = entryActor(view, entry)?.initScore;
    if (typeof score === "number") out.push({ entryId: entry.id, value: Math.min(MAX_VALUE, Math.max(MIN_VALUE, score)) });
  }
  return out;
}

// ---------------------------------------------------------------- log events

export type ConcentrationPrompt = {
  logId: string;
  target: { tokenId: string } | { characterId: string };
  /** Missing when the viewer may not see the creature's exact HP (design 7.3). */
  dc?: number;
};

/** A concentration check the log asks for: damage to a concentrating creature, not the notice that it ended. */
export function concentrationPrompt(entry: LogEntry): ConcentrationPrompt | null {
  const data = entry.data;
  if (entry.kind !== "event" || data?.type !== "concentration" || data.ended) return null;
  const target = data.tokenId !== undefined ? { tokenId: data.tokenId } : data.characterId !== undefined ? { characterId: data.characterId } : null;
  if (!target) return null;
  return { logId: entry.id, target, ...(data.dc !== undefined ? { dc: data.dc } : {}) };
}

/** Who answers a concentration check: the creature's owner, or the DM when no player owns it. */
export function answersPrompt(view: TrackerView, you: { memberId: string; role: "dm" | "player" }, prompt: ConcentrationPrompt): boolean {
  if (you.role === "dm") return !playerOwnedEntry(view, prompt.target);
  return ownsEntry(view, you.memberId, prompt.target);
}

export type ExpiryNotice = { logId: string; target: { tokenId?: string; characterId?: string }; key: Effect["key"]; spell?: string };

export function expiryNotice(entry: LogEntry): ExpiryNotice | null {
  const data = entry.data;
  if (entry.kind !== "event" || data?.type !== "effect" || data.action !== "expire") return null;
  const target: ExpiryNotice["target"] = {};
  if (data.tokenId !== undefined) target.tokenId = data.tokenId;
  if (data.characterId !== undefined) target.characterId = data.characterId;
  return { logId: entry.id, target, key: data.key, ...(data.spell !== undefined ? { spell: data.spell } : {}) };
}
