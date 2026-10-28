import type { ImportOptions, ImportPlan } from "./convert.ts";
import { decodeImageBase64, planImage, sniffImage, type ImagePlan } from "./image.ts";
import { fileSizeProblem, MAX_MAP_UPLOAD_BYTES, NOT_UVTT, RESIZE_QUALITY, type Device } from "./limits.ts";
import type { FromWorker, PreparedImage, Stage, ToWorker } from "./messages.ts";
import type { UvttMap } from "./schema.ts";
import { checkFile, planScene, type ReadTarget } from "./steps.ts";
import { proposedLight } from "../vision/uvttLight.ts";

/**
 * The Universal VTT import's worker (docs/design-v1-maps-vision.md section
 * 3.1, "Where it runs"). A file of 50 to 150 MB is read, parsed, checked
 * and decoded here, so the page never freezes while it happens. The file is
 * the DM's own and untrusted: every size is bounded before the work it
 * would cost, and the worst a hostile file can do is end this worker, which
 * the page reports as a plain error.
 */

const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  addEventListener(type: "message", listener: (e: MessageEvent<ToWorker>) => void): void;
};

let map: UvttMap | null = null;
let original: { blob: Blob; width: number; height: number; plan: ImagePlan } | null = null;

function post(message: FromWorker): void {
  scope.postMessage(message);
}

class Refusal extends Error {}

/** Progress notes at most every 100 ms, so a fast disk does not flood the page with them. */
function progress(stage: Stage): (done?: number, total?: number) => void {
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (done !== undefined && total !== undefined && done < total && now - last < 100) return;
    last = now;
    post({ t: "progress", stage, done, total });
  };
}

/** The file as text, a chunk at a time, so the page can show how far along it is. */
async function readText(file: File): Promise<string> {
  const note = progress("reading");
  note(0, file.size);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    // The size is checked before reading, but a file can grow on disk while it is read.
    if (loaded > file.size) throw new Refusal("The file changed while it was read. Choose it again.");
    parts.push(decoder.decode(value, { stream: true }));
    note(loaded, file.size);
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function convert(options: ImportOptions): { plan: ImportPlan | null; problem: string | null } {
  if (!map || !original) throw new Refusal(NOT_UVTT);
  post({ t: "progress", stage: "converting" });
  return planScene(map, options, original);
}

async function read(file: File, device: Device, target: ReadTarget, options: ImportOptions): Promise<void> {
  map = null;
  original = null;
  const tooBig = fileSizeProblem(file.size, device);
  if (tooBig) throw new Refusal(tooBig);
  let text: string | null = await readText(file);
  post({ t: "progress", stage: "checking" });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Refusal(NOT_UVTT);
  }
  // Only one copy of a file this size fits in some tabs at a time.
  text = null;
  const checked = checkFile(raw, target);
  raw = null;
  if (!checked.ok) throw new Refusal(checked.error);

  post({ t: "progress", stage: "decoding" });
  const bytes = decodeImageBase64(checked.map.image);
  checked.map.image = "";
  if (!bytes) throw new Refusal("This file's map image could not be read. It may be damaged.");
  const info = sniffImage(bytes);
  if (!info) throw new Refusal("This file's map image is not a PNG, WebP or JPEG image.");
  const plan = planImage({ width: info.width, height: info.height, bytes: bytes.byteLength }, device);
  if (plan.kind === "refuse") throw new Refusal(plan.error);
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: info.type });
  original = { blob, width: info.width, height: info.height, plan };
  map = checked.map;

  // A phase takes only the image, so its walls are never worked out.
  const converted = target === "scene" ? convert(options) : { plan: null, problem: null };
  post({
    t: "read",
    info: {
      image: { type: info.type, width: info.width, height: info.height, bytes: bytes.byteLength, blob },
      resize: plan.kind === "resize",
      hasObjects: map.objects.length > 0,
      lightPortals: map.portals.filter((p) => !p.closed).length,
      // The lights the scene would keep, so a phase, which takes none, proposes by the file's environment alone.
      light: proposedLight(map.environment, converted.plan?.lights.length ?? 0),
    },
    plan: converted.plan,
    problem: converted.problem,
  });
}

/**
 * The bytes to upload: the file's own image when it fits a map upload, or
 * the image drawn down to 8,192 px and encoded again. WebP where the
 * browser can encode it, JPEG on Safari, which cannot encode WebP from a
 * canvas and hands back a PNG when asked to.
 */
async function prepareImage(): Promise<PreparedImage> {
  if (!original) throw new Refusal("Choose the file again.");
  const { blob, width, height, plan } = original;
  if (plan.kind !== "resize") return { blob, width, height, resized: false };
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    throw new Refusal("This browser cannot resize the map image. Import it in a current Chrome, Firefox or Safari.");
  }
  post({ t: "progress", stage: "resizing" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Refusal("This file's map image could not be decoded. It may be damaged, or too large for this device.");
  }
  try {
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Refusal("This device could not resize the map image. Import it on a computer.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
    let out = await canvas.convertToBlob({ type: "image/webp", quality: RESIZE_QUALITY });
    if (out.type !== "image/webp") out = await canvas.convertToBlob({ type: "image/jpeg", quality: RESIZE_QUALITY });
    if (out.size > MAX_MAP_UPLOAD_BYTES) throw new Refusal("The map image is still over 32 MB after resizing. Export it smaller.");
    return { blob: out, width: plan.width, height: plan.height, resized: true };
  } finally {
    bitmap.close();
  }
}

scope.addEventListener("message", (e) => {
  const message = e.data;
  const run = async () => {
    if (message.t === "read") await read(message.file, message.device, message.target, message.options);
    else if (message.t === "convert") post({ t: "converted", ...convert(message.options) });
    else post({ t: "image", image: await prepareImage() });
  };
  run().catch((err: unknown) => {
    // A refusal is meant for the DM. Anything else is a fault here or a browser limit, said plainly.
    post({ t: "error", message: err instanceof Refusal ? err.message : "The file could not be read. It may be damaged, or too large for this device." });
  });
});
