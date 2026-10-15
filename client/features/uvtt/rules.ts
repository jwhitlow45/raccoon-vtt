import type { RoomState, Scene } from "#shared/model.ts";
import type { OpAnswer, RoomView } from "../../state/types.ts";
import type { RoomViewStore } from "../../state/view.ts";
import { NOT_SAME_SHAPE, phaseProblem, referenceGrid } from "../phases/rules.ts";
import type { ImportPlan } from "./convert.ts";

/**
 * The import dialog's decisions (ImportDialog.tsx), apart from React so
 * they run under node's test runner.
 */

/**
 * Why the file's image cannot be a phase of the scene, checked before it
 * is uploaded for nothing. The reducer checks a phase at its canonical size
 * (phases/rules.ts). An image that uploads as it is, at most 8,192 px on
 * its long side, keeps its own size on the server, so the reducer's exact
 * rule runs here on the file's own size. Only an image the worker will
 * draw down gets a looser test, a 1 percent difference in shape, since its
 * canonical size is not known until the upload answers.
 */
export function earlyShapeProblem(scene: Scene, image: { width: number; height: number; resize: boolean }): string | null {
  const grid = referenceGrid(scene);
  if (!grid) return "Add a map image first.";
  if (!image.resize) return phaseProblem(grid, { widthPx: image.width, heightPx: image.height });
  const expected = (image.width * grid.refHeightPx) / grid.refWidthPx;
  return Math.abs(expected - image.height) / image.height > 0.01 ? NOT_SAME_SHAPE : null;
}

/**
 * What the Scenes panel shows of the import. The file picker goes away
 * once the room holds as many scenes as it may. An open dialog stays: the
 * import that makes the room's last scene reaches the limit as soon as its
 * scene is made, while its walls are still being sent, and closing the
 * dialog then would look like the import had stopped.
 */
export function entryShown(full: boolean, importing: boolean): { picker: boolean; dialog: boolean } {
  return { picker: !full, dialog: importing };
}

/** How the server answered the import's ops (OpAnswer in state/types.ts), counted. */
export type Answers = Readonly<Record<OpAnswer, number>>;

export const NO_ANSWERS: Answers = { taken: 0, refused: 0, unknown: 0 };

export function addAnswer(answers: Answers, answer: OpAnswer): Answers {
  return { ...answers, [answer]: answers[answer] + 1 };
}

/** What the import writes into its scene: edge walls, doors and windows, free ones, and lights. */
export type Contents = { edges: number; walls: number; lights: number };

export function sentContents(plan: Pick<ImportPlan, "edges" | "walls" | "lights">): Contents {
  return { edges: plan.edges.length, walls: plan.walls.length, lights: plan.lights.length };
}

/** The same counts in a view that holds the scene's contents, which a DM's view does only for the scene it shows. */
export function storedContents(state: Pick<RoomState, "buildChunks" | "lights">, sceneId: string): Contents {
  const contents: Contents = { edges: 0, walls: 0, lights: 0 };
  for (const chunk of Object.values(state.buildChunks)) {
    if (chunk.sceneId !== sceneId) continue;
    contents.edges += Object.keys(chunk.edges).length;
    contents.walls += chunk.walls?.length ?? 0;
  }
  for (const light of Object.values(state.lights)) if (light.sceneId === sceneId) contents.lights++;
  return contents;
}

export type ImportOutcome =
  /** Every op taken, or, `checked`, answers lost and the scene found holding everything sent. */
  | { k: "complete"; checked: boolean }
  /** No scene: the server refused it, or it is not there after its answer was `lost`. */
  | { k: "none"; lost: boolean }
  /** The server refused some of it. */
  | { k: "partial" }
  /** Answers were lost, and the scene was not found holding everything sent. */
  | { k: "unconfirmed" };

/**
 * Whether the scene's contents must be counted to tell how the import
 * ended: some answers were lost, which a reconnect does even to an op the
 * server refused, none was a refusal, and the scene is there.
 */
export function mustCount(answers: Answers, exists: boolean): boolean {
  return exists && answers.refused === 0 && answers.unknown > 0;
}

/** `contents` is null when they could not be counted. */
export function importOutcome(answers: Answers, room: { exists: boolean; contents: Contents | null }, sent: Contents): ImportOutcome {
  if (answers.refused === 0 && answers.unknown === 0) return { k: "complete", checked: false };
  if (!room.exists) return { k: "none", lost: answers.unknown > 0 };
  if (answers.refused > 0) return { k: "partial" };
  const c = room.contents;
  const whole = c !== null && c.edges === sent.edges && c.walls === sent.walls && c.lights === sent.lights;
  return whole ? { k: "complete", checked: true } : { k: "unconfirmed" };
}

export const PARTIAL_IMPORT = "The server refused part of the import, so the scene may be missing walls. Undo takes the whole import back.";

/** The outcome in one sentence. `opened` says whether the new scene is on screen, or the DM must go to it. */
export function outcomeText(outcome: ImportOutcome, name: string, opened: boolean): { text: string; tone: "info" | "error" } {
  const goTo = opened ? "" : " Open it from the Scenes panel.";
  switch (outcome.k) {
    case "complete":
      return outcome.checked
        ? { text: `The connection dropped during the import, but ${name} is complete: every wall, door and light is in. Undo takes the whole import back.`, tone: "info" }
        : { text: `${name} is imported, with every wall, door and light.${goTo}`, tone: "info" };
    case "none":
      return { text: outcome.lost ? "The connection dropped during the import, and no scene was made. Try again." : "The server refused the import, so no scene was made.", tone: "error" };
    case "partial":
      return { text: PARTIAL_IMPORT, tone: "error" };
    case "unconfirmed":
      return {
        text: `The connection dropped during the import, and ${name} could not be confirmed complete. It may be missing walls, doors or lights.${goTo} Undo takes the whole import back.`,
        tone: "error",
      };
  }
}

/**
 * Whether the DM went to another scene while the hidden import ran: the
 * scene shown, or asked for, is neither the one shown when the walls began
 * nor the new one.
 */
export function movedOn(start: string | null, now: Pick<RoomView, "sceneId" | "sceneLoad">, sceneId: string): boolean {
  const showing = now.sceneLoad?.requested ?? now.sceneId;
  return showing !== start && showing !== sceneId;
}

/** How long the dialog waits for the new scene's contents before it says it could not confirm them. */
export const CHECK_MS = 30_000;

/**
 * Resolves true once the view shows the scene, and so holds its contents,
 * or false when the DM asks for another first, the room ends, or `ms`
 * pass. A snapshot that times out is asked for again (state/socket.ts), so
 * a load that stops for a moment is waited out.
 */
export function sceneShown(store: Pick<RoomViewStore, "getState" | "subscribe">, sceneId: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (shown: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(shown);
    };
    const check = (s: RoomView) => {
      if (s.sceneId === sceneId) finish(true);
      else if (s.ended || (s.sceneLoad?.requested ?? sceneId) !== sceneId) finish(false);
    };
    const timer = setTimeout(() => finish(false), ms);
    const unsubscribe = store.subscribe(check);
    check(store.getState());
  });
}
