import type { Actor, Character, CompanionTurn, CreatureSize, ImageRef, RoomState, Token } from "#shared/model.ts";
import { companionLegBlocker, withinCompanionReach } from "#shared/permissions.ts";
import type { ClientOp, TokenInput } from "#shared/protocol.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { rowCharacter } from "#shared/rules/initiative.ts";
import { fitLine, type StatBlockMonster } from "#shared/srd/monsters.ts";
import type { BlockLink } from "../monsters/statBlockLink.ts";
import { footprint } from "../../lib/scene.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { blankActor, firstFreeSpot, occupiedBoxes, sizeFootprint, spreadPositions, type Point } from "./factory.ts";

/**
 * Companions as the forms build them (docs/design-v1-combat-flow.md 3.6),
 * as plain functions for node --test: the turn choices with their help,
 * the form's checks, the `token.create` input, and where a new one goes.
 * The server checks a player's companion by the same reach and wall rules
 * (shared/permissions.ts), so the spot found here is one it takes.
 */

export type CompanionWhat = "creature" | "effect";

/**
 * A stat block chosen in the add form (docs/design-v1-companion-stat-blocks.md
 * 5.6): what it links, the block in the SRD monsters' shape, and a stored
 * block's picture, or an SRD monster's shipped icon, which a new companion
 * starts with.
 */
export type ChosenBlock = { link: BlockLink; view: StatBlockMonster; source: "srd" | "block"; picture?: ImageRef };

/** The form's fields a chosen block fills while the user has left them alone. */
export type FilledField = "name" | "size" | "hp" | "ac" | "image";

export type CompanionDraft = {
  name: string;
  what: CompanionWhat;
  turn: CompanionTurn;
  size: CreatureSize;
  /** A creature's HP, at least 1. An effect has none. */
  hp: number | null;
  /** A creature's AC, empty stored as 0. An effect has none. */
  ac: number | null;
  image: ImageRef | null;
  /** The user chose a turn, which a change of what it is then keeps where it can. */
  turnPicked: boolean;
  /** A creature's stat block, kept while "An effect" is chosen and sent only with a creature. */
  block: ChosenBlock | null;
  /** The fields the user changed, which a block chosen later leaves as they are. */
  edited: readonly FilledField[];
  /** The fields a chosen block filled, so a block chosen later can tell its picture from one the user chose. */
  filled: readonly FilledField[];
};

export const NEW_COMPANION: CompanionDraft = { name: "", what: "creature", turn: "shared", size: "small", hp: null, ac: null, image: null, turnPicked: false, block: null, edited: [], filled: [] };

/**
 * The toast for a creation answer that comes once its form is gone or out
 * of sight, where no form is left to show why: none when it was added,
 * since the token shows on the map.
 */
export function lateCompanionText(name: string, answer: OpAnswer, refusal?: Pick<OpRefusal, "message">): string | null {
  if (answer === "taken") return null;
  if (answer === "unknown") return `The connection dropped before the server answered, so ${name} may not have been added. Check the map.`;
  const why = refusal?.message.trim().replace(/\.$/, "");
  return why ? `${name} was not added. ${why[0]!.toUpperCase()}${why.slice(1)}.` : `${name} was not added.`;
}

/**
 * The draft with a stat block chosen (5.6), or none for Remove. A block
 * fills each field the user has left alone: the name while it is empty,
 * the size, HP with the block's average, AC, and the picture with a stored
 * block's picture, or an SRD monster's shipped icon, when none is chosen.
 * A name or picture an earlier block filled is not chosen, so the block
 * picked now replaces it with its own, or the picture with none when it
 * has none: a wolf's name and icon never stay on an owl. What it filled
 * stays when it is removed.
 */
export function withBlock(draft: CompanionDraft, chosen: ChosenBlock | null): CompanionDraft {
  if (!chosen) return { ...draft, block: null };
  const left = (field: FilledField) => !draft.edited.includes(field);
  const filled = new Set(draft.filled);
  const next: CompanionDraft = { ...draft, block: chosen };
  const fill = <F extends FilledField>(field: F, value: CompanionDraft[F]) => {
    next[field] = value;
    filled.add(field);
  };
  if (draft.name.trim() === "" || (left("name") && draft.filled.includes("name"))) fill("name", chosen.view.name);
  if (left("size")) fill("size", chosen.view.size);
  if (left("hp") && chosen.view.hp.average >= 1) fill("hp", chosen.view.hp.average);
  if (left("ac")) fill("ac", chosen.view.ac);
  if (left("image") && (draft.image === null || draft.filled.includes("image"))) {
    if (chosen.picture) fill("image", chosen.picture);
    else {
      next.image = null;
      filled.delete("image");
    }
  }
  next.filled = [...filled];
  return next;
}

