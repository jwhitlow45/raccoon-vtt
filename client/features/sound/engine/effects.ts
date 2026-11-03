import { SOUND_LIMITS } from "#shared/limits.ts";
import type { BuiltinSound, FiredEffect, SoundId } from "#shared/sound.ts";
import { builtinMs } from "./builtins.ts";
import { firedAfter } from "./store.ts";

/**
 * Effects on this page (docs/design/design-v1-music.md 5.4). Each entry of
 * the projected list starts at its `at` on the context's clock, once at
 * most. One fired before the page loaded the room, or one seen while the
 * page was quiet and then begins to play (Play here, a handoff, a tap),
 * starts only with 3 seconds or more left to sound, partway in. The load is
 * the page's own, which SoundHost passes, not the lazy engine's first look,
 * so the effect whose fire loads the engine counts as fired after it. Later
 * an entry starts only if it was fired after the page loaded the room and
 * was never withdrawn from this page's list: so one that comes back after
 * Undo, Redo or a change of use, or one fired before the load that the page
 * sees only later, never starts. Ready late by up to a second, it plays
 * whole, late. Later than that it starts partway in with 3 seconds or more
 * left, else it is skipped.
 *
 * Each load and each voice belongs to its entry, and is cancelled when that
 * entry leaves the list (stopped, or past the list's cap) or its sound
 * stops being an Effect (deleted, or given another use), which a DM's list
 * keeps as history. Stop all, Room sound off, a blackout and disposal cancel
 * every load and voice at once, the design's engine-wide generation: each
 * waiting entry is done for good and the decode in flight is aborted, so a
 * fetch or a decode that finishes late never starts a sound. Decoded
 * effects, the playing ones included, take at most 48 MB, one decode in
 * flight, and six play at once at most: a seventh stops the one closest to
 * its end.
 */

/** Ready this late or less, an effect plays whole. */
export const LATE_WHOLE_MS = 1_000;
/** Started partway, an effect needs this much left. */
export const PARTWAY_LEFT_MS = 3_000;
/** What the player needs of a room effect's sound, as the projection carries it. */
export type EffectSound = { assetId: string; ms: number; level?: number };

/** The browser's parts, so a test runs without one. Times are the server's, in ms. */
export interface EffectEnv {
  serverNow(): number;
  /** Fetches and decodes an asset. The signal aborts when no entry needs it any more, or on Stop all. */
  decode(assetId: string, signal: AbortSignal): Promise<DecodedEffect>;
  /** Starts a decoded buffer or a built-in at server time `at`, `offsetMs` into it, for the entry `id`. */
  play(what: { buffer: unknown } | { builtin: BuiltinSound }, at: number, offsetMs: number, level: number, id: string): EffectVoice;
}

export type DecodedEffect = { buffer: unknown; bytes: number };
export interface EffectVoice {
  stop(): void;
  /** Called by the player when the voice ends by itself, so it leaves the count. */
  onEnded(fn: () => void): void;
}

type Seen = {
  entry: FiredEffect;
  /** "join": started only with 3 s left. "fired": fired after the load and seen while this page plays. */
  kind: "join" | "fired";
};

type Cached = { bytes: number; buffer: unknown; lastPlayed: number; playing: number };
type Playing = { id: string; voice: EffectVoice; assetId: string | null; startedAt: number; endsAt: number };

