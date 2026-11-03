import { PieceSink, type FromWorker, type Mp3EncoderClass, type ToWorker } from "./encode.ts";

/**
 * The encode worker (docs/design/design-v1-sound.md 4.2 step 5): one file's
 * pieces in, its loudness and its MP3 out. `@breezystack/lamejs` loads
 * here by `import()` only when a file is converted, so it stays a chunk of
 * its own beside its license texts (vite.config.ts `lameLicense`), and a
 * file that is copied never loads it. A worker serves one file and is
 * then ended, which frees whatever the encoder held.
 */

const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
let sink: PieceSink | null = null;
let failed = false;
/** Messages handled in order: the encoder's import makes `start` wait, and pieces must not pass it. */
let chain: Promise<void> = Promise.resolve();

function send(message: FromWorker): void {
  scope.postMessage(message);
}

async function handle(message: ToWorker): Promise<void> {
  if (failed) return;
  try {
    switch (message.t) {
      case "start": {
        const Encoder = message.encode ? ((await import("@breezystack/lamejs")).Mp3Encoder as unknown as Mp3EncoderClass) : null;
        sink = new PieceSink(message, Encoder);
        return;
      }
      case "pcm":
        sink!.pcm(message.channels);
        return send({ t: "took", seq: message.seq });
      case "wav":
        sink!.wav(message.bytes);
        return send({ t: "took", seq: message.seq });
      case "end": {
        const result = sink!.end();
        sink = null;
        return send({ t: "done", lufs: result.lufs, peak: result.peak, mp3: result.mp3 ? new Blob(result.mp3 as BlobPart[], { type: "audio/mpeg" }) : null });
      }
    }
  } catch (err) {
    failed = true;
    sink = null;
    send({ t: "failed", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  chain = chain.then(() => handle(e.data));
};
