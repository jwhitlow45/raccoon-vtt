import type { SceneInput } from "../scenes/create.ts";
import type { Preview } from "./client.ts";
import type { DungeonEdits } from "./edits.ts";
import type { KeyInput } from "./keyPage.ts";
import type { WingBase } from "./plan.ts";
import { previewOf, wingPreviewOf } from "./scratch.ts";
import type { Seed } from "./seed.ts";
import type { DungeonSettings, PlanContext } from "./settings.ts";

/*
 * The dungeon worker (docs/design/design-v1-dungeon-generator.md 5.5 and 8,
 * D-261102-370): the generator, the ops and the scratch reducer with its
 * admission checks run here, never on the page's thread, so a large
 * dungeon's preview never freezes the dialog. One request at a time, in
 * the order asked. The page drops answers it no longer wants.
 */

/**
 * What the page asks: a new scene's preview, a wing's base (phase 3, 3.3),
 * which every later wing is planned on until another is posted, and a
 * wing's preview on it. Edits ride each preview (4.2) and never leave the
 * device.
 */
export type ToWorker =
  | { t: "preview"; id: number; settings: DungeonSettings; seed: Seed; scene: SceneInput; context: PlanContext; key: KeyInput | null; edits: DungeonEdits | null }
  | { t: "base"; base: WingBase }
  | { t: "wing"; id: number; settings: DungeonSettings; seed: Seed; context: PlanContext; key: KeyInput | null; edits: DungeonEdits | null };
export type FromWorker = { t: "preview"; id: number; preview: Preview };

const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  addEventListener(type: "message", listener: (e: MessageEvent<ToWorker>) => void): void;
};

let base: WingBase | null = null;

scope.addEventListener("message", (e) => {
  const m = e.data;
  if (m.t === "base") {
    base = m.base;
    return;
  }
  if (m.t === "wing") {
    // No base posted: the page answers its own wing with nothing to plan on as a bug, which it never sends.
    scope.postMessage({ t: "preview", id: m.id, preview: base ? wingPreviewOf(m.settings, m.seed, base, m.context, m.key, m.edits) : { ok: false, error: "bug" } });
    return;
  }
  scope.postMessage({ t: "preview", id: m.id, preview: previewOf(m.settings, m.seed, m.scene, m.context, m.key, undefined, m.edits) });
});