export class EffectPlayer {
  readonly #env: EffectEnv;
  readonly #budget: number;
  readonly #atOnce: number;
  /** Server time the page loaded the room, as its caller knows it, or else of this player's first look at a list. */
  #loadAt: number | null;
  readonly #loadKnown: boolean;
  #looked = false;
  /** The entries of the last confirmed list. */
  #held = new Map<string, FiredEffect>();
  readonly #seen = new Map<string, Seen>();
  /**
   * Started, skipped, or withdrawn from this page's list: never started
   * again here, so an entry that comes back after Undo, Redo or a change of
   * use stays quiet. Withdrawals come only from confirmed lists (see), never
   * from a reconnect's cleared store.
   */
  readonly #done = new Set<string>();
  #active = false;
  readonly #cache = new Map<string, Cached>();
  /** The asset decoding now, its own abort, and the entries waiting on loads, in the order they came. */
  #decoding: string | null = null;
  #decodeAbort: AbortController | null = null;
  #waiting: string[] = [];
  #playing: Playing[] = [];
  #sounds: Readonly<Record<SoundId, EffectSound>> = {};

  /** `loadAt`: when the page first held the room's confirmed state, in server ms, which the engine loaded later. */
  constructor(env: EffectEnv, options: { budget?: number; atOnce?: number; loadAt?: number } = {}) {
    this.#env = env;
    this.#loadAt = options.loadAt ?? null;
    this.#loadKnown = options.loadAt !== undefined;
    this.#budget = options.budget ?? SOUND_LIMITS.effectsDecodedBytes;
    this.#atOnce = options.atOnce ?? SOUND_LIMITS.effectsAtOnce;
  }

  /** How many voices sound now, for tests and the test hook. */
  get voices(): number {
    return this.#playing.length;
  }

