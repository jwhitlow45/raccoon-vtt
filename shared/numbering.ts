import { LIMITS, serializedBytes } from "./limits.ts";
import type { RoomState, SceneNumbers, Token, TokenId, Viewer } from "./model.ts";
import { playersToken } from "./players.ts";
import { MAX_NAME } from "./protocol.ts";
import { ownEntry } from "./records.ts";
import { mainFloorId } from "./rules/floors.ts";

/*
 * Creature numbers the table gives. A creature takes its number when the
 * party first holds it beside another of its shown name, so "Goblin 2"
 * names one creature for everyone. The scene keeps, on its main floor,
 * each shown name's group id and how many numbers the name has given
 * (Scene.numbers), the creature keeps the group it was met in
 * (Token.met), and its number counts only while that group is its shown
 * name's on its scene now (memberOf).
 *
 * The rules that judge the room's state (numberable, memberOf,
 * tableNumber) run on the server's state, and on a DM's copy, which holds
 * every creature with its mark and every scene's numbers. A player's copy
 * carries no mark and no register: every number on it is already the
 * table's, so a label made on a device reads the number as sent.
 */

/** The most names one scene gives numbers to, a name met alone included. A name past it takes no number there. */
export const NUMBER_NAMES_MOST = 100;
/** The most numbers one name gives on one scene. A creature past it stays unnumbered. */
export const NUMBERS_MOST = 10_000;
/** The most creatures one `sys.meet` names, a scene's most tokens. A batch that meets more appends several. */
export const MEET_IDS_MOST = LIMITS.tokensPerScene;
/** What a name-hidden creature with no public name is called, on every copy but the DM's and its owners'. */
export const UNKNOWN_CREATURE = "Unknown creature";

/** The parts of the room the rules read: the scenes for the register, and the members and characters for who plays a creature. */
export type NumberState = Pick<RoomState, "scenes" | "members" | "characters">;

/** The fields of a creature the rules read. */
export type NumberToken = Pick<Token, "sceneId" | "kind" | "name" | "ownerIds" | "actor"> & Partial<Pick<Token, "nameHidden" | "publicName" | "companion" | "number" | "met">>;

/**
 * The name a creature carries in a copy that is not its DM's or its
 * owners': its public name or "Unknown creature" while its name is hidden,
 * else its name. Every numbering rule groups by it, so a disguised Orc
 * shown as a Goblin is a Goblin to them. On a player's copy of a creature
 * they do not own, `name` already is this name.
 */
export function shownName(token: Pick<Token, "name"> & Partial<Pick<Token, "nameHidden" | "publicName">>): string {
  return token.nameHidden === true ? (token.publicName ?? UNKNOWN_CREATURE) : token.name;
}

/**
 * Whether the creature can carry a number: a monster or an NPC, and not a
 * companion players read as one, which is a party member's companion. A
 * companion of a character no player plays reaches players as a plain
 * creature, so it is numbered as one.
 */
export function numberable(state: Pick<RoomState, "members" | "characters">, token: Pick<Token, "kind" | "ownerIds" | "actor"> & Partial<Pick<Token, "companion">>): boolean {
  if (token.kind !== "monster" && token.kind !== "npc") return false;
  return !(token.companion !== undefined && playersToken(state, token));
}

/** The scene a creature's numbers belong to: its scene's main floor, so every floor of one scene numbers together. */
export function numberScope(state: Pick<RoomState, "scenes">, token: Pick<Token, "sceneId">): string {
  return mainFloorId(state, token.sceneId);
}

/** A scene's numbers, read on its main floor. None given reads as an empty register. */
export function numbersOf(state: Pick<RoomState, "scenes">, scopeId: string): SceneNumbers["names"] {
  return ownEntry(state.scenes, scopeId)?.numbers?.names ?? {};
}

/** The group id and count a shown name holds on a scene, or undefined when the party has met none there. */
export function nameEntry(state: Pick<RoomState, "scenes">, scopeId: string, name: string): readonly [g: number, n: number] | undefined {
  return ownEntry(numbersOf(state, scopeId), name);
}

/**
 * Whether the creature is a member of its shown name's group on its scene
 * now: it has a mark, its scene has numbers, they hold an own entry for its
 * shown name, and that entry's group is its mark. A missing part answers
 * false, so a number from before numbers were given this way, one under
 * another name or scene, and a copied one count for nothing.
 */
export function memberOf(state: Pick<RoomState, "scenes">, token: Pick<Token, "sceneId" | "name"> & Partial<Pick<Token, "nameHidden" | "publicName" | "met">>): boolean {
  if (token.met === undefined) return false;
  const entry = nameEntry(state, numberScope(state, token), shownName(token));
  return entry !== undefined && entry[0] === token.met;
}

/** The number the table reads on the creature: its own, for a numberable member, and none otherwise. */
export function tableNumber(state: NumberState, token: NumberToken): number | undefined {
  return token.number !== undefined && numberable(state, token) && memberOf(state, token) ? token.number : undefined;
}

