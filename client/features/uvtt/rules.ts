import type { RoomState, Scene } from "#shared/model.ts";
import { sameScene } from "#shared/rules/floors.ts";
import type { OpAnswer, RoomView } from "../../state/types.ts";
import type { RoomViewStore } from "../../state/view.ts";
import { NOT_SAME_SHAPE, phaseProblem, referenceGrid } from "../phases/rules.ts";
import { nameFromFile } from "../scenes/create.ts";
import { floorNameOf, type FloorSight } from "../scenes/floorSource.ts";
import { openFloorLine } from "../scenes/floorWords.ts";
import type { ImportPlan } from "./convert.ts";

/**
 * The import dialog's decisions (ImportDialog.tsx), apart from React so
 * they run under node's test runner.
 */

/**
 * What the import makes: a new scene, a phase of a scene (the image
 * alone), or a floor just above or below the floor `beside`
 * (docs/design/design-v1-floors.md phase 3, 3.6).
 */
export type ImportTarget = { kind: "scene" } | { kind: "phase"; sceneId: string } | { kind: "floor"; beside: string; side: "above" | "below" };

/** What the worker is asked to read the file for. A floor takes the file's walls, as a new scene does, so the worker converts them, and the options convert them again. */
export function workerKind(target: ImportTarget): "scene" | "phase" {
  return target.kind === "phase" ? "phase" : "scene";
}

/** "crypt_level-2.dd2vtt" becomes "crypt level 2". The format's extensions are longer than nameFromFile strips. */
export function fileSceneName(fileName: string): string {
  return nameFromFile(fileName.replace(/\.(dd2vtt|uvtt|df2vtt)$/i, ""));
}

/** The name field's start: the file's name, cut for a floor to the floor name's 40 code points and trimmed. */
export function importName(fileName: string, target: ImportTarget): string {
  const name = fileSceneName(fileName);
  return target.kind === "floor" ? floorNameOf(name) : name;
}

/**
 * How a floor's fog and vision are sent (scenes/floorSource.ts): Like with
 * its light untouched sends none, so the floor copies the floor beside as
 * the add applies, and every other pick is sent whole (3.6, D-261110-110).
 * `lightTouched` is a light picked in the row, or the lead's tap, since
 * Like was picked.
 */
export function importSight(seen: string, lightTouched: boolean): FloorSight {
  return seen === "like" && !lightTouched ? "like" : "own";
}

/** The name the reducer gives a floor added with none (shared/reducer/floors.ts), which the words read until the floor shows. */
export const NEW_FLOOR = "New floor";

/** Under Players see on a floor beside a per-player floor: a preset patches the floor beside's sight and keeps Per player. */
export function perPlayerNote(besideName: string): string {
  return `Each player still sees for themselves, as on ${besideName}.`;
}

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

export const PARTIAL_IMPORT = "The server refused part of the import, so the scene may be missing walls. Undo setup in Setup history takes the whole import back.";

/** The outcome in one sentence. `opened` says whether the new scene is on screen, or the DM must go to it. */
export function outcomeText(outcome: ImportOutcome, name: string, opened: boolean): { text: string; tone: "info" | "error" } {
  const goTo = opened ? "" : " Open it from the Scenes panel.";
  switch (outcome.k) {
    case "complete":
      return outcome.checked
        ? { text: `The connection dropped during the import, but ${name} is complete: every wall, door and light is in. Undo setup in Setup history takes the whole import back.`, tone: "info" }
        : { text: `${name} is imported, with every wall, door and light.${goTo}`, tone: "info" };
    case "none":
      return { text: outcome.lost ? "The connection dropped during the import, and no scene was made. Try again." : "The server refused the import, so no scene was made.", tone: "error" };
    case "partial":
      return { text: PARTIAL_IMPORT, tone: "error" };
    case "unconfirmed":
      return {
        text: `The connection dropped during the import, and ${name} could not be confirmed complete. It may be missing walls, doors or lights.${goTo} Undo setup in Setup history takes the whole import back.`,
        tone: "error",
      };
  }
}

/**
 * How a floor's import ended, in one sentence, naming the floor by `name`,
 * the name the server stored once the floor shows, else the one sent.
 * `scene` is its scene's name, for a DM who went elsewhere meanwhile.
 */
export function floorOutcomeText(outcome: ImportOutcome, name: string, scene: string, opened: boolean): { text: string; tone: "info" | "error" } {
  const goTo = opened ? "" : openFloorLine(scene, name);
  const back = "Undo setup in Setup history takes the whole import back.";
  switch (outcome.k) {
    case "complete":
      return outcome.checked
        ? { text: `The connection dropped during the import, but ${name} is complete: every wall, door and light is in. ${back}`, tone: "info" }
        : { text: `${name} is added to ${scene}, with every wall, door and light.${goTo}`, tone: "info" };
    case "none":
      return { text: outcome.lost ? "The connection dropped during the import, and no floor was added. Try again." : "The server refused the import, so no floor was added.", tone: "error" };
    case "partial":
      return { text: `The server refused part of the import, so the floor may be missing walls. ${back}`, tone: "error" };
    case "unconfirmed":
      return { text: `The connection dropped during the import, and ${name} could not be confirmed complete. It may be missing walls, doors or lights.${goTo} ${back}`, tone: "error" };
  }
}

/**
 * Whether the DM went to another scene while the hidden import ran: the
 * scene shown, or asked for, is neither the one shown when the walls began
 * nor the new one.
 */
export function movedOn(start: string | null, now: Pick<RoomView, "sceneId" | "sceneLoad"> & Partial<Pick<RoomView, "view">>, sceneId: string): boolean {
  const showing = now.sceneLoad?.requested ?? now.sceneId;
  // A switch to another floor of the scene the import began on is no move away from it (docs/design/design-v1-floors.md 10).
  const sameStart = showing === start || (start !== null && showing !== null && now.view != null && sameScene(now.view, showing, start));
  return !sameStart && showing !== sceneId;
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
