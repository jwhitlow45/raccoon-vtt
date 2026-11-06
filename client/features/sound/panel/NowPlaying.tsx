import { Button } from "../../../components/Button.tsx";
import { Help } from "../../../components/Panel.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { SettingRow } from "../../../components/SettingRow.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomScope } from "../../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import type { Playing } from "#shared/sound.ts";
import { backgroundCount, SCENE_SOUND, SCENE_SOUND_OPEN } from "../../ambiance/words.ts";
import { usePanelHere } from "../../panels.ts";
import { openSceneSettings } from "../../scenes/request.ts";
import { Actions, useSoundToStop, useTicking, VolumeSlider } from "./controls.tsx";
import { useSoundHere } from "./engine.ts";
import { send } from "./ops.ts";
import { musicShown, nameOf, playlistsOf, sceneSoundFrom, sceneSoundNames, serverNow, somethingPlays, soundsOf, type MusicShown } from "./state.ts";
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
  REPEAT_NAMES,
  REPEAT_NEXT,
  runLine,
  SCENE_HELP,
  sceneLine,
  skipName,
  STOP_ALL,
  STOP_MUSIC,
  stopName,
  timeShown,
  USE_PLAYING,
  USE_SILENCE,
} from "./words.ts";

/**
 * The music's name, its place, the four buttons, then its time over a thin
 * bar (docs/design/design-v1-music.md 4.1). Pure, so its states render in a
 * test.
 */
export function MusicNow(props: {
  music: MusicShown;
  repeat: keyof typeof REPEAT_NAMES;
  onPause(): void;
  onResume(): void;
  onSkip(): void;
  onStop(): void;
  onRepeat(): void;
}) {
  const { music } = props;
  const time = timeShown(music.positionMs, music.lengthMs);
  const fraction = music.lengthMs > 0 ? Math.min(1, music.positionMs / music.lengthMs) : 0;
  return (
    <div data-sound-now="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <div style={{ display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
        <span data-sound-track="" style={{ fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
          {music.name}
        </span>
        <span data-sound-run="" style={{ fontSize: theme.font.body14, color: theme.color.textMuted, overflowWrap: "anywhere" }}>
          {runLine(music)}
        </span>
      </div>
      {/*
       * One row at every size, 320 px at 130% included (10): four 44 px icons fit in 176 px. Above the time and its
       * bar, so Pause sits inside a phone's half sheet at Ambiance's start (docs/design/design-v1-panel-groups.md 4.1, D-261102-767).
       */}
      <div role="group" aria-label="Music" style={{ display: "flex", gap: theme.space(2), flexWrap: "nowrap" }}>
        {music.paused ? <IconButton icon="play" label="Play" onClick={props.onResume} /> : <IconButton icon="pause" label="Pause" onClick={props.onPause} />}
        <IconButton icon="skip" label={skipName(music.crossingInto)} onClick={props.onSkip} />
        <IconButton icon="stop" label={STOP_MUSIC} onClick={props.onStop} />
        <IconButton icon={props.repeat === "one" ? "repeatOne" : "again"} label={REPEAT_NAMES[props.repeat]} pressed={props.repeat !== "off"} onClick={props.onRepeat} />
      </div>
      <div style={{ display: "grid", gap: theme.space(1) }}>
        {/* Not live: a screen reader reads the time when it reaches it, never once a second. */}
        <span data-sound-time="" aria-label={time.spoken} style={{ fontSize: theme.font.body14, fontVariantNumeric: "tabular-nums", color: theme.color.textMuted }}>
          {time.text}
        </span>
        <div aria-hidden style={{ height: 4, borderRadius: theme.radius.pill, background: theme.color.border, overflow: "hidden" }}>
          <div style={{ width: `${fraction * 100}%`, height: "100%", background: theme.color.accent }} />
        </div>
      </div>
    </div>
  );
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

/** The music and its buttons, else how many background sounds play, else that nothing does. */
export function MusicBlock() {
  const actions = useRoomActions();
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const music = playing?.music ?? null;
  const t = useTicking(() => serverNow({ serverOffset }), music !== null && music.paused === undefined);
  const shown = music ? musicShown(music, sounds, playlists, t) : null;
  const loops = playing ? Object.keys(playing.loops).length : 0;
  if (!shown || !music) return <NowLine loops={loops} />;
  return (
    <MusicNow
      music={shown}
      repeat={music.repeat}
      onPause={() => send(actions, { t: "music.pause" })}
      onResume={() => send(actions, { t: "music.resume", run: actions.newId() })}
      onSkip={() => send(actions, { t: "music.skip", run: actions.newId() })}
      onStop={() => send(actions, { t: "music.stop" })}
      onRepeat={() => send(actions, { t: "music.set", repeat: REPEAT_NEXT[music.repeat] })}
    />
  );
}

/** Stop all sound, while anything sounds (useSoundToStop). */
export function StopAllSound() {
  const actions = useRoomActions();
  const anything = useSoundToStop();
  if (!anything) return null;
  return (
    <Actions>
      <Button size="sm" variant="danger" icon="stop" onClick={() => send(actions, { t: "sound.stopAll" })}>
        {STOP_ALL}
      </Button>
    </Actions>
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
      {music ? <VolumeSlider label={MUSIC_VOLUME} value={playing?.volume.music ?? 100} onChange={(v) => send(actions, { t: "sound.mix", music: v })} /> : null}
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

function NamesSwitch() {
  const actions = useRoomActions();
  const on = useRoomView((s) => s.view?.meta.settings.soundNames === true);
  return <Switch label={NAMES_SWITCH} help={NAMES_HELP} checked={on} onChange={(next) => send(actions, { t: "room.update", settings: { soundNames: next } })} />;
}