/** HP's help while a block is chosen: "The block's average, 1 (1d4 − 1). Type another for a higher-level casting." */
export function blockHpHelp(view: StatBlockMonster): string {
  const formula = view.hp.formula.trim().replace(/ - /g, " − ");
  return `The block's average, ${view.hp.average}${formula ? ` (${formula})` : ""}. Type another for a higher-level casting.`;
}

/** The turn a companion starts at until the user picks one (3.6.2): a creature listed under its character, an effect not listed. */
export function defaultTurn(what: CompanionWhat): CompanionTurn {
  return what === "effect" ? "none" : "shared";
}

/**
 * The draft after a change in the form. Until the user picks a turn, it
 * follows what the companion is, so a Spiritual Weapon made without
 * touching Turn stays out of the order. A picked turn is kept, except that
 * an effect takes no turn of its own, which then goes to the effect's
 * default.
 */
export function draftWith(draft: CompanionDraft, patch: Partial<Omit<CompanionDraft, "turnPicked" | "edited" | "filled" | "block">>): CompanionDraft {
  const edited = new Set(draft.edited);
  for (const field of ["name", "size", "hp", "ac", "image"] as const) if (field in patch) edited.add(field);
  const next: CompanionDraft = { ...draft, ...patch, turnPicked: draft.turnPicked || patch.turn !== undefined, edited: [...edited] };
  if (patch.what !== undefined && patch.turn === undefined && !next.turnPicked) next.turn = defaultTurn(next.what);
  if (next.what === "effect" && next.turn === "own") next.turn = defaultTurn("effect");
  return next;
}

export type TurnChoice = { value: CompanionTurn; label: string; help: string };

/**
 * The three turns, named for the character (3.6.2), with the help the
 * Select shows under the chosen one. An effect takes no turn of its own,
 * so it is offered only the two on its character's turn.
 */
export function turnChoices(name: string, what: CompanionWhat): TurnChoice[] {
  const all: TurnChoice[] = [
    {
      value: "shared",
      label: `On ${name}'s turn, listed under ${name}`,
      help: `It acts on ${name}'s turn and shows under ${name} in the Initiative order, like a summoned spirit.`,
    },
    { value: "none", label: `On ${name}'s turn, not listed`, help: `It acts on ${name}'s turn and stays out of the Initiative order, like Spiritual Weapon.` },
    { value: "own", label: "Its own turn", help: "It rolls its own Initiative and joins the fight as a row of its own." },
  ];
  return what === "effect" ? all.filter((c) => c.value !== "own") : all;
}

/** What a companion is, by its kind: an object is an effect, any other kind a creature. */
export function companionWhat(kind: Token["kind"]): CompanionWhat {
  return kind === "object" ? "effect" : "creature";
}

/** The form's first problem, or null when it can be sent. */
export function draftError(draft: CompanionDraft): string | null {
  if (!draft.name.trim()) return "Give it a name.";
  if (draft.what === "creature" && (draft.hp === null || draft.hp < 1)) return "A creature needs at least 1 HP.";
  if (draft.what === "effect" && draft.turn === "own") return "An effect takes no turn of its own.";
  return null;
}

/**
 * The new companion's `token.create` input: a creature as an NPC with its
 * HP full, an effect as an object with 0 of 0 HP and AC 0, either an ally
 * on the creatures layer, plain and bare, owned by whoever plays the
 * character, standing at the character's elevation. A creature with a
 * stat block links it and takes its speeds, initiative bonus, Passive
 * Perception and senses (docs/design-v1-companion-stat-blocks.md 5.6). An
 * effect sends no block, though its draft keeps one.
 */
