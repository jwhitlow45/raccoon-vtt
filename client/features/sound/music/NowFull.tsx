import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../../../components/Button.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Help } from "../../../components/Panel.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { FADES, seekBoundMs, type Fade, type Repeat, type SoundId } from "#shared/sound.ts";
import { useSoundToStop, useTicking, useWakeAt } from "../panel/controls.tsx";
import { StopAllButton } from "../panel/NowPlaying.tsx";
import { send } from "../panel/ops.ts";
import { musicShown, playlistsOf, serverNow, soundsOf, type MusicShown } from "../panel/state.ts";
import { clockText, NO_MUSIC_PICK, NO_MUSIC_PLAYING, REPEAT_NAMES, REPEAT_NEXT, runLine, skipName, STOP_MUSIC } from "../panel/words.ts";
import { previousTarget, queueLists, type QueueLists } from "./dragOrder.ts";
import { useJumps } from "./jumps.ts";
import { CrossfadeMenu, useWidth } from "./parts.tsx";
import { Tile, TILE } from "./tile.ts";
import { CROSSFADE, FADE_WORDS, PREVIOUS, SEEK, seekText, SHUFFLE } from "./words.ts";

/** A seek is sent this long after the slider's last key, so a held arrow sends one (4.2). */
export const SEEK_KEY_MS = 400;

/** Five 48 px buttons, 4 px apart, take this much width in one row (4.2). */
const ONE_ROW_PX = 5 * 48 + 4 * 4;
/** Under this width the tile shrinks. */
const NARROW_PX = 300;

/** A seek in hand: the place on the slider, and the run and track it was made on. */
export type HeldSeek = { run: string; soundId: SoundId; ms: number };

/** Whether a seek in hand still applies: the run and the playing track it was made on still play (4.2). */
export function seekHolds(seek: HeldSeek, lists: QueueLists | null): boolean {
  return lists !== null && lists.run === seek.run && lists.playing === seek.soundId;
}

/** The slider's events: a drag's start and end, and each value it takes. */
export type SeekEvents = { start(): void; end(): void; input(ms: number): void };

/** The timers a seek gesture arms, the window's unless a test gives its own. */
export type SeekTimers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

const WINDOW_TIMERS: SeekTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/** The run and the playing track a seek is made on, as one value, so a gesture sees a change of either. */
export function seekOn(lists: Pick<QueueLists, "run" | "playing">): string {
  return `${lists.run}\n${lists.playing}`;
}

/**
 * When the slider sends its seek (4.2): once as a drag ends, and
 * SEEK_KEY_MS after the last value a key gave, so a held arrow sends one.
 * No timer runs inside a drag: its start disarms one a key armed just
 * before, and a value it gives arms none. Only the pointer's release ends
 * a drag, never a key pressed while it is held: the browser sends that
 * release to the slider wherever the pointer lets go. `commit` sends the
 * seek in hand, if it still holds.
 *
 * A drag holds on to the run and track it began on (`on`, seekOn). Once
 * either changes, by `drop` or by a value given on another, the rest of
 * that press is cancelled: its values are refused, so no seek in hand is
 * made on the new track, and its release sends nothing (MB-SOL-01). The
 * DM's place was on the old track, and the next press starts afresh.
 * `input` says whether to take its value.
 */
export function seekGesture(commit: () => void, timers: SeekTimers = WINDOW_TIMERS) {
  let dragging = false;
  let on = "";
  let cancelled = false;
  let timer: unknown = null;
  const disarm = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  return {
    start(at: string) {
      disarm();
      dragging = true;
      on = at;
      cancelled = false;
    },
    end() {
      if (!dragging) return;
      dragging = false;
      disarm();
      if (!cancelled) commit();
    },
    input(at: string): boolean {
      if (dragging) {
        if (at !== on) cancelled = true;
        return !cancelled;
      }
      disarm();
      timer = timers.set(() => {
        timer = null;
        commit();
      }, SEEK_KEY_MS);
      return true;
    },
    /** A seek in hand no longer holds: its timer goes, and a drag under way is cancelled. */
    drop() {
      disarm();
      if (dragging) cancelled = true;
    },
  };
}

/**
 * How the player offers Crossfade (docs/design/design-v1-sound-layout.md
 * 5.3): its menu, or a row of its four choices in place, for the chip's
 * popover, where the menu, a popover of its own, would close the player
 * that holds it.
 */
