import type { CSSProperties } from "react";
import { Button } from "../../../components/Button.tsx";
import { Help } from "../../../components/Panel.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { SettingRow } from "../../../components/SettingRow.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomScope, useScoped } from "../../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import { seekBoundMs, type Playing } from "#shared/sound.ts";
import { backgroundCount, SCENE_SOUND, SCENE_SOUND_OPEN } from "../../ambiance/words.ts";
import { usePanelHere } from "../../panels.ts";
import { openSceneSettings } from "../../scenes/request.ts";
import { comingNext, type ComingNext } from "../music/dragOrder.ts";
import { openMusicWindow, musicWindowSlot } from "../music/open.ts";
import { Tile, TILE } from "../music/tile.ts";
import { LAST_TRACK, NEXT_AGAIN, nextLine, OPEN_MUSIC } from "../music/words.ts";
import { Actions, useSoundToStop, useTicking, useWakeAt, VolumeSlider } from "./controls.tsx";
import { useSoundHere } from "./engine.ts";
import { send } from "./ops.ts";
import { musicShown, nameOf, playlistsOf, sceneSoundFrom, sceneSoundNames, serverNow, somethingPlays, soundsOf, type MusicShown, type Sounds } from "./state.ts";
import {
  ANOTHER_WINDOW,
  CLEAR,
  DEVICE_SILENT,
  EFFECTS_VOLUME,
  loopVolumeName,
  MUSIC_VOLUME,
  NAMES_HELP,
  NAMES_SWITCH,
  NOTHING_PLAYING,
  PLAY_FIRST,
  PLAY_IT,
  runLine,
  SCENE_HELP,
  sceneLine,
  skipName,
  STOP_ALL,
  stopName,
  timeShown,
  USE_PLAYING,
  USE_SILENCE,
} from "./words.ts";

/**
 * The Sound group's music (docs/design/design-v1-music-player.md 3.1): the
 * tile, the track's name, its run line and the read-only Next line, then
 * Pause or Play, Skip and Open music, which wraps under them where the row
 * is short, then the bar and the time. Stop the music and Repeat live in
 * the Music window. Pure, so its states render in a test. `lengthMs` is
 * the time's end: the track's length, or one pass under Repeat one with a
 * crossfade, as the window's seek bar reads it.
 */
