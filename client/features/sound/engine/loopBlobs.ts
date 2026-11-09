/**
 * Where a loop reads its file from (docs/design/design-v1-music.md 5.3): a
 * blob of the whole file when it is small, fetched once, since Safari may not
 * keep range answers and would fetch every pass again. Until the blob is in,
 * and for a file that is too big, the file streams by Range.
 */

export interface LoopBlobDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Whole files up to this many bytes become a blob. */
  maxBytes: number;
}

/**
 * A failed fetch (the network down, or a server error) is forgotten, so the
 * next pass tries again. Only an answer that says the file is too big is
 * remembered for good, since asking again cannot change it. Remembering a
 * failure as "stream it" would leave a loop that started during an outage
 * streaming for the rest of the session.
 */
export class LoopBlobs {
  readonly #deps: LoopBlobDeps;
  readonly #blobs = new Map<string, string | Promise<void> | "stream">();
  #disposed = false;

  constructor(deps: LoopBlobDeps) {
    this.#deps = deps;
  }

  /** The address to play now: the blob once it is in, else `direct`, with the fetch started. */
  urlFor(assetId: string, direct: string): string {
    const known = this.#blobs.get(assetId);
    if (known === "stream") return direct;
    if (typeof known === "string") return known;
    if (!known && !this.#disposed) this.#blobs.set(assetId, this.#load(assetId, direct));
    return direct;
  }

  async #load(assetId: string, direct: string): Promise<void> {
    const abort = new AbortController();
    try {
      const res = await this.#deps.fetch(direct, { credentials: "same-origin", signal: abort.signal });
      if (!res.ok) {
        abort.abort();
        this.#blobs.delete(assetId);
        return;
      }
      const size = Number(res.headers.get("content-length") ?? Infinity);
      if (!(size <= this.#deps.maxBytes)) {
        abort.abort();
        this.#blobs.set(assetId, "stream");
        return;
      }
      const blob = await res.blob();
      if (this.#disposed) return;
      this.#blobs.set(assetId, this.#deps.createObjectURL(blob));
    } catch {
      this.#blobs.delete(assetId);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const url of this.#blobs.values()) if (url !== "stream" && typeof url === "string") this.#deps.revokeObjectURL(url);
    this.#blobs.clear();
  }
}
