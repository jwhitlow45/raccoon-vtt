import type { SceneInput } from "../scenes/create.ts";
import type { Preview } from "./client.ts";
import type { KeyInput } from "./keyPage.ts";
import { previewOf } from "./scratch.ts";
import type { Seed } from "./seed.ts";
import type { DungeonSettings, PlanContext } from "./settings.ts";

/*
 * The dungeon worker (docs/design/design-v1-dungeon-generator.md 5.5 and 8,
 * D-261102-370): the generator, the ops and the scratch reducer with its
 * admission checks run here, never on the page's thread, so a large
 * dungeon's preview never freezes the dialog. One request at a time, in
 * the order asked. The page drops answers it no longer wants.
 */

export type ToWorker = { t: "preview"; id: number; settings: DungeonSettings; seed: Seed; scene: SceneInput; context: PlanContext; key: KeyInput | null };
export type FromWorker = { t: "preview"; id: number; preview: Preview };

const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  addEventListener(type: "message", listener: (e: MessageEvent<ToWorker>) => void): void;
};

scope.addEventListener("message", (e) => {
  const { id, settings, seed, scene, context, key } = e.data;
  scope.postMessage({ t: "preview", id, preview: previewOf(settings, seed, scene, context, key) });
});