export type FadeControl = "menu" | "inline";

/**
 * The player (docs/design/design-v1-music-player.md 4.2, as the Sound
 * panel and the chip's player hold it, docs/design/design-v1-sound-layout.md
 * 4.2 and 5.3): the tile with the track's name and run line, the seek row,
 * the transport (Shuffle, Previous, Play or Pause, Skip, Repeat), then
 * Crossfade and Stop the music in a centered row, then `stopAll` in a
 * centered row of its own. With no music, the idle line, which names
 * Library as a link while `onLibrary` is given, then `stopAll`. Pure, so
 * its states render in a test. It fills its container's width, so the
 * chip's card and sheet reach their edges, and only the chip's popover
 * caps it.
 */
export function NowFullView(props: {
  shown: MusicShown | null;
  shuffle: boolean;
  repeat: Repeat;
  fade: Fade;
  width: number;
  /** The slider's end: the track's length, or one pass under Repeat one with a crossfade. */
  boundMs: number;
  /** The place the slider shows: a seek in hand, else the music's. */
  atMs: number;
  onSeek: SeekEvents;
  onShuffle(): void;
  onPrevious(): void;
  onPause(): void;
  onResume(): void;
  onSkip(): void;
  onRepeat(): void;
  onFade(fade: Fade): void;
  onStop(): void;
  /** The menu unless given. */
  fadeControl?: FadeControl;
  /** Stop all sound, in its own row under the foot, or null while nothing sounds. */
  stopAll?: ReactNode;
  /** Shows Library, where the idle line names it. Without it the line says only that no music plays. */
  onLibrary?(): void;
}) {
  const { shown } = props;
  /*
   * Its own centered row, never a wrap of the foot's: a lone button wrapped
   * under Crossfade and Stop the music measures as an orphan at 360 and 390
   * px (SL-OPUS-7), and this way the block looks one way at every width.
   */
  const stopAll = props.stopAll ? (
    <div data-music-stop-all="" style={CENTERED}>
      {props.stopAll}
    </div>
  ) : null;
  if (!shown) {
    return (
      <div data-music-now="" data-music-idle="" style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
        <IdleLine onLibrary={props.onLibrary} />
        {stopAll}
      </div>
    );
  }
  const twoRows = props.width > 0 && props.width < ONE_ROW_PX;
  const narrow = props.width > 0 && props.width < NARROW_PX;
  const at = Math.max(0, Math.min(props.atMs, props.boundMs));
  const shuffle = <IconButton icon="shuffle" label={SHUFFLE} style={BIG} pressed={props.shuffle} onClick={props.onShuffle} />;
  const repeat = <IconButton icon={props.repeat === "one" ? "repeatOne" : "again"} label={REPEAT_NAMES[props.repeat]} style={BIG} pressed={props.repeat !== "off"} onClick={props.onRepeat} />;
  const middle = (
    <>
      <IconButton icon="previous" label={PREVIOUS} style={BIG} onClick={props.onPrevious} />
      <button type="button" aria-label={shown.paused ? "Play" : "Pause"} data-music-play="" onClick={shown.paused ? props.onResume : props.onPause} style={PLAY_BIG}>
        <Icon name={shown.paused ? "play" : "pause"} size={24} />
      </button>
      <IconButton icon="skip" label={skipName(shown.crossingInto)} style={BIG} onClick={props.onSkip} />
    </>
  );
  return (
    <div data-music-now="" style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(3), minWidth: 0 }}>
        <Tile name={shown.name} size={narrow ? TILE.nowNarrow : TILE.now} />
        <div style={{ flex: 1, display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
          <span data-music-track="" style={{ fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
            {shown.name}
          </span>
          <span data-music-run="" style={{ fontSize: theme.font.body14, color: theme.color.textMuted, overflowWrap: "anywhere" }}>
            {runLine(shown)}
          </span>
        </div>
      </div>
      <div data-music-seek="" style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
        <span aria-hidden style={TIME}>
          {clockText(at)}
        </span>
        {/* Not live: its value reads "1:24 of 3:10" when a reader reaches it, never once a second (9). */}
        <input
          type="range"
          aria-label={SEEK}
          min={0}
          max={Math.max(1, Math.floor(props.boundMs / 1000))}
          step={1}
          value={Math.floor(at / 1000)}
          aria-valuetext={seekText(at, props.boundMs)}
          onPointerDown={props.onSeek.start}
          onPointerUp={props.onSeek.end}
          onPointerCancel={props.onSeek.end}
          onLostPointerCapture={props.onSeek.end}
          onChange={(e) => props.onSeek.input(Number(e.target.value) * 1000)}
          style={{ flex: 1, minWidth: 0, height: theme.touch, margin: 0, accentColor: theme.color.accent }}
        />
        <span aria-hidden style={{ ...TIME, textAlign: "right" }}>
          {clockText(props.boundMs)}
        </span>
      </div>
      {twoRows ? (
        <div style={{ display: "grid", gap: theme.space(1) }}>
          <div role="group" aria-label="Music" style={ROW}>
            {middle}
          </div>
          <div style={ROW}>
            {shuffle}
            {repeat}
          </div>
        </div>
      ) : (
        <div role="group" aria-label="Music" style={ROW}>
          {shuffle}
          {middle}
          {repeat}
        </div>
      )}
      <div data-music-foot="" style={CENTERED}>
        {props.fadeControl === "inline" ? <InlineCrossfade fade={props.fade} onPick={props.onFade} /> : <CrossfadeMenu fade={props.fade} onPick={props.onFade} />}
        <Button size="sm" icon="stop" onClick={props.onStop}>
          {STOP_MUSIC}
        </Button>
      </div>
      {stopAll}
    </div>
  );
}

/**
 * The player's line with no music. In the panel "Library" is a link button
 * in the Guide link's look that shows Library (4.2), since the line tells
 * the DM to go there. The chip's player has no Library to show (5.3).
 */
export function IdleLine(props: { onLibrary?: (() => void) | undefined }) {
  if (!props.onLibrary) return <Help>{NO_MUSIC_PLAYING}</Help>;
  return (
    <Help>
      {NO_MUSIC_PICK.before}
      <button type="button" data-music-library-link="" onClick={props.onLibrary} style={LINK}>
        {NO_MUSIC_PICK.link}
      </button>
      {NO_MUSIC_PICK.after}
    </Help>
  );
}

/**
 * Crossfade's four choices in place, a radio group named "Crossfade"
 * beside its name, as the maker's settings draw it. The choices wrap under
 * the name where the row is short, as at 130%.
 */
export function InlineCrossfade(props: { fade: Fade; onPick(fade: Fade): void }) {
  const id = useId();
  return (
    <div data-music-crossfade-inline="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: theme.space(2), minWidth: 0 }}>
      <span id={id} style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>
        {CROSSFADE}
      </span>
      <Segmented<Fade> labelledBy={id} value={props.fade} options={FADES.map((f) => ({ value: f, label: FADE_WORDS[f] }))} onChange={props.onPick} />
    </div>
  );
}

/**
 * The player, connected: the music Now playing names at the shown server
 * time, and the ops its buttons send. Seek sends `music.jump` when a drag
 * ends, and 400 ms after the slider's last key, never during a drag. A
 * seek in hand is dropped when the run or the playing track changes before
 * it is sent (4.2), and a drag under way then sends nothing at all.
 * `stopAll` adds Stop all sound's row while anything sounds, and
 * `fadeControl` and `onLibrary` are NowFullView's.
 */
export function NowFull(props: { fadeControl?: FadeControl; stopAll?: boolean; onLibrary?(): void } = {}) {
  const actions = useRoomActions();
  const jumps = useJumps();
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const playingNow = music !== null && music.paused === undefined;
  const t = useTicking(() => serverNow({ serverOffset }), playingNow);
  // Now playing names the incoming track as its crossfade starts, with no frame from the server then.
  useWakeAt(playingNow && music.next !== undefined && t < music.next.at ? music.next.at : null, t);
  const lists = queueLists(music, sounds, t);
  const shown = music ? musicShown(music, sounds, playlists, t) : null;
  const [box, width] = useWidth<HTMLDivElement>();
  const sounding = useSoundToStop();
  const stopAll = props.stopAll && sounding ? <StopAllButton /> : null;
  const [seek, setSeek] = useState<HeldSeek | null>(null);
  const latest = useRef({ seek, lists });
  latest.current = { seek, lists };
  // The gesture lives as long as the block, and sends through this render's commit, which reads the newest bound.
  const sendSeek = useRef(noop);
  const [gesture] = useState(() => seekGesture(() => sendSeek.current()));

  const held = seek !== null && seekHolds(seek, lists) ? seek : null;
  // A seek in hand made on a track or a run that no longer plays is dropped, its timer with it.
  useEffect(() => {
    if (seek === null || held !== null) return;
    gesture.drop();
    setSeek(null);
  }, [seek, held, gesture]);
  useEffect(() => gesture.drop, [gesture]);

  if (!music || !shown || !lists) {
    return (
      <div ref={box} style={{ minWidth: 0 }}>
        <NowFullView {...IDLE} shown={null} width={width} stopAll={stopAll} onLibrary={props.onLibrary} />
      </div>
    );
  }
  const boundMs = seekBoundMs(music, shown.lengthMs);
  sendSeek.current = () => {
    const { seek: now, lists: at } = latest.current;
    if (now === null || at === null || !seekHolds(now, at)) return;
    // The server holds a seek a second short of the end, so a seek always places one first occurrence (6.4). Held here too, so the prediction agrees.
    const ms = Math.max(0, Math.min(now.ms, boundMs - 1_000));
    jumps.send({ t: "music.jump", run: actions.newId(), from: at.run, soundId: now.soundId, ms, on: now.soundId });
    setSeek(null);
  };
  const onSeek: SeekEvents = {
    start: () => gesture.start(seekOn(lists)),
    end: gesture.end,
    input: (ms) => {
      if (!gesture.input(seekOn(lists))) return;
      const next = { run: lists.run, soundId: lists.playing, ms };
      setSeek(next);
      latest.current = { ...latest.current, seek: next };
    },
  };
  const queue = (edit: { t: "shuffle"; seed: string } | { t: "unshuffle" }) => send(actions, { t: "music.queue", from: lists.run, edit });
  return (
    <div ref={box} style={{ minWidth: 0 }}>
      <NowFullView
        shown={shown}
        shuffle={lists.shuffle}
        repeat={music.repeat}
        fade={music.fade}
        width={width}
        boundMs={boundMs}
        atMs={held?.ms ?? shown.positionMs}
        onSeek={onSeek}
        onShuffle={() => queue(lists.shuffle ? { t: "unshuffle" } : { t: "shuffle", seed: actions.newId() })}
        onPrevious={() => {
          // While a jump of this window's waits for its answer, the position read against the device's clock is no guide: the track counts as at its start (PLR-35).
          const target = previousTarget(lists, jumps.pending() ? 0 : shown.positionMs);
          jumps.send({ t: "music.jump", run: actions.newId(), from: lists.run, soundId: target, on: lists.playing });
        }}
        onPause={() => send(actions, { t: "music.pause" })}
        onResume={() => send(actions, { t: "music.resume", run: actions.newId() })}
        onSkip={() => send(actions, { t: "music.skip", run: actions.newId() })}
        onRepeat={() => send(actions, { t: "music.set", repeat: REPEAT_NEXT[music.repeat] })}
        onFade={(fade) => send(actions, { t: "music.set", fade })}
        onStop={() => send(actions, { t: "music.stop" })}
        fadeControl={props.fadeControl ?? "menu"}
        stopAll={stopAll}
      />
    </div>
  );
}

const noop = () => {};
const IDLE = {
  shuffle: false,
  repeat: "all" as const,
  fade: 5 as const,
  boundMs: 0,
  atMs: 0,
  onSeek: { start: noop, end: noop, input: noop },
  onShuffle: noop,
  onPrevious: noop,
  onPause: noop,
  onResume: noop,
  onSkip: noop,
  onRepeat: noop,
  onFade: noop,
  onStop: noop,
};

const BIG: CSSProperties = { minWidth: 48, minHeight: 48 };
const ROW: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: theme.space(1) };
const CENTERED: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: theme.space(2), minWidth: 0 };
/** The Guide link's look (features/guide/GuideLink.tsx), at the line's own size. */
const LINK: CSSProperties = { padding: 0, margin: 0, border: "none", background: "transparent", color: theme.color.accent, font: "inherit", textDecoration: "underline", cursor: "pointer" };
const TIME: CSSProperties = { flex: "none", minWidth: 40, fontSize: theme.font.small, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" };
const PLAY_BIG: CSSProperties = {
  flex: "none",
  width: 48,
  height: 48,
  borderRadius: theme.radius.round,
  display: "grid",
  placeItems: "center",
  border: "none",
  padding: 0,
  background: theme.color.accent,
  color: theme.color.onAccent,
  cursor: "pointer",
};