  get cachedBytes(): number {
    let n = 0;
    for (const c of this.#cache.values()) n += c.bytes;
    return n;
  }

  /**
   * A confirmed projection's list, or null when the viewer has none (a
   * blackout, nothing playing). Never a reconnect's cleared store: the
   * caller skips those, so a reconnect withdraws nothing.
   */
  see(effects: readonly FiredEffect[] | null, sounds: Readonly<Record<SoundId, EffectSound>>): void {
    const now = this.#env.serverNow();
    const list = effects ?? [];
    const next = new Map(list.map((e) => [e.id, e]));
    for (const id of this.#held.keys()) {
      if (!next.has(id)) this.#cancel(id);
    }
    // A DM's list keeps an entry whose sound was deleted or given another use, as history, so the sound leaving is a
    // withdrawal too. Both run before the new sounds are taken: an entry's old sound names the load to abort.
    for (const e of list) if (e.soundId !== undefined && !Object.hasOwn(sounds, e.soundId)) this.#cancel(e.id);
    this.#sounds = sounds;
    const first = !this.#looked;
    this.#looked = true;
    const loadAt = (this.#loadAt ??= now);
    for (const e of list) {
      if (this.#seen.has(e.id) || this.#done.has(e.id)) continue;
      // The first look holds what played at the load, unless the page told when it loaded: the engine loads only once
      // something plays, often for the very effect it then sees first.
      const after = (!first || this.#loadKnown) && firedAfter(e, loadAt);
      if (!first && !after) {
        // Fired before the load and seen only now, as after a change of use: never here.
        this.#done.add(e.id);
        continue;
      }
      // Seen while this page is quiet, it joins later, unless it is in the engine's first look, which came before the page could play.
      this.#seen.set(e.id, { entry: e, kind: after && (this.#active || first) ? "fired" : "join" });
    }
    this.#held = next;
    for (const id of this.#seen.keys()) if (!next.has(id)) this.#seen.delete(id);
    // No list at all is a blackout or nothing playing: everything goes, a late decode included.
    if (effects === null) this.stopAll();
    this.#admit();
  }

  /**
   * This page plays or stops playing (owner, Room sound, unlocked). Turning
   * on is a join: what still sounds 3 s or more starts partway. Turning off
   * cancels everything, as Stop all does.
   */
  setActive(active: boolean): void {
    if (active === this.#active) return;
    this.#active = active;
    if (!active) {
      this.stopAll();
      // What was fired before it stopped joins later only with 3 s left.
      for (const s of this.#seen.values()) s.kind = "join";
      return;
    }
    this.#admit();
  }

  /** Stop all, Room sound off, a blackout, disposal: every load and voice goes, and a late decode starts nothing. */
  stopAll(): void {
    this.#decodeAbort?.abort();
    this.#decodeAbort = null;
    this.#decoding = null;
    for (const id of this.#waiting) this.#done.add(id);
    this.#waiting = [];
    for (const p of this.#playing.splice(0)) p.voice.stop();
    for (const c of this.#cache.values()) c.playing = 0;
  }

  dispose(): void {
    this.stopAll();
    this.#cache.clear();
  }

  #length(e: FiredEffect): number | null {
    if (e.builtin) return builtinMs(e.builtin);
    const sound = e.soundId ? this.#sounds[e.soundId] : undefined;
    return sound ? sound.ms : null;
  }

  /** Starts or queues every entry that may start now. */
  #admit(): void {
    if (!this.#active) return;
    const now = this.#env.serverNow();
    const order = [...this.#seen.values()].filter((s) => !this.#done.has(s.entry.id) && this.#held.has(s.entry.id)).sort((a, b) => a.entry.at - b.entry.at);
    for (const s of order) {
      const e = s.entry;
      const ms = this.#length(e);
      if (ms === null) {
        // Its sound is not in the projection: no longer an Effect, or gone.
        this.#done.add(e.id);
        continue;
      }
      if (s.kind === "join" && e.at + ms - Math.max(now, e.at) < PARTWAY_LEFT_MS && now > e.at) {
        this.#done.add(e.id);
        continue;
      }
      if (e.builtin) {
        this.#done.add(e.id);
        this.#start(e, null, { builtin: e.builtin }, ms, s.kind);
        continue;
      }
      const sound = this.#sounds[e.soundId!]!;
      const cached = this.#cache.get(sound.assetId);
      if (cached) {
        this.#done.add(e.id);
        this.#start(e, sound.assetId, { buffer: cached.buffer }, ms, s.kind);
        continue;
      }
      if (!this.#waiting.includes(e.id)) this.#waiting.push(e.id);
    }
    this.#nextDecode();
  }

  /** One decode in flight: the oldest waiting entry's asset. */
  #nextDecode(): void {
    if (this.#decoding !== null) return;
    const id = this.#waiting.find((w) => this.#held.has(w));
    if (id === undefined) {
      this.#waiting = [];
      return;
    }
    const e = this.#seen.get(id)!.entry;
    const sound = e.soundId ? this.#sounds[e.soundId] : undefined;
    if (!sound) {
      this.#waiting = this.#waiting.filter((w) => w !== id);
      this.#done.add(id);
      return this.#nextDecode();
    }
    const assetId = sound.assetId;
    const abort = new AbortController();
    this.#decoding = assetId;
    this.#decodeAbort = abort;
    this.#env.decode(assetId, abort.signal).then(
      (decoded) => {
        // Aborted by Stop all or its entry leaving: a decode already under way finishes anyway, and starts nothing.
        if (abort.signal.aborted) return;
        this.#decoding = null;
        this.#decodeAbort = null;
        this.#store(assetId, decoded);
        this.#ready(assetId);
        this.#nextDecode();
      },
      () => {
        if (this.#decodeAbort !== abort) return;
        this.#decoding = null;
        this.#decodeAbort = null;
        // The entries that waited on it are skipped: an effect that failed to load is never retried late.
        for (const w of this.#waiting.filter((w) => this.#assetOf(w) === assetId)) this.#done.add(w);
        this.#waiting = this.#waiting.filter((w) => this.#assetOf(w) !== assetId);
        this.#nextDecode();
      },
    );
  }

  #assetOf(id: string): string | null {
    const e = this.#seen.get(id)?.entry;
    const sound = e?.soundId ? this.#sounds[e.soundId] : undefined;
    return sound?.assetId ?? null;
  }

  /** Entries waiting on an asset that is in now start, under the late rules. */
  #ready(assetId: string): void {
    const cached = this.#cache.get(assetId);
    if (!cached) return;
    for (const id of [...this.#waiting]) {
      if (this.#assetOf(id) !== assetId) continue;
      this.#waiting = this.#waiting.filter((w) => w !== id);
      if (!this.#held.has(id) || this.#done.has(id)) continue;
      const s = this.#seen.get(id)!;
      const ms = this.#length(s.entry);
      this.#done.add(id);
      if (ms !== null) this.#start(s.entry, assetId, { buffer: cached.buffer }, ms, s.kind);
    }
  }

  /** Keeps a decoded buffer within the budget: least recently played cached ones go first, then the oldest playing voice. */
  #store(assetId: string, decoded: DecodedEffect): void {
    const fits = () => this.cachedBytes + decoded.bytes <= this.#budget;
    while (!fits()) {
      let lru: [string, Cached] | null = null;
      for (const entry of this.#cache) if (entry[1].playing === 0 && (lru === null || entry[1].lastPlayed < lru[1].lastPlayed)) lru = entry;
      if (lru) {
        this.#cache.delete(lru[0]);
        continue;
      }
      const oldest = this.#playing.find((p) => p.assetId !== null);
      if (!oldest) break;
      this.#stopVoice(oldest);
    }
    this.#cache.set(assetId, { bytes: decoded.bytes, buffer: decoded.buffer, lastPlayed: this.#env.serverNow(), playing: 0 });
  }

  #start(e: FiredEffect, assetId: string | null, what: { buffer: unknown } | { builtin: BuiltinSound }, ms: number, kind: Seen["kind"]): void {
    const now = this.#env.serverNow();
    let offset = 0;
    if (now > e.at) {
      const late = now - e.at;
      if (kind === "fired" && late <= LATE_WHOLE_MS) offset = 0;
      else if (ms - late >= PARTWAY_LEFT_MS) offset = late;
      else return;
    }
    // At six, the one closest to its end gives way, so a run of short effects never cuts a long one (5.4's Thunder).
    while (this.#playing.length >= this.#atOnce) this.#stopVoice(this.#playing.reduce((a, b) => (b.endsAt < a.endsAt ? b : a)));
    const level = e.soundId ? (this.#sounds[e.soundId]?.level ?? 0) : 0;
    const at = Math.max(e.at, now);
    const voice = this.#env.play(what, at, offset, level, e.id);
    const playing: Playing = { id: e.id, voice, assetId, startedAt: at, endsAt: at + ms - offset };
    this.#playing.push(playing);
    if (assetId) {
      const cached = this.#cache.get(assetId);
      if (cached) {
        cached.playing++;
        cached.lastPlayed = at;
      }
    }
    voice.onEnded(() => this.#ended(playing));
  }

  #ended(p: Playing): void {
    const at = this.#playing.indexOf(p);
    if (at < 0) return;
    this.#playing.splice(at, 1);
    if (p.assetId) {
      const cached = this.#cache.get(p.assetId);
      if (cached) cached.playing = Math.max(0, cached.playing - 1);
    }
  }

  #stopVoice(p: Playing): void {
    this.#ended(p);
    p.voice.stop();
  }

  /** Its entry left the list: its load and its voice go, and nothing else. */
  #cancel(id: string): void {
    this.#done.add(id);
    const assetId = this.#assetOf(id);
    this.#waiting = this.#waiting.filter((w) => w !== id);
    for (const p of this.#playing.filter((p) => p.id === id)) this.#stopVoice(p);
    // Its decode goes too, unless another waiting entry needs the same file.
    if (assetId !== null && this.#decoding === assetId && !this.#waiting.some((w) => this.#assetOf(w) === assetId)) {
      this.#decodeAbort?.abort();
      this.#decodeAbort = null;
      this.#decoding = null;
      queueMicrotask(() => this.#nextDecode());
    }
  }
}