export function companionInput(
  draft: CompanionDraft,
  at: { id: string; sceneId: string; x: number; y: number; elevation: number },
  character: Pick<Character, "id" | "ownerIds">,
): TokenInput {
  const creature = draft.what === "creature";
  const hp = creature ? Math.max(1, Math.min(100_000, Math.floor(draft.hp ?? 1))) : 0;
  const chosen = creature ? draft.block : null;
  // The form's picker offers only an SRD block or one of the character's, never a room monster.
  const link = chosen ? ("blockId" in chosen.link ? { blockId: chosen.link.blockId } : "srdId" in chosen.link ? { srdId: chosen.link.srdId } : {}) : {};
  const fromBlock: Partial<Actor> = chosen
    ? { speeds: { ...chosen.view.speeds }, initBonus: chosen.view.initiative.bonus, passivePerception: chosen.view.passivePerception, senses: fitLine(chosen.view.senses), ...link }
    : {};
  const input: TokenInput = {
    id: at.id,
    sceneId: at.sceneId,
    kind: creature ? "npc" : "object",
    name: draft.name.trim(),
    size: draft.size,
    x: at.x,
    y: at.y,
    elevation: at.elevation,
    disposition: "ally",
    layer: "token",
    ownerIds: [...(character.ownerIds ?? [])],
    actor: { inline: blankActor({ hp: { cur: hp, max: hp, temp: 0 }, ac: creature ? Math.max(0, Math.min(100, Math.floor(draft.ac ?? 0))) : 0, ...fromBlock }) },
    companion: { of: character.id, turn: creature ? draft.turn : draft.turn === "own" ? "shared" : draft.turn },
  };
  if (draft.image) input.image = draft.image;
  return input;
}

/**
 * The row a new companion with its own turn takes in a running fight, so
 * that it "joins the fight as a row of its own", as its turn's help says.
 * It joins only a fight its character is in, with no value: its player
 * rolls or types it, as for any row of theirs. Null for a companion that
 * acts on its character's turn, with no fight, or while its character is
 * out of the fight, when it waits in Join the fight as any creature of
 * theirs does.
 */
export function joinFightOp(view: Pick<RoomState, "tokens" | "encounter">, input: Pick<TokenInput, "id" | "kind" | "companion">, entryId: string): ClientOp | null {
  const of = input.companion?.of;
  if (input.companion?.turn !== "own" || input.kind === "object" || of === undefined || !view.encounter) return null;
  if (!view.encounter.entries.some((entry) => rowCharacter(view, entry) === of)) return null;
  return { t: "encounter.add", entries: [{ id: entryId, tokenId: input.id }] };
}

type PlaceView = Pick<RoomState, "tokens" | "scenes" | "buildChunks" | "meta">;

/**
 * The first free spot beside a character's token whose footprint lies
 * within 5 ft of it, at its elevation, and on a scene where walls stop
 * moves, one the new token could step to from where the character stands.
 * Null when every spot is taken or walled off.
 */
export function companionSpot(view: PlaceView, beside: Token, draft: Pick<TokenInput, "size" | "w" | "h"> & Partial<TokenInput>): Point | null {
  const scene = view.scenes[beside.sceneId];
  if (!scene) return null;
  const fp = sizeFootprint(draft.size, draft.w !== undefined && draft.h !== undefined ? { w: draft.w, h: draft.h } : undefined);
  const near = footprint(beside);
  const probe = (p: Point): TokenInput => ({
    id: draft.id ?? "companion",
    sceneId: beside.sceneId,
    kind: draft.kind ?? "npc",
    name: draft.name ?? "Companion",
    size: draft.size,
    ...(draft.w !== undefined ? { w: draft.w } : {}),
    ...(draft.h !== undefined ? { h: draft.h } : {}),
    x: p.x,
    y: p.y,
    elevation: beside.elevation,
    actor: draft.actor ?? { inline: blankActor() },
  });
  const accept = (p: Point) => {
    const placed = probe(p);
    if (!withinCompanionReach(view.meta.settings, sceneGrid(scene), { ...placed, elevation: beside.elevation }, beside)) return false;
    return scene.blockMovement !== true || companionLegBlocker(view as RoomState, placed, beside) === null;
  };
  return firstFreeSpot({ grid: sceneGrid(scene), center: { x: beside.x + near.w / 2, y: beside.y + near.h / 2 }, footprint: fp, bounds: scene.bounds, occupied: occupiedBoxes(Object.values(view.tokens), beside.sceneId), accept });
}

