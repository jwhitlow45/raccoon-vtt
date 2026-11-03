import { useSyncExternalStore } from "react";
import type { AssetId, MapVideo } from "#shared/model.ts";
import { api } from "../../lib/api.ts";
import { scopeSlot, useScopedIfAny } from "../../state/scope.ts";

/**
 * What animated maps share between the board, the DM's Map image row and the
 * Library viewer (docs/design/design-v1-animated-maps.md 5.2 and 5.3): why a
 * device shows a still, the board's live status, the server's switch, and
 * the one decoder a window lets a video hold.
 */

// ---------------------------------------------------------------- why a device shows the still

/**
 * Each reason a device shows a video map's still (5.3), with its words in
 * words.ts (4.2):
 * - setting: This device's or the display's Animated maps is Still.
 * - lowPower, reducedMotion: the device's own settings.
 * - stillView: Isometric or the Builder, Fog, Line up grid or Trap tool shows.
 * - codec: the browser cannot play the file's format.
 * - notSmooth: it can, but not smoothly, or on Phone size not power-efficiently.
 * - phoneSize: Phone size map detail and a video over its size or rate.
 * - notStarted: the browser refused `play()`, until a tap on the board.
 * - slowing, slowingOrSaving: the step-down (5.4), until the page reloads.
 *   The second is for a step-down in a window shaped like a 30 Hz render cap.
 * - loadFailed: a media error after its one retry.
 * - serverOff: the server's ANIMATED_MAPS switch is off.
 */
export const STILL_REASONS = [
  "setting",
  "lowPower",
  "reducedMotion",
  "stillView",
  "codec",
  "notSmooth",
  "phoneSize",
  "notStarted",
  "slowing",
  "slowingOrSaving",
  "loadFailed",
  "serverOff",
] as const;
export type StillReason = (typeof STILL_REASONS)[number];

export type PlaybackReason = "moving" | StillReason;

/** What a device does with one video: play it, or show the still and say why. */
export type Playback = { play: true; reason: "moving" } | { play: false; reason: StillReason };

export const MOVING: Playback = { play: true, reason: "moving" };

export function stillFor(reason: StillReason): Playback {
  return { play: false, reason };
}