/**
 * A creature's label in parts. `name` is what the viewer reads first.
 * `number` is the table's number, and `preview`, on a DM's board alone,
 * the number it would take if the party met it now, never with `number`.
 * `as` is the shown name players read, for a DM or an owner when it is not
 * the creature's name and a number or a preview goes with it.
 */
export type TokenLabel = { name: string; number?: number; preview?: number; as?: string };

/** Who a label is for: a viewer who reads the shown name, the DM or an owner, or a DM's board with previews. */
export type LabelFor = "public" | "own" | "board";

/**
 * The creature's label in parts. `room` is the server's state, whose
 * numbers are judged (tableNumber), or null for a device's copy, whose
 * numbers are read as sent. `previews` are a DM's board's, from
 * previewNumbers.
 */
export function labelParts(room: NumberState | null, token: NumberToken & Pick<Token, "id">, labelFor: LabelFor, previews?: ReadonlyMap<TokenId, number>): TokenLabel {
  const shown = shownName(token);
  const number = room === null ? token.number : tableNumber(room, token);
  const preview = labelFor === "board" && number === undefined ? previews?.get(token.id) : undefined;
  const name = labelFor === "public" ? shown : token.name;
  const out: TokenLabel = { name };
  if (number !== undefined) out.number = number;
  if (preview !== undefined) out.preview = preview;
  if (shown !== name && (number !== undefined || preview !== undefined)) out.as = shown;
  return out;
}

/** "Goblin 2", "Goblin (3)", "Orc (as Goblin 2)" and "Orc (as Goblin (3))". */
export function labelText(label: TokenLabel): string {
  const suffix = label.number !== undefined ? ` ${label.number}` : label.preview !== undefined ? ` (${label.preview})` : "";
  return label.as !== undefined ? `${label.name} (as ${label.as}${suffix})` : `${label.name}${suffix}`;
}

/** What a viewer who reads the shown name reads: the shown name and the table's number. Every stored text and every op uses it. */
export function publicLabel(room: NumberState | null, token: NumberToken & Pick<Token, "id">): string {
  return labelText(labelParts(room, token, "public"));
}

/** What the DM and the creature's owners read: its name and the table's number, with the shown name after a disguise's. */
export function ownLabel(room: NumberState | null, token: NumberToken & Pick<Token, "id">): string {
  return labelText(labelParts(room, token, "own"));
}

/**
 * The label on a device's board: `ownLabel`, with a DM's preview. The role
 * is an argument, so a player's board never shows a preview, whatever its
 * copy holds. The server never makes one.
 */
export function boardLabel(previews: ReadonlyMap<TokenId, number>, token: NumberToken & Pick<Token, "id">, role: Viewer["role"]): string {
  return labelText(labelParts(null, token, role === "dm" ? "board" : "own", previews));
}

/**
 * The numbers a DM's board previews on one scene, by creature: for each
 * shown name, the numberable creatures of the scene that are not members,
 * in id order, take the numbers after the last the name has given. That is
 * what the party's meeting them all now would give, since creatures met
 * together are numbered in id order. A name the party has not met gives a
 * preview only to two or more, since one met alone reads plain. No preview
 * passes a cap. Run on a DM's copy, which holds every floor of the scene
 * with every creature and the stored scene.
 */
export function previewNumbers(view: NumberState & Pick<RoomState, "tokens">, scopeId: string): Map<TokenId, number> {
  const names = numbersOf(view, scopeId);
  const unmet = new Map<string, TokenId[]>();
  for (const token of Object.values(view.tokens)) {
    if (numberScope(view, token) !== scopeId || !numberable(view, token) || memberOf(view, token)) continue;
    const name = shownName(token);
    const ids = unmet.get(name);
    if (ids) ids.push(token.id);
    else unmet.set(name, [token.id]);
  }
  const full = Object.keys(names).length >= NUMBER_NAMES_MOST;
  const out = new Map<TokenId, number>();
  for (const [name, ids] of unmet) {
    const entry = ownEntry(names, name);
    if (entry === undefined && (full || ids.length < 2)) continue;
    const given = entry?.[1] ?? 0;
    ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < ids.length && given + i + 1 <= NUMBERS_MOST; i++) out.set(ids[i]!, given + i + 1);
  }
  return out;
}

let registerBound: number | undefined;

/**
 * The most bytes one scene's numbers can add to its stored record,
 * `,"numbers":` included: NUMBER_NAMES_MOST names of the longest a name
 * can be, each character a lone surrogate JSON writes as six bytes, each
 * with the widest group id and the most numbers. Worked out once, from a
 * register built at the caps.
 */
export function registerBytesMost(): number {
  if (registerBound !== undefined) return registerBound;
  const names: Record<string, [number, number]> = {};
  for (let i = 0; i < NUMBER_NAMES_MOST; i++) names[String.fromCharCode(0xd800 + i).repeat(MAX_NAME)] = [Number.MAX_SAFE_INTEGER, NUMBERS_MOST];
  // `{"numbers":...}` less `{}` is the field's bytes, and the comma before it adds one.
  registerBound = serializedBytes({ numbers: { names } }) - serializedBytes({}) + 1;
  return registerBound;
}
