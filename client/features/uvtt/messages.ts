import type { LightProposal } from "../vision/uvttLight.ts";
import type { ImportOptions, ImportPlan } from "./convert.ts";
import type { ImageType } from "./image.ts";
import type { Device } from "./limits.ts";
import type { ReadTarget } from "./steps.ts";

/**
 * What the Universal VTT worker and the page say to each other
 * (worker.ts, client.ts). One request at a time, answered in order, with
 * progress notes while a slow step runs.
 */

export type Stage = "reading" | "checking" | "decoding" | "converting" | "resizing";

/** What a read found, for the summary sheet. The image's own bytes come along as a Blob, which costs no copy. */
export type ReadInfo = {
  image: { type: ImageType; width: number; height: number; bytes: number; blob: Blob };
  /** Whether the image must be drawn smaller before it is uploaded. */
  resize: boolean;
  hasObjects: boolean;
  /** Portals whose "block light" switch is off, which the DM chooses to import as windows or open doors. */
  lightPortals: number;
  /** The scene's light level the file suggests, if it says anything about its light (vision/uvttLight.ts). */
  light: LightProposal | null;
};

export type ToWorker =
  | { t: "read"; file: File; device: Device; target: ReadTarget; options: ImportOptions }
  | { t: "convert"; options: ImportOptions }
  | { t: "image" };

export type PreparedImage = { blob: Blob; width: number; height: number; resized: boolean };

export type FromWorker =
  | { t: "progress"; stage: Stage; done?: number; total?: number }
  | { t: "read"; info: ReadInfo; plan: ImportPlan | null; problem: string | null }
  | { t: "converted"; plan: ImportPlan | null; problem: string | null }
  | { t: "image"; image: PreparedImage }
  | { t: "error"; message: string };
