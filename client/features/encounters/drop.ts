import { lairCounts } from "#shared/dice/uses.ts";
import type { Actor, ImageRef, RoomState, SavedEncounterMonster, Scene } from "#shared/model.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import { MAX_ENTRIES_PER_OP, type ClientOp, type EntryInput, type TokenInput } from "#shared/protocol.ts";
import { monsterImage, refOf } from "../monsters/images.ts";
import { placeOnGround } from "../movement/ground.ts";
import { monsterToken, occupiedBoxes, sizeFootprint, spreadPositions, type Point } from "../tokens/factory.ts";
import type { Resolved } from "./draft.ts";

/**
 * Placing a saved encounter on the scene the DM views (features section
 * 10): every creature as its own token, exactly as the monster browser
 * places them by hand, so each wears its monster's default image, the
 * reducer numbers duplicates ("Goblin Warrior 3"), and the tracker groups
 * them by the same keys. Kept free of React, so the plan runs under plain
 * Node tests.
 */

export type DropOptions = {
  /** Placed hidden from players, to reveal later, as the monster browser's toggle does. */
  hidden: boolean;
  /** Also add them to the fight, when one is running. */
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
  state: Pick<RoomState, "tokens" | "monsters" | "srdImages" | "encounter"> & Partial<Pick<RoomState, "buildChunks">>;
  scene: Pick<Scene, "id" | "bounds">;
  center: Point;
  options: DropOptions;
  newId(): string;
}): DropPlan {
  const occupied = occupiedBoxes(Object.values(input.state.tokens), input.scene.id);
  const tokens: TokenInput[] = [];
  const blocks = new Map<string, StatBlockMonster>();
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
    const spots = spreadPositions({ center: input.center, footprint: fp, count: line.count, bounds: input.scene.bounds, occupied });
    const monsterId = "monsterId" in line ? line.monsterId : undefined;
    const ref = refOf(m, monsterId);
    const image: ImageRef | undefined = ref ? monsterImage(input.state, ref) : undefined;
    const link = monsterId !== undefined ? { monsterId } : {};
    for (const at of spots) {
      occupied.push({ x: at.x, y: at.y, w: fp.w, h: fp.h });
      const drop = { hp: null, hidden: input.options.hidden, inLair: line.inLair === true };
      const token = monsterToken(m, drop, { id: input.newId(), sceneId: input.scene.id, at, ...(image ? { image } : {}), ...link });
      tokens.push(placeOnGround(input.state.buildChunks ?? {}, token));
      blocks.set(token.id, m);
    }
  }
  const ops: ClientOp[] = tokens.map((token) => ({ t: "token.create", token }));
  if (input.options.addToFight && input.state.encounter && tokens.length > 0) {
    // The reducer fills each row's group, hidden flag and score, as it does for tokens added from the tracker.
    const entries: EntryInput[] = tokens.map((t) => joinEntry({ id: input.newId(), tokenId: t.id }, "inline" in t.actor ? t.actor.inline : undefined, blocks.get(t.id) ?? null));
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

/**
 * A creature's row as it joins a fight: In lair on where it stands placed
 * in its lair (`placedInLair`), so the switch says what its counts say
 * (docs/design-v1-combat-controls.md 13.4). Every path into a fight builds
 * its rows with this: a saved encounter's drop, whose lair line placed it
 * with its lair's counts, and the tracker's and the group bar's Start and
 * Add (combat/state.ts useFightJoin).
 */
export function joinEntry(entry: EntryInput, actor: Pick<Actor, "legendary" | "xp"> | undefined, block: StatBlockMonster | null): EntryInput {
  return actor && placedInLair(actor, block) ? { ...entry, inLair: true } : entry;
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
