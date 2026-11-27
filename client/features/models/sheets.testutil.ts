import { SheetCache, type SheetImage, type SheetIo } from "./sheets.ts";

/** The sheet cache's tests drive its every event by hand (sheets.test.ts, sheets.random.test.ts). */

type Pending = { url: string; signal: AbortSignal; resolve(image: SheetImage): void; reject(err: Error): void };

/** A cache whose loads wait for the test, whose news is told when the test says, and which records every free. */
export function harness() {
  const pending: Pending[] = [];
  const released: SheetImage[] = [];
  const news: (() => void)[] = [];
  const io: SheetIo = {
    load: (url, signal) => new Promise((resolve, reject) => pending.push({ url, signal, resolve, reject })),
    release: (image) => void released.push(image),
    schedule: (run) => void news.push(run),
  };
  const cache = new SheetCache(io);
  const images = new Map<string, SheetImage>();
  const imageOf = (url: string) => {
    let image = images.get(url);
    if (!image) images.set(url, (image = { url, width: 2048, height: 1024 } as unknown as SheetImage));
    return image;
  };
  const handed = new Set<SheetImage>();
  /** A decode's new image: a URL's first is `imageOf(url)`, and each one after is another object. */
  const decoded = (url: string) => {
    let image = imageOf(url);
    if (handed.has(image)) image = imageOf(`${url}#${handed.size}`);
    handed.add(image);
    return image;
  };
  /** Answers every waiting load, and lets the promises settle. */
  const finish = async (fail: (url: string) => boolean = () => false) => {
    for (const p of pending.splice(0)) {
      if (fail(p.url)) p.reject(new Error("404"));
      else p.resolve(decoded(p.url));
    }
    await new Promise((r) => setImmediate(r));
  };
  return { cache, pending, released, news, finish, imageOf, decoded };
}
