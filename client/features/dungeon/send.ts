import type { BuildChunk, JournalPage, Light, Pin, RoomState, Stamp, Token, Trap, TrapRig } from "#shared/model.ts";
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

type Of<T> = Readonly<Record<string, T | undefined>>;
type Contents = Pick<RoomState, "buildChunks"> & {
  traps: Of<Pick<Trap, "sceneId" | "zone" | "state" | "rig">>;
  stamps?: Of<Pick<Stamp, "sceneId" | "art" | "x" | "y" | "w" | "h" | "rotation">>;
  lights?: Of<Pick<Light, "sceneId" | "x" | "y" | "bright" | "dim">>;
  tokens?: Of<Pick<Token, "id" | "sceneId" | "kind" | "name" | "x" | "y" | "visibility">>;
  pins?: Of<Pick<Pin, "sceneId" | "x" | "y" | "label" | "pageId" | "visibility">>;
  journal?: Of<Pick<JournalPage, "title" | "folder" | "access" | "blocks">>;
};

/**
 * How the contents name an id that something else names: a stored room's
 * as it holds it, and the scratch room's placeholders as Make made them
 * fresh (ops.ts `withIds`). One the map does not hold names nothing Make
 * made, so it never matches a stored id.
 */
export type IdOf = (id: string) => string;
const AS_STORED: IdOf = (id) => id;

/** The ids Make gave the scratch room's placeholders, as the contents read them. */
export function madeIds(ids: ReadonlyMap<string, string> | undefined): IdOf {
  return (id) => ids?.get(id) ?? `not made: ${id}`;
}

function sorted(items: Iterable<unknown>): string[] {
  return [...items].map((x) => stableStringify(x)).sort();
}

/**
 * A scene as the outcome compares it: each chunk's cells, edges, heights
 * and stairs by its place, its traps by zone, state and rig, its stamps by
 * art, place, size and turn, its lights by place and radii, its tokens by
 * kind, name, place and visibility, its pins by place, label and
 * visibility, and the journal pages its pins link by title, folder, access
 * and block texts. Revs, walls versions, ids and order are left out, since
 * each grows from its prior value or is fresh at Make. A reference is
 * compared by what it names, through `idOf` (phase 2, section 6): a trap's
 * show action by its token's id, which the token's own entry carries, and
 * a pin's page by its id. So a wrong target never matches, and an older
 * key page of the same title, which Delete leaves, is never taken for the
 * one this send made.
 */
export function sceneContents(state: Contents, sceneId: string, idOf: IdOf = AS_STORED): string {
  const chunks: [string, Pick<BuildChunk, "cells" | "edges" | "heights" | "up">][] = [];
  for (const c of Object.values(state.buildChunks)) {
    if (c.sceneId === sceneId) chunks.push([`${c.cx},${c.cy}`, { cells: c.cells, edges: c.edges, heights: c.heights, up: c.up }]);
  }
  chunks.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const on = <T extends { sceneId: string }>(r: Of<T> | undefined): T[] => Object.values(r ?? {}).filter((x): x is T => x?.sceneId === sceneId);
  const named = (rig: TrapRig | undefined): TrapRig | undefined =>
    rig && { ...rig, actions: rig.actions.map((a) => ("show" in a && "tokenId" in a.show ? { show: { tokenId: idOf(a.show.tokenId) } } : a)) };
  const traps = sorted(on(state.traps).map((t) => ({ zone: t.zone, state: t.state, rig: named(t.rig) })));
  const stamps = sorted(on(state.stamps).map((s) => ({ art: s.art, x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation })));
  const lights = sorted(on(state.lights).map((l) => ({ x: l.x, y: l.y, bright: l.bright, dim: l.dim })));
  const tokens = sorted(on(state.tokens).map((t) => ({ id: idOf(t.id), kind: t.kind, name: t.name, x: t.x, y: t.y, visibility: t.visibility })));
  const pins = on(state.pins);
  const pages = sorted(
    [...new Set(pins.flatMap((p) => (p.pageId !== undefined ? [p.pageId] : [])))].map((id) => {
      const page = state.journal?.[id];
      return { id: idOf(id), page: page ? { title: page.title, folder: page.folder, access: page.access, blocks: page.blocks.map((b) => b.text) } : null };
    }),
  );
  const pinned = sorted(pins.map((p) => ({ x: p.x, y: p.y, label: p.label, visibility: p.visibility, page: p.pageId === undefined ? null : idOf(p.pageId) })));
  return stableStringify({ chunks, traps, stamps, lights, tokens, pins: pinned, pages });
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
 * when answers were lost, unless a hidden dialog's DM moved on. `ids` is
 * `withIds`' map, which the comparison follows references through:
 * without it a dungeon whose stones or pins name another of its ids is
 * never confirmed after a lost answer.
 */
export async function sendDungeon(
  made: { ops: ClientOp[]; sceneId: string; room: RoomState; ids?: ReadonlyMap<string, string> },
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
      same = view !== null && sceneContents(view, sceneId) === sceneContents(made.room, scratchScene, madeIds(made.ids));
    }
  }
  const outcome = dungeonOutcome(answers, created, { exists: exists(), same });
  if (outcome.k === "complete" && !outcome.checked && mayOpen()) actions.switchScene(sceneId);
  return outcome;
}
