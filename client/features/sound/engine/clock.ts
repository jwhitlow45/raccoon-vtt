/**
 * The server's time, measured for sound (docs/design/design-v1-music.md 5.1).
 * The store's `serverOffset` is a lower bound off by one network delay, 20
 * to 150 ms on a phone, too far for two devices to sound together. So while
 * sound plays here the page sends `{ t: "time", k }` frames, the server
 * answers with its `Date.now()`, and the offset is read from the answer
 * with the shortest round trip.
 *
 * Each measurement epoch starts when sound starts here, on a wake and on a
 * reconnect, and drops every earlier sample and any answer whose `k`
 * belongs to an earlier epoch: after a long sleep the network may be slower
 * than before, and the old best round trip would hold an offset the
 * device's clock has since left behind. A device sends none while the room
 * plays nothing.
 *
 * Until the new epoch's first answer, the last epoch's reading stands in,
 * as long as the store's offset agrees with it within a second: the store's
 * is one network delay off, and a wake's forced check read with it would
 * seek every voice, an audible dip, for that delay alone (D-261102-871). A
 * sleep that stopped this page's clock moves the store's offset seconds
 * away from the old reading, so the store's is used then, as it is with no
 * reading before.
 */

/** Probes at the start of an epoch, this far apart, then one every PROBE_EVERY_MS while sound plays. */
export const FIRST_PROBES = 5;
export const PROBE_GAP_MS = 250;
export const PROBE_EVERY_MS = 25_000;
/** The best round trip is chosen from this many latest samples. */
export const SAMPLES_KEPT = 8;
/** A round trip longer than this says too little to keep. */
export const RTT_MAX_MS = 1_000;

export type ClockEnv = {
  /** This page's monotonic clock, `performance.now()`. */
  now(): number;
  /** Sends a time frame, false when the socket is not open. */
  send(k: number): boolean;
  setTimer(ms: number, fn: () => void): unknown;
  clearTimer(handle: unknown): void;
  /** The store's offset (server time less `performance.now()`), the fallback before an epoch's first answer. */
  fallback(): number | undefined;
};

type Sample = { rtt: number; offset: number };

export class ServerClock {
  readonly #env: ClockEnv;
  #epoch = 0;
  #k = 0;
  /** The probes still waiting for an answer: their epoch and when each was sent. */
  readonly #sent = new Map<number, { epoch: number; at: number }>();
  #samples: Sample[] = [];
  /** The last epoch's reading, which stands in until this epoch's first answer. */
  #carried: number | undefined = undefined;
  #running = false;
  #timer: unknown = null;
  #left = 0;

  constructor(env: ClockEnv) {
    this.#env = env;
  }

  /** Sound starts here: a new epoch, then a probe now and then. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#newEpoch();
  }

  /** Nothing plays here any more: no probes until it does. */
  stop(): void {
    this.#running = false;
    this.#clear();
  }

  /** A wake (visibilitychange, pageshow) or a reconnect: what was measured before may no longer hold. */
  restart(): void {
    if (this.#running) this.#newEpoch();
  }

  /** The server's answer to probe `k`, with its time. */
  answer(k: number, at: number): void {
    const sent = this.#sent.get(k);
    this.#sent.delete(k);
    if (!sent || sent.epoch !== this.#epoch || !Number.isFinite(at)) return;
    const rtt = this.#env.now() - sent.at;
    if (rtt < 0 || rtt > RTT_MAX_MS) return;
    this.#samples.push({ rtt, offset: at - (sent.at + rtt / 2) });
    if (this.#samples.length > SAMPLES_KEPT) this.#samples.shift();
  }

  /**
   * Server time less `performance.now()`: the shortest round trip's reading
   * this epoch, or before its first answer the last epoch's while the
   * store's agrees with it, else the store's.
   */
  offset(): number | undefined {
    const best = this.#best();
    if (best !== undefined) return best;
    const fallback = this.#env.fallback();
    if (this.#carried !== undefined && fallback !== undefined && Math.abs(this.#carried - fallback) <= RTT_MAX_MS) return this.#carried;
    return fallback;
  }

  #best(): number | undefined {
    let best: Sample | null = null;
    for (const s of this.#samples) if (best === null || s.rtt < best.rtt) best = s;
    return best?.offset;
  }

  /** The server's time now, or undefined before any reading. */
  serverNow(): number | undefined {
    const offset = this.offset();
    return offset === undefined ? undefined : this.#env.now() + offset;
  }

  /** Whether this epoch has an answer yet. */
  get measured(): boolean {
    return this.#samples.length > 0;
  }

  #newEpoch(): void {
    this.#carried = this.#best() ?? this.#carried;
    this.#epoch++;
    this.#samples = [];
    this.#sent.clear();
    this.#clear();
    this.#left = FIRST_PROBES;
    this.#probe();
  }

  #probe(): void {
    if (!this.#running) return;
    const k = ++this.#k;
    const now = this.#env.now();
    // An answer later than this would be dropped anyway.
    for (const [old, sent] of this.#sent) if (now - sent.at > RTT_MAX_MS) this.#sent.delete(old);
    if (this.#env.send(k)) this.#sent.set(k, { epoch: this.#epoch, at: this.#env.now() });
    this.#left = Math.max(0, this.#left - 1);
    this.#timer = this.#env.setTimer(this.#left > 0 ? PROBE_GAP_MS : PROBE_EVERY_MS, () => {
      this.#timer = null;
      this.#probe();
    });
  }

  #clear(): void {
    if (this.#timer !== null) this.#env.clearTimer(this.#timer);
    this.#timer = null;
  }
}
