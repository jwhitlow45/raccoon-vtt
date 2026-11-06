import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../../../components/Button.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Help } from "../../../components/Panel.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { seekBoundMs, type Fade, type Repeat, type SoundId } from "#shared/sound.ts";
import { useTicking, useWakeAt } from "../panel/controls.tsx";
import { send } from "../panel/ops.ts";
import { musicShown, playlistsOf, serverNow, soundsOf, type MusicShown } from "../panel/state.ts";
import { clockText, REPEAT_NAMES, REPEAT_NEXT, runLine, skipName, STOP_MUSIC } from "../panel/words.ts";
import { previousTarget, queueLists, type QueueLists } from "./dragOrder.ts";
import { useJumps } from "./jumps.ts";
import { CrossfadeMenu, useWidth } from "./parts.tsx";
import { Tile, TILE } from "./tile.ts";
import { NO_MUSIC_NOW, PREVIOUS, SEEK, seekText, SHUFFLE } from "./words.ts";

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

/**
 * When the slider sends its seek (4.2): once as a drag ends, and
 * SEEK_KEY_MS after the last value a key gave, so a held arrow sends one.
 * No timer runs inside a drag: its start disarms one a key armed just
 * before, and a value it gives arms none. `drop` disarms the timer of a
 * seek that no longer holds and leaves a drag on until the pointer lets
 * go, so the values it still gives wait for the release too. Only the
 * pointer's release ends a drag, never a key pressed while it is held:
 * the browser sends that release to the slider wherever the pointer lets
 * go. `commit` sends the seek in hand, if it still holds.
 */
export function seekGesture(commit: () => void, timers: SeekTimers = WINDOW_TIMERS) {
  let dragging = false;
  let timer: unknown = null;
  const disarm = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  return {
    start() {
      disarm();
      dragging = true;
    },
    end() {
      if (!dragging) return;
      dragging = false;
      disarm();
      commit();
    },
    input() {
      if (dragging) return;
      disarm();
      timer = timers.set(() => {
        timer = null;
        commit();
      }, SEEK_KEY_MS);
    },
    drop: disarm,
  };
}

/**
 * Now playing in the Music window (docs/design/design-v1-music-player.md
 * 4.2): the tile with the track's name and run line, the seek row, the
 * transport (Shuffle, Previous, Play or Pause, Skip, Repeat), then
 * Crossfade and Stop the music. Pure, so its states render in a test.
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
}) {
  const { shown } = props;
  if (!shown) {
    return (
      <div data-music-now="" style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
        <Help>{NO_MUSIC_NOW}</Help>
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
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: theme.space(2) }}>
        <CrossfadeMenu fade={props.fade} onPick={props.onFade} />
        <Button size="sm" icon="stop" onClick={props.onStop}>
          {STOP_MUSIC}
        </Button>
      </div>
    </div>
  );
}

/**
 * Now playing, connected: the music Now playing names at the shown server
 * time, and the ops its buttons send. Seek sends `music.jump` when a drag
 * ends, and 400 ms after the slider's last key, never during a drag. A
 * seek in hand is dropped when the run or the playing track changes before
 * it is sent (4.2).
 */
export function NowFull() {
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
      <div ref={box}>
        <NowFullView {...IDLE} shown={null} width={width} />
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
    start: gesture.start,
    end: gesture.end,
    input: (ms) => {
      const next = { run: lists.run, soundId: lists.playing, ms };
      setSeek(next);
      latest.current = { ...latest.current, seek: next };
      gesture.input();
    },
  };
  const queue = (edit: { t: "shuffle"; seed: string } | { t: "unshuffle" }) => send(actions, { t: "music.queue", from: lists.run, edit });
  return (
    <div ref={box}>
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