/** The character's tokens on a scene, by id, the first the one a companion goes beside. */
export function characterTokensOn(view: Pick<RoomState, "tokens">, characterId: string, sceneId: string): Token[] {
  return Object.values(view.tokens)
    .filter((t): t is Token => !!t && t.sceneId === sceneId && "ref" in t.actor && t.actor.ref === characterId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export type Placement = { ok: true; sceneId: string; x: number; y: number; elevation: number } | { ok: false; reason: string };

/**
 * Where a player's new companion goes (3.6.3, settled by default D1): only
 * next to the character's token on the players' scene. Each way it cannot
 * is the reason the form shows under its disabled button.
 */
export function playerPlacement(view: PlaceView, character: Pick<Character, "id" | "name">, draft: Pick<TokenInput, "size" | "w" | "h">): Placement {
  const sceneId = view.meta.playerSceneId;
  if (sceneId === null || view.meta.view.blackout || !view.scenes[sceneId]) return { ok: false, reason: "No map to place it on yet." };
  const own = characterTokensOn(view, character.id, sceneId);
  if (own.length === 0) return { ok: false, reason: `${character.name} has no token on the map.` };
  for (const beside of own) {
    const spot = companionSpot(view, beside, draft);
    if (spot) return { ok: true, sceneId, x: spot.x, y: spot.y, elevation: beside.elevation };
  }
  return { ok: false, reason: `No room next to ${character.name}.` };
}

/**
 * Where the DM's new companion goes: on the scene the DM views, beside the
 * character's token when it stands there, else around the middle of the
 * DM's view. The DM's placement has no reach rule.
 */
export function dmPlacement(view: PlaceView, character: Pick<Character, "id">, draft: Pick<TokenInput, "size" | "w" | "h">, at: { sceneId: string | null; center: Point }): Placement {
  const scene = at.sceneId !== null ? view.scenes[at.sceneId] : undefined;
  if (!scene) return { ok: false, reason: "No map to place it on yet." };
  const beside = characterTokensOn(view, character.id, scene.id)[0];
  const fp = sizeFootprint(draft.size, draft.w !== undefined && draft.h !== undefined ? { w: draft.w, h: draft.h } : undefined);
  const center = beside ? { x: beside.x + footprint(beside).w / 2, y: beside.y + footprint(beside).h / 2 } : at.center;
  const [spot] = spreadPositions({ grid: sceneGrid(scene), center, footprint: fp, count: 1, bounds: scene.bounds, occupied: occupiedBoxes(Object.values(view.tokens), scene.id) });
  if (!spot) return { ok: false, reason: "No map to place it on yet." };
  return { ok: true, sceneId: scene.id, x: spot.x, y: spot.y, elevation: beside?.elevation ?? 0 };
}

/** The companions of a character this device holds, by name: the tokens on the scene in view. */
export function companionsOf(view: Pick<RoomState, "tokens">, characterId: string): Token[] {
  return Object.values(view.tokens)
    .filter((t): t is Token => !!t && t.companion?.of === characterId)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/** The short line under a companion's name on its character's page. */
export function turnLabel(name: string, turn: CompanionTurn): string {
  return turn === "own" ? "Its own turn" : turn === "shared" ? `On ${name}'s turn, listed` : `On ${name}'s turn, not listed`;
}

/**
 * The patch that makes a token a companion (3.6.9): the link, and the ally
 * ring when it was hostile, in one update.
 */
export function makeCompanionPatch(token: Pick<Token, "disposition">, of: string, turn: CompanionTurn): { companion: { of: string; turn: CompanionTurn }; disposition?: "ally" } {
  return token.disposition === "hostile" ? { companion: { of, turn }, disposition: "ally" } : { companion: { of, turn } };
}

/**
 * A change of a companion's character or turn, as the Companion section
 * sends it: the link alone, `{ of, turn }`, never the stored object, so a
 * spent Reaction is never sent and never fails the strict schema (4.2).
 */
export function linkPatch(companion: Pick<NonNullable<Token["companion"]>, "of" | "turn">, change: { of?: string; turn?: CompanionTurn }): { companion: { of: string; turn: CompanionTurn } } {
  return { companion: { of: change.of ?? companion.of, turn: change.turn ?? companion.turn } };
}