/** A tiny store with useSyncExternalStore's shape, so one value has one source and every reader follows it. */
class Value<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();
  constructor(value: T) {
    this.#value = value;
  }
  readonly get = (): T => this.#value;
  readonly set = (next: T): void => {
    if (Object.is(next, this.#value)) return;
    this.#value = next;
    for (const listener of [...this.#listeners]) listener();
  };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

// ---------------------------------------------------------------- the board's live status

/** The video the board is handling now and what it does with it, or null when the scene showing has none. */
export type BoardVideo = { assetId: AssetId; playback: Playback } | null;

export type BoardVideoStatus = {
  get(): BoardVideo;
  /** AnimMapController's alone. A new object only when the asset or the playback changes, so readers render on change only. */
  set(next: BoardVideo): void;
  subscribe(listener: () => void): () => void;
};

export function boardVideoStatus(): BoardVideoStatus {
  const value = new Value<BoardVideo>(null);
  return {
    get: value.get,
    set(next) {
      const now = value.get();
      if (next === null ? now === null : now !== null && now.assetId === next.assetId && now.playback.reason === next.playback.reason) return;
      value.set(next);
    },
    subscribe: value.subscribe,
  };
}

/** One per Room page, so View as a player's board never speaks for the DM's. */
export const boardVideoSlot = scopeSlot(boardVideoStatus);

const NO_BOARD: BoardVideoStatus = boardVideoStatus();

/** The board's live status in this Room, or null outside one. The Map image row reads it for the video the board shows. */
export function useBoardVideo(): BoardVideo {
  const status = useScopedIfAny(boardVideoSlot) ?? NO_BOARD;
  return useSyncExternalStore(status.subscribe, status.get, status.get);
}

// ---------------------------------------------------------------- the server's switch

/** The server's switch: null until GET /api/config answers. */
const serverSwitch = new Value<boolean | null>(null);
let serverAsked: Promise<boolean> | null = null;

/**
 * Whether the server's owner turned animated maps on (ANIMATED_MAPS, from GET
 * /api/config). Read once a page load. A failed read counts as off, the safe
 * answer, and is tried again by the next reader.
 */
export function serverAnimatedMaps(): Promise<boolean> {
  serverAsked ??= api.getConfig().then(
    (config) => {
      const on = config.animatedMaps === true;
      serverSwitch.set(on);
      return on;
    },
    () => {
      serverAsked = null;
      serverSwitch.set(false);
      return false;
    },
  );
  return serverAsked;
}

function subscribeServerSwitch(listener: () => void): () => void {
  void serverAnimatedMaps();
  return serverSwitch.subscribe(listener);
}

const serverOn = () => serverSwitch.get() === true;

/** The server's switch now, or null until it is known. */
export const serverAnimatedMapsNow = (): boolean | null => serverSwitch.get();

/** The server's switch, false until it is known. The first reader asks the server. */
export function useServerAnimatedMaps(): boolean {
  return useSyncExternalStore(subscribeServerSwitch, serverOn, serverOn);
}

/** The server's switch, or null until the server answers, for a line that should wait rather than say off. */
export function useServerAnimatedMapsKnown(): boolean | null {
  return useSyncExternalStore(subscribeServerSwitch, serverSwitch.get, serverSwitch.get);
}

/** Forgets the switch, so a test can answer again. */
export function resetServerAnimatedMapsForTests(): void {
  serverAsked = null;
  serverSwitch.set(null);
}

// ---------------------------------------------------------------- one decoder per window

/**
 * Who may hold a video `src`: the board's element (each Room's, View as a
 * player's included) and the Library viewer's. The first-frame probe is
 * exempt (5.2): it lives in the upload form and clears its `src` before the
 * upload starts.
 */
export type DecoderUser = "board" | "viewer";

export type DecoderLease = {
  readonly user: DecoderUser;
  /** Whether this lease may hold a `src` now. */
  granted(): boolean;
  /**
   * Ends the lease. Call it once the element holds no `src` (after
   * `removeAttribute("src")` and `load()`), or to withdraw a lease still
   * waiting. Calling it again does nothing.
   */
  release(): void;
};

export type DecoderHandlers = {
  /** This lease may now set its element's `src`. Called at most once, and possibly before leaseDecoder returns. */
  onGrant(lease: DecoderLease): void;
  /**
   * Another user needs the decoder: stop handing the element to Konva, clear
   * its `src`, then release. A lease still waiting releases at once. Called
   * at most once. A user that still wants the decoder asks for a new lease.
   */
  onYield(lease: DecoderLease): void;
};

type Entry = { lease: DecoderLease; handlers: DecoderHandlers; state: "waiting" | "granted" | "released"; asked: boolean };

/**
 * A new lease asks an older one to yield, except that the board never takes
 * the decoder from the viewer: the board waits while the DM looks at a video
 * in the Library, and plays again when the viewer closes. So a viewer
 * covering the board, the DM replacing a map that plays, and a second viewer
 * page all wait for the older element's `src` to clear before setting theirs.
 */
function preempts(newer: DecoderUser, older: DecoderUser): boolean {
  return !(newer === "board" && older === "viewer");
}

const entries: Entry[] = [];
let pumping = false;

function holder(): Entry | undefined {
  return entries.find((e) => e.state === "granted");
}

/** Grants the decoder when no lease holds it: a waiting viewer first, else the oldest waiting lease. */
function pump(): void {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (holder()) return;
      const waiting = entries.filter((e) => e.state === "waiting");
      const next = waiting.find((e) => e.lease.user === "viewer") ?? waiting[0];
      if (!next) return;
      next.state = "granted";
      next.handlers.onGrant(next.lease);
    }
  } finally {
    pumping = false;
  }
}

function forget(entry: Entry): void {
  const at = entries.indexOf(entry);
  if (at >= 0) entries.splice(at, 1);
}

/**
 * Asks for the window's one decoder (5.2). The lease is granted at once when
 * nothing holds it. Otherwise every older lease it preempts is asked to
 * yield, and it is granted once the holder has released.
 */
export function leaseDecoder(user: DecoderUser, handlers: DecoderHandlers): DecoderLease {
  const lease: DecoderLease = {
    user,
    granted: () => entry.state === "granted",
    release() {
      if (entry.state === "released") return;
      entry.state = "released";
      forget(entry);
      pump();
    },
  };
  const entry: Entry = { lease, handlers, state: "waiting", asked: false };
  const older = entries.filter((e) => !e.asked && preempts(user, e.lease.user));
  entries.push(entry);
  for (const e of older) {
    if (e.state === "released" || e.asked) continue;
    e.asked = true;
    e.handlers.onYield(e.lease);
  }
  pump();
  return lease;
}

/** The leases alive now, for tests and the controller's own checks. */
export function decoderLeases(): ReadonlyArray<{ user: DecoderUser; granted: boolean }> {
  return entries.map((e) => ({ user: e.lease.user, granted: e.state === "granted" }));
}

/** Drops every lease without telling its holder, so a test starts clean. */
export function resetDecoderForTests(): void {
  for (const e of entries) e.state = "released";
  entries.length = 0;
}
