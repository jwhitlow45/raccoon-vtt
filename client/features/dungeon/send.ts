import type { BuildChunk, RoomState, Trap } from "#shared/model.ts";
import { stableStringify } from "#shared/project.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { OpAnswer, RoomActions } from "../../state/types.ts";
import type { RoomViewStore } from "../../state/view.ts";
import { addAnswer, CHECK_MS, movedOn, NO_ANSWERS, sceneShown, type Answers } from "../uvtt/rules.ts";

/*
 * Make the scene (docs/design/design-v1-dungeon-generator.md 4.4 and 5.5):
 * every op in one task and one Setup group, and the outcome the import's
 * mirrors (uvtt/rules.ts `importOutcome`, D-261102-388). A lost answer can
 * hide a refusal, so when answers are lost the scene the server stored is
 * compared with the scratch room the preview was drawn from.
 */

export type DungeonOutcome = { k: "complete"; checked: boolean } | { k: "none"; lost: boolean } | { k: "partial" } | { k: "unconfirmed" };

/**
 * The room the send reads beside its actions: the view, which holds the new
 * scene's contents only once it shows that scene, and whether the dialog is
 * on screen. A hidden dialog whose DM went to another scene has moved on,
 * so the new scene does not pull them away.
 */
export type SendRoom = { store: Pick<RoomViewStore, "getState" | "subscribe">; shown: () => boolean; checkMs?: number };

type Contents = Pick<RoomState, "buildChunks"> & { traps: Readonly<Record<string, Pick<Trap, "sceneId" | "zone" | "state" | "rig"> | undefined>> };

/**
 * A scene's build as the outcome compares it: each chunk's cells, edges,
 * heights and stairs by its place, and its traps by zone, state and rig.
 * Revs, walls versions, ids and order are left out, since each grows from
 * its prior value or is fresh at Make.
 */
export function sceneContents(state: Contents, sceneId: string): string {
  const chunks: [string, Pick<BuildChunk, "cells" | "edges" | "heights" | "up">][] = [];
  for (const c of Object.values(state.buildChunks)) {
    if (c.sceneId === sceneId) chunks.push([`${c.cx},${c.cy}`, { cells: c.cells, edges: c.edges, heights: c.heights, up: c.up }]);
  }
  chunks.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const traps: string[] = [];
  for (const t of Object.values(state.traps)) if (t?.sceneId === sceneId) traps.push(stableStringify({ zone: t.zone, state: t.state, rig: t.rig }));
  return stableStringify({ chunks, traps: traps.sort() });
}

/** How it ended, from the answers and the room after: the import's rule, with the contents compared whole. */
export function dungeonOutcome(answers: Answers, created: OpAnswer, room: { exists: boolean; same: boolean | null }): DungeonOutcome {
  if (answers.refused === 0 && answers.unknown === 0) return { k: "complete", checked: false };
  if (created === "refused" || !room.exists) return { k: "none", lost: created !== "refused" && answers.unknown > 0 };
  if (answers.refused > 0) return { k: "partial" };
  return room.same === true ? { k: "complete", checked: true } : { k: "unconfirmed" };
}

/**
 * Sends the dungeon and says how it ended. Every op is dispatched in this
 * one task, in one group under Setup, so no other op of this device falls
 * inside the group and a DM who switches apps mid-send leaves nothing half
 * queued, and all but the scene in one dispatch where the store offers it.
 * An op the store refuses at input (null, as while a builder gesture waits
 * on its ask) counts as refused, and when the scene itself is refused so,
 * nothing after it is sent. `onAnswered` hears each
 * answer as it comes. The scene opens once complete, or to be compared
 * when answers were lost, unless a hidden dialog's DM moved on.
 */
export async function sendDungeon(
  made: { ops: ClientOp[]; sceneId: string; room: RoomState },
  actions: RoomActions,
  onAnswered: (n: number, of: number) => void,
  room: SendRoom,
): Promise<DungeonOutcome> {
  const { store } = room;
  const total = made.ops.length;
  const startScene = store.getState().sceneId;
  const group = actions.newId();
  let answers = NO_ANSWERS;
  // Set by the scene's own answer, inside the callbacks, so it is typed wide rather than narrowed to its start.
  let created = "unknown" as OpAnswer;
  await new Promise<void>((resolve) => {
    let answered = 0;
    const settle = (i: number) => {
      let once = false;
      return (answer: OpAnswer) => {
        if (once) return;
        once = true;
        if (i === 0) created = answer;
        answers = addAnswer(answers, answer);
        answered++;
        onAnswered(answered, total);
        if (answered === total) resolve();
      };
    };
    const answer = made.ops.map((_, i) => settle(i));
    const opts = (i: number) => ({ group, groupScope: "setup" as const, onAnswer: answer[i]! });
    const [create, ...rest] = made.ops;
    if (create === undefined) return resolve();
    // The scene alone first: refused at input, nothing after it is sent.
    if (actions.dispatch(create, opts(0)) === null) {
      for (const a of answer) a("refused");
      return;
    }
    // The rest in one view rebuild where the store offers it, since one rebuild per op costs the square of the count (D-261107-263).
    const ns = actions.dispatchMany ? actions.dispatchMany(rest.map((op, k) => ({ op, opts: opts(k + 1) }))) : rest.map((op, k) => actions.dispatch(op, opts(k + 1)));
    for (const [k, n] of ns.entries()) if (n === null) answer[k + 1]!("refused");
  });

  const sceneId = made.sceneId;
  const exists = () => store.getState().view?.scenes[sceneId] !== undefined;
  const mayOpen = () => room.shown() || !movedOn(startScene, store.getState(), sceneId);
  let same: boolean | null = null;
  if (created !== "refused" && answers.refused === 0 && answers.unknown > 0 && exists() && mayOpen()) {
    actions.switchScene(sceneId);
    if (await sceneShown(store, sceneId, room.checkMs ?? CHECK_MS)) {
      const view = store.getState().view;
      const scratchScene = Object.keys(made.room.scenes)[0] ?? "";
      same = view !== null && sceneContents(view, sceneId) === sceneContents(made.room, scratchScene);
    }
  }
  const outcome = dungeonOutcome(answers, created, { exists: exists(), same });
  if (outcome.k === "complete" && !outcome.checked && mayOpen()) actions.switchScene(sceneId);
  return outcome;
}
