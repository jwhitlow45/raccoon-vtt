import { ModelRefusal, MODEL_WORDS, type FromModelWorker, type ModelMesh, type ToModelWorker } from "./mesh.ts";
import { fitModel, layoutAt, reachOf, rotationFor, type Fit, type Reach } from "./normalize.ts";
import { readModel } from "./read.ts";
import { SheetDrawer } from "./render.ts";

/**
 * The model worker (docs/design/design-v1-token-models.md 5): it reads the
 * file, keeps what it read while the sheet is open, and draws the 8 views
 * for each set of options. Only client.ts makes it. It loads nothing
 * from anywhere: the file comes in a message, textures decode from its own
 * bytes and the sheet goes back as a Blob, so it runs under the app's
 * `connect-src 'self'` with no fetch and no blob: URL. A hostile file can
 * at worst end it, which the page reports in a plain sentence.
 *
 * Requests run one at a time, in order. A refusal is a message, and
 * anything else thrown, out of memory say, is reported as a crash.
 */

const scope = self as unknown as {
  postMessage(message: FromModelWorker): void;
  addEventListener(type: "message", listener: (e: MessageEvent<ToModelWorker>) => void): void;
};

let drawer: SheetDrawer | null = null;
let mesh: ModelMesh | null = null;
/** Each way up's fit and reach, worked out once per mesh: only Size and Color change without them. */
const fits = new Map<string, { fit: Fit; reach: Reach }>();

async function draw(request: ToModelWorker): Promise<FromModelWorker> {
  const { id, file, device, options } = request;
  drawer ??= SheetDrawer.create();
  if (file) {
    mesh = null;
    fits.clear();
    scope.postMessage({ t: "stage", id, stage: "reading" });
    const read = await readModel(file, device);
    await drawer.load(read);
    mesh = read;
  }
  if (!mesh) throw new Error("no model read");
  scope.postMessage({ t: "stage", id, stage: "drawing" });
  const key = `${options.up}:${options.front}`;
  let known = fits.get(key);
  if (!known) {
    const fit = fitModel(mesh, rotationFor(mesh.axes, options.up, options.front));
    known = { fit, reach: reachOf(mesh, fit) };
    fits.set(key, known);
  }
  const layout = layoutAt(known.reach, options.size);
  const { sheet, front } = await drawer.draw(known.fit, layout, options.color);
  return { t: "drawn", id, sheet, front, meta: layout.meta, maxSize: layout.maxSize, colorable: mesh.colorable, notes: mesh.notes };
}

let queue: Promise<void> = Promise.resolve();

scope.addEventListener("message", (e) => {
  const request = e.data;
  queue = queue.then(async () => {
    try {
      scope.postMessage(await draw(request));
    } catch (err) {
      if (request.file) mesh = null;
      scope.postMessage({ t: "refused", id: request.id, message: err instanceof ModelRefusal ? err.message : MODEL_WORDS.crashed });
    }
  });
});
