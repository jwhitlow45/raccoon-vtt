import { lairCounts } from "#shared/dice/uses.ts";
import type { Actor, ImageRef, RoomState, SavedEncounterMonster, Scene } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import { MAX_ENTRIES_PER_OP, type ClientOp, type EntryInput, type TokenInput } from "#shared/protocol.ts";
import { monsterImage, refOf } from "../monsters/images.ts";
import { placeOnGround } from "../movement/ground.ts";
import { blockHasLair, monsterToken, occupiedBoxes, sizeFootprint, spreadPositions, type Point } from "../tokens/factory.ts";
import type { Resolved } from "./draft.ts";

/**
 * Placing a saved encounter on the scene the DM views (features section
 * 10): every creature as its own token, exactly as the monster browser
 * places them by hand, so each wears its monster's default image, the
 * duplicates take their numbers ("Goblin Warrior 3") when the party first
 * sees them, and the tracker groups them by the same keys. Kept free of
 * React, so the plan runs under plain Node tests.
 */

export type DropOptions = {
  /** Placed hidden from players, to reveal later, as the monster browser's toggle does. */
  hidden: boolean;
  /** Also add them to the fight, when one is running or its start is on its way. */
  addToFight: boolean;
};

export type DropPlan = {
  /** The ops, in order: the tokens, then the tracker rows that name them. */
  ops: ClientOp[];
  /** Creatures left out because their stat block is not at hand (a room monster deleted since). */
  skipped: number;
};

export function dropPlan(input: {
  monsters: readonly SavedEncounterMonster[];
  resolve(m: SavedEncounterMonster): Resolved;
  /** `encounter` is the fight with a start still waiting for its answer counted in (state/store.ts fightAhead). */
  state: Pick<RoomState, "tokens" | "monsters" | "srdImages"> & Partial<Pick<RoomState, "buildChunks">> & { encounter: object | null };
  scene: Pick<Scene, "id" | "bounds" | "gridShape">;
  center: Point;
  options: DropOptions;
  newId(): string;
}): DropPlan {
  const occupied = occupiedBoxes(Object.values(input.state.tokens), input.scene.id);
  const tokens: TokenInput[] = [];
  // Each token's block, for its row in the fight. Its line's In lair choice rides on the token (Actor.inLair).
  const joins = new Map<string, StatBlockMonster>();
  let skipped = 0;
  // The biggest creatures take the spots nearest the middle first, so a dragon is not pushed to the edge by its kobolds.
  const lines = input.monsters
    .map((line, order) => ({ line, order, resolved: input.resolve(line) }))
    .sort((a, b) => side(b.resolved) - side(a.resolved) || a.order - b.order);
  for (const { line, resolved } of lines) {
    if (!resolved) {
      skipped += line.count;
      continue;
    }
    const m = resolved.view;
    const fp = sizeFootprint(m.size);
    const spots = spreadPositions({ grid: sceneGrid(input.scene), center: input.center, footprint: fp, count: line.count, bounds: input.scene.bounds, occupied });
    const monsterId = "monsterId" in line ? line.monsterId : undefined;
    const ref = refOf(m, monsterId);
    const image: ImageRef | undefined = ref ? monsterImage(input.state, ref) : undefined;
    const link = monsterId !== undefined ? { monsterId } : {};
    for (const at of spots) {
      occupied.push({ x: at.x, y: at.y, w: fp.w, h: fp.h });
      const drop = { hp: null, hidden: input.options.hidden, inLair: line.inLair === true };
      const token = monsterToken(m, drop, { id: input.newId(), sceneId: input.scene.id, at, ...(image ? { image } : {}), ...link });
      tokens.push(placeOnGround(input.state.buildChunks ?? {}, token));
      joins.set(token.id, m);
    }
  }
  const ops: ClientOp[] = tokens.map((token) => ({ t: "token.create", token }));
  if (input.options.addToFight && input.state.encounter && tokens.length > 0) {
    // The reducer fills each row's group, hidden flag and score, as it does for tokens added from the tracker.
    const entries: EntryInput[] = tokens.map((t) => joinEntry({ id: input.newId(), tokenId: t.id }, "inline" in t.actor ? t.actor.inline : undefined, joins.get(t.id) ?? null));
    for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_OP) ops.push({ t: "encounter.add", entries: entries.slice(i, i + MAX_ENTRIES_PER_OP) });
  }
  return { ops, skipped };
}