export function MusicNow(props: { music: MusicShown; next: string; lengthMs: number; onPause(): void; onResume(): void; onSkip(): void; onOpen(): void }) {
  const { music } = props;
  const at = Math.min(music.positionMs, props.lengthMs);
  const time = timeShown(at, props.lengthMs);
  const fraction = props.lengthMs > 0 ? Math.min(1, at / props.lengthMs) : 0;
  return (
    <div data-sound-now="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(3), minWidth: 0 }}>
        <Tile name={music.name} size={TILE.group} />
        <div style={{ flex: 1, display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
          <span data-sound-track="" style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
            {music.name}
          </span>
          <span data-sound-run="" style={{ fontSize: theme.font.body14, color: theme.color.textMuted, overflowWrap: "anywhere" }}>
            {runLine(music)}
          </span>
          {/* Plain text, not live: it changes with each track, which the DM reads at a glance. */}
          <span data-sound-next="" style={{ fontSize: theme.font.body14, color: theme.color.textMuted, overflowWrap: "anywhere" }}>
            {props.next}
          </span>
        </div>
      </div>
      {/*
       * Above the time and its bar, so Pause sits inside a phone's half sheet at Ambiance's start
       * (docs/design/design-v1-panel-groups.md 4.1, D-261102-767). Open music keeps the row's end and wraps under the two where it is short.
       */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
        <div role="group" aria-label="Music" style={{ display: "flex", gap: theme.space(2) }}>
          {music.paused ? <IconButton icon="play" label="Play" onClick={props.onResume} /> : <IconButton icon="pause" label="Pause" onClick={props.onPause} />}
          <IconButton icon="skip" label={skipName(music.crossingInto)} onClick={props.onSkip} />
        </div>
        <OpenMusic onOpen={props.onOpen} style={{ marginLeft: "auto" }} />
      </div>
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <div aria-hidden style={{ height: 4, borderRadius: theme.radius.pill, background: theme.color.border, overflow: "hidden" }}>
          <div style={{ width: `${fraction * 100}%`, height: "100%", background: theme.color.accent }} />
        </div>
        {/* Not live: a screen reader reads the time when it reaches it, never once a second. */}
        <span data-sound-time="" aria-label={time.spoken} style={{ fontSize: theme.font.body14, fontVariantNumeric: "tabular-nums", color: theme.color.textMuted }}>
          {time.text}
        </span>
      </div>
    </div>
  );
}

/** Open music (3.1), which focus comes back to as the window closes, found by its mark since a resize can remount it. */
export function OpenMusic(props: { onOpen(): void; style?: CSSProperties }) {
  return (
    <Button size="sm" icon="music" data-music-open="" onClick={props.onOpen} style={props.style}>
      {OPEN_MUSIC}
    </Button>
  );
}

/** The Next line's words (3.1): the track that follows, this one again, or the last. */
export function nextWords(next: ComingNext, sounds: Sounds): string {
  if (next.t === "last") return LAST_TRACK;
  if (next.t === "again") return NEXT_AGAIN;
  return nextLine(nameOf(sounds[next.soundId]));
}

/**
 * The scene's sound line (4.1, 4.6) for the scene on the DM's screen, with
 * what each state offers. Pure.
 */
export function SceneSoundLine(props: {
  sceneName: string;
  sound: { names: string[] } | null;
  canUsePlaying: boolean;
  onPlay(): void;
  onUsePlaying(): void;
  onUseSilence(): void;
  onClear(): void;
  helpId: string;
}) {
  return (
    <div data-sound-scene="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <p style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>{sceneLine(props.sceneName, props.sound)}</p>
      <Actions>
        {props.sound !== null ? (
          <Button size="sm" icon="play" onClick={props.onPlay}>
            {PLAY_IT}
          </Button>
        ) : null}
        <Button size="sm" disabled={!props.canUsePlaying} aria-describedby={props.canUsePlaying ? props.helpId : `${props.helpId}-first`} onClick={props.onUsePlaying}>
          {USE_PLAYING}
        </Button>
        <Button size="sm" onClick={props.onUseSilence}>
          {USE_SILENCE}
        </Button>
        {props.sound !== null ? (
          <Button size="sm" onClick={props.onClear}>
            {CLEAR}
          </Button>
        ) : null}
      </Actions>
      {props.canUsePlaying ? null : <Help id={`${props.helpId}-first`}>{PLAY_FIRST}</Help>}
      <Help id={props.helpId}>{SCENE_HELP}</Help>
    </div>
  );
}

/**
 * The DM's Now playing (docs/design/design-v1-panel-groups.md 4.1, D-261102-766):
 * the music block, then Stop all sound while anything sounds, and a line
 * when this device plays nothing. Each a part of its own, so a later
 * player can take the music block's place alone. The volumes for everyone
 * and the scene's sound follow Effects, under What players hear
 * (WhatPlayersHear).
 */
export function NowPlaying() {
  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <MusicBlock />
      <StopAllSound />
      <DeviceLine />
    </div>
  );
}

/** The music and its buttons, else how many background sounds play, else that nothing does, each with Open music. */
export function MusicBlock() {
  const actions = useRoomActions();
  const musicWindow = useScoped(musicWindowSlot);
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const music = playing?.music ?? null;
  const t = useTicking(() => serverNow({ serverOffset }), music !== null && music.paused === undefined);
  // The Next line changes as a crossfade starts, with no frame from the server then.
  useWakeAt(music?.next !== undefined && music.paused === undefined && t < music.next.at ? music.next.at : null, t);
  const shown = music ? musicShown(music, sounds, playlists, t) : null;
  const next = comingNext(music, sounds, t);
  const loops = playing ? Object.keys(playing.loops).length : 0;
  const open = () => openMusicWindow(musicWindow, music !== null);
  if (!shown || !music || !next) {
    return (
      <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
        <NowLine loops={loops} />
        <div style={{ display: "flex" }}>
          <OpenMusic onOpen={open} />
        </div>
      </div>
    );
  }
  return (
    <MusicNow
      music={shown}
      next={nextWords(next, sounds)}
      lengthMs={seekBoundMs(music, shown.lengthMs)}
      onPause={() => send(actions, { t: "music.pause" })}
      onResume={() => send(actions, { t: "music.resume", run: actions.newId() })}
      onSkip={() => send(actions, { t: "music.skip", run: actions.newId() })}
      onOpen={open}
    />
  );
}

/** Stop all sound, while anything sounds (useSoundToStop). */
export function StopAllSound() {
  const anything = useSoundToStop();
  if (!anything) return null;
  return (
    <Actions>
      <StopAllButton />
    </Actions>
  );
}

/** Stop all sound's button, for a row that shows it only while anything sounds: here, and under the player (music/NowFull.tsx). */
export function StopAllButton() {
  const actions = useRoomActions();
  return (
    <Button size="sm" variant="danger" icon="stop" onClick={() => send(actions, { t: "sound.stopAll" })}>
      {STOP_ALL}
    </Button>
  );
}

/** What this device's playback needs said: another window plays it, or this device plays nothing. */
export function DeviceLine() {
  const { here } = useSoundHere();
  if (here === "other") return <Help>{ANOTHER_WINDOW}</Help>;
  if (here === "plays" || here === "tap") return null;
  return <Help>{DEVICE_SILENT}</Help>;
}

/** Now playing's line with no music: the background sounds playing, or nothing. Pure. */
export function NowLine(props: { loops: number }) {
  return <p style={{ margin: 0, fontSize: theme.font.body14, color: props.loops > 0 ? theme.color.text : theme.color.textMuted }}>{props.loops > 0 ? backgroundCount(props.loops) : NOTHING_PLAYING}</p>;
}

/**
 * What players hear (D-261102-766): the volumes for everyone, each
 * background sound's with its Stop, the Scene sound row and Use what's
 * playing (docs/design/design-v1-scenes-reorg.md 5), and the names switch.
 */
export function WhatPlayersHear() {
  const actions = useRoomActions();
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const music = playing?.music ?? null;
  const loops = playing ? Object.entries(playing.loops) : [];
  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <MusicVolume />
      {loops.map(([id, loop]) => {
        const name = nameOf(sounds[loop.soundId]);
        return (
          <VolumeSlider
            key={id}
            label={loopVolumeName(name)}
            value={loop.volume}
            onChange={(v) => send(actions, { t: "loop.set", id, volume: v })}
            trailing={<IconButton icon="stop" label={stopName(name)} onClick={() => send(actions, { t: "loop.stop", id })} />}
          />
        );
      })}
      <VolumeSlider label={EFFECTS_VOLUME} value={playing?.volume.effects ?? 100} onChange={(v) => send(actions, { t: "sound.mix", effects: v })} />
      <SceneSoundRow playing={playing} />
      <NamesSwitch />
    </div>
  );
}

/**
 * The scene's own sound, as Ambiance shows it (docs/design/design-v1-scenes-reorg.md 5):
 * a row that opens the Scene sound group in Scenes, its help the scene's
 * line, then Use what's playing, which saves what plays now into the
 * scene in view and is described by the same line, so it says which
 * scene. Play it, Use silence and Clear live in Scenes. Pure.
 */
export function SceneSoundShortcut(props: { sceneName: string; sound: { names: string[] } | null; canUsePlaying: boolean; lineId: string; onOpen(): void; onUsePlaying(): void }) {
  const firstId = `${props.lineId}-first`;
  return (
    <div data-sound-scene="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <SettingRow name={SCENE_SOUND} label={SCENE_SOUND_OPEN} help={<span id={props.lineId}>{sceneLine(props.sceneName, props.sound)}</span>} onOpen={props.onOpen} />
      <Actions>
        <Button size="sm" disabled={!props.canUsePlaying} aria-describedby={props.canUsePlaying ? props.lineId : `${props.lineId} ${firstId}`} onClick={props.onUsePlaying}>
          {USE_PLAYING}
        </Button>
      </Actions>
      {props.canUsePlaying ? null : <Help id={firstId}>{PLAY_FIRST}</Help>}
    </div>
  );
}

function SceneSoundRow(props: { playing: Playing | null }) {
  const actions = useRoomActions();
  const scope = useRoomScope();
  const ui = useRoomUi();
  const store = useRoomStore();
  const here = usePanelHere();
  const scene = useRoomView((s) => (s.sceneId ? (s.view?.scenes[s.sceneId] ?? null) : null));
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  if (!scene) return null;
  const sound = scene.sound ?? null;
  return (
    <SceneSoundShortcut
      sceneName={scene.name}
      sound={sound ? { names: sceneSoundNames(sound, playlists, sounds) } : null}
      canUsePlaying={somethingPlays(props.playing)}
      lineId={`sound-scene-${scene.id}`}
      onOpen={() => openSceneSettings(scope, ui, "sound", { from: here, room: store })}
      onUsePlaying={() => send(actions, { t: "scene.update", sceneId: scene.id, patch: { sound: sceneSoundFrom(props.playing, playlists) } })}
    />
  );
}

/** The music's volume for everyone while music plays, here and in the Music window's Now playing (docs/design/design-v1-music-player.md 3.1), one setting. */
export function MusicVolume() {
  const actions = useRoomActions();
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const volume = useRoomView((s) => s.view?.playing?.volume.music ?? 100);
  if (!music) return null;
  return <VolumeSlider label={MUSIC_VOLUME} value={volume} onChange={(v) => send(actions, { t: "sound.mix", music: v })} />;
}

/** Players see what is playing, here and in the Music window, one setting. */
export function NamesSwitch() {
  const actions = useRoomActions();
  const on = useRoomView((s) => s.view?.meta.settings.soundNames === true);
  return <Switch label={NAMES_SWITCH} help={NAMES_HELP} checked={on} onChange={(next) => send(actions, { t: "room.update", settings: { soundNames: next } })} />;
}