/**
 * Whether a creature stands placed in its lair (13.4): its legendary counts
 * are its block's lair counts and not its base ones, or, where the counts
 * do not tell them apart, its XP is the lair's. A block whose counts never
 * change in a lair says no.
 */
export function placedInLair(actor: Pick<Actor, "legendary" | "xp">, block: StatBlockMonster | null): boolean {
  if (!block) return false;
  const lair = lairCounts(block, true);
  const base = lairCounts(block, false);
  const held = { actionsMax: actor.legendary?.actionsMax ?? 0, resistMax: actor.legendary?.resistMax ?? 0 };
  const same = (c: { actionsMax: number; resistMax: number }) => c.actionsMax === held.actionsMax && c.resistMax === held.resistMax;
  if (!same(lair)) return false;
  if (!same(base)) return true;
  return lair.xp !== base.xp && actor.xp === lair.xp;
}

/** Whether a block's lair changes its legendary counts or XP, so a creature's own can say whether it stands there. */
function countsTell(block: StatBlockMonster): boolean {
  const lair = lairCounts(block, true);
  const base = lairCounts(block, false);
  return lair.actionsMax !== base.actionsMax || lair.resistMax !== base.resistMax || lair.xp !== base.xp;
}

/**
 * A creature's row as it joins a fight: In lair on where it stands placed
 * in its lair (docs/design/design-v1-combat-controls.md 13.4). Every path into a
 * fight builds its rows with this: a saved encounter's drop, and the
 * tracker's and the group bar's Start and Add (combat/state.ts
 * useFightJoin). Where its block's lair changes its counts or XP, those
 * decide (`placedInLair`), so counts the DM set back by hand join out of
 * the lair, and a token placed before the tick was kept still joins in it.
 * Elsewhere the token's own tick (`Actor.inLair`) decides: for lair
 * actions alone, a block whose lair changes neither (review CCB-ASTRA-07)
 * or an SRD block not read, but never for a block read with no lair, such as a
 * room monster edited since to lose it (review FU46-C1, FU46-C2).
 */
export function joinEntry(entry: EntryInput, actor: Pick<Actor, "legendary" | "xp" | "inLair" | "srdId"> | undefined, block: StatBlockMonster | null): EntryInput {
  if (actor === undefined) return entry;
  // A null block is still loading only for an SRD link. A room monster or companion block is at hand or deleted, and a deleted one left the link (FU46 round 2).
  const unread = block === null && actor.srdId !== undefined;
  const placed = block !== null && countsTell(block) ? placedInLair(actor, block) : actor.inLair === true && (block === null ? unread : blockHasLair(block));
  return placed ? { ...entry, inLair: true } : entry;
}

function side(resolved: Resolved): number {
  if (!resolved) return 0;
  const fp = sizeFootprint(resolved.view.size);
  return Math.max(fp.w, fp.h);
}

/**
 * Sends a plan as one undo step: every op under one fresh group (design
 * 7.7), so one undo takes the whole encounter back off the map, and its
 * rows out of the fight with it. Returns the token to select, or null when
 * nothing was sent.
 */
export function sendDrop(plan: DropPlan, actions: { dispatch(op: ClientOp, opts?: { group?: string }): number | null; newId(): string }): string | null {
  if (plan.ops.length === 0) return null;
  const group = actions.newId();
  let last: string | null = null;
  for (const op of plan.ops) {
    if (actions.dispatch(op, { group }) !== null && op.t === "token.create") last = op.token.id;
  }
  return last;
}
