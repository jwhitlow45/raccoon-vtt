import { Button } from "../../../components/Button.tsx";
import { Help } from "../../../components/Panel.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import type { Playing } from "#shared/sound.ts";
import type { ComingNext } from "../music/dragOrder.ts";
import { LAST_TRACK, NEXT_AGAIN, nextLine } from "../music/words.ts";
import { Actions, useHearers, VolumeSlider } from "./controls.tsx";
import { setRoomSound, useSoundHere, type SoundHere } from "./engine.ts";
import { send } from "./ops.ts";
import { nameOf, playlistsOf, sceneSoundFrom, sceneSoundNames, somethingPlays, soundsOf, type Sounds } from "./state.ts";
import {
  ANOTHER_WINDOW,
  CANNOT_PLAY,
  CLEAR,
  DEVICE_MUTED,
  DM_ONLY_HELP,
  DM_ONLY_ON,
  DM_ONLY_SWITCH,
  EFFECTS_LABEL,
  effectsVolume,
  loopVolumeName,
  MUSIC_LABEL,
  musicVolume,
  NAMES_HELP,
  NAMES_SWITCH,
  PLAY_FIRST,
  PLAY_IT,
  SCENE_HELP,
  sceneLine,
  STOP_ALL,
  stopName,
  TABLE_SOUND_HELP,
  TAP_TO_START,
  UNMUTE,
  USE_PLAYING,
  USE_SILENCE,
} from "./words.ts";

/*
 * The parts of the DM's Sound panel around the player
 * (docs/design/design-v1-sound-layout.md 4.2): Stop all sound, the device
 * line, Only DM devices play's reminder, Table sound with Use what's
 * playing, the music's volume, the names switch and Only DM devices play,
 * and the Next line's words. The Now playing chip's player (5.3,
 * mini/NowPlayer.tsx) draws Stop all sound, the reminder, the music's
 * volume and the Next line from here too. Scenes draws the scene's sound line
 * (SceneSoundLine) in its Scene sound group.
 */

/** The Next line's words: the track that follows, this one again, or the last. Up next's folded summary (docs/design/design-v1-sound-layout.md 4.3) and the chip player's Next line (5.3). */
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

/** Stop all sound's button, for a row that shows it only while anything sounds (useSoundToStop): under the panel's player (music/NowFull.tsx), and at the foot of the chip's (mini/NowPlayer.tsx). */
export function StopAllButton(props: { search?: string } = {}) {
  const actions = useRoomActions();
  return (
    <Button size="sm" variant="danger" icon="stop" search={props.search} onClick={() => send(actions, { t: "sound.stopAll" })}>
      {STOP_ALL}
    </Button>
  );
}

/**
 * What the DM's Now playing says of this device's playback
 * (docs/design/design-v1-volume.md 6): muted, with Unmute, waiting for a
 * tap, a browser that can't play, or another window that plays it. Its one
 * status line, since On this device's controls below draw none here, so
 * the tap line is here too (VOL-OPUS-19), where it once said nothing.
 */
export function DeviceLine() {
  const { here } = useSoundHere();
  return <DeviceLineView here={here} onUnmute={() => setRoomSound(true)} />;
}

/** DeviceLine, pure. Unmute is a link button in the line, as Library is in the idle line (music/NowFull.tsx IdleLine), which unmutes inside its click. */
export function DeviceLineView(props: { here: SoundHere; onUnmute(): void }) {
  if (props.here === "tap") return <Help>{TAP_TO_START}</Help>;
  if (props.here === "other") return <Help>{ANOTHER_WINDOW}</Help>;
  if (props.here === "cannot") return <Help>{CANNOT_PLAY}</Help>;
  if (props.here !== "off") return null;
  return (
    <Help>
      {DEVICE_MUTED}{" "}
      <button type="button" data-sound-unmute="" onClick={props.onUnmute} style={LINK}>
        {UNMUTE}
      </button>
    </Help>
  );
}

/** The Guide link's look (features/guide/GuideLink.tsx), at the line's own size. */
const LINK = { padding: 0, margin: 0, border: "none", background: "transparent", color: theme.color.accent, font: "inherit", textDecoration: "underline", cursor: "pointer" } as const;

/**
 * Only DM devices play's reminder (docs/design/design-v1-sound-dm-only.md
 * 4), while the room keeps it on, with nothing playing too: the room keeps
 * it until the DM turns it off, so a game played apart would otherwise
 * start silent on every player's device with nothing on the DM's screen
 * saying why. Plain help, not live, as no change of sound says anything
 * aloud.
 */
export function DmOnlyLine() {
  const on = useRoomView((s) => s.view?.meta.settings.soundDmOnly === true);
  return on ? <Help>{DM_ONLY_ON}</Help> : null;
}

/**
 * Table sound, once What players hear (D-261102-766,
 * docs/design/design-v1-sound-layout.md 4.2 and 7): its help, then the
 * volumes for everyone, the music's, each background sound's with its
 * Stop and the effects', then the scene's line with Use what's playing
 * (6.2), the names switch and Only DM devices play
 * (docs/design/design-v1-sound-dm-only.md 4). Each slider shows a plain name, "Music", the
 * sound's or "Effects", since the help says once that these are for every
 * device, and keeps "volume for everyone" in its accessible name, except
 * while only the DM's devices sound it (`useHearers`).
 */
export function TableSound() {
  const actions = useRoomActions();
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const hearers = useHearers();
  const loops = playing ? Object.entries(playing.loops) : [];
  return (
    <div data-sound-table="" style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <Help>{TABLE_SOUND_HELP}</Help>
      <MusicVolume label={MUSIC_LABEL} />
      {loops.map(([id, loop]) => {
        const name = nameOf(sounds[loop.soundId]);
        return (
          <VolumeSlider
            key={id}
            label={name}
            name={loopVolumeName(name, hearers)}
            value={loop.volume}
            onChange={(v) => send(actions, { t: "loop.set", id, volume: v })}
            trailing={<IconButton icon="stop" label={stopName(name)} onClick={() => send(actions, { t: "loop.stop", id })} />}
          />
        );
      })}
      <VolumeSlider label={EFFECTS_LABEL} name={effectsVolume(hearers)} value={playing?.volume.effects ?? 100} onChange={(v) => send(actions, { t: "sound.mix", effects: v })} />
      <SceneSoundUse playing={playing} />
      <NamesSwitch />
      <DmOnlySwitch />
    </div>
  );
}

/**
 * Use what's playing (docs/design/design-v1-sound-layout.md 6.2), an
 * action beside what plays: it saves what plays now into the scene on the
 * DM's screen. The scene's line is plain help over it and describes it,
 * so it says which scene, and "Play something first." says why it is off.
 * No row opens Scenes: Play it, Use silence and Clear live there, in its
 * Scene sound group. Pure.
 */
export function UseWhatsPlaying(props: { sceneName: string; sound: { names: string[] } | null; canUsePlaying: boolean; lineId: string; onUsePlaying(): void }) {
  const firstId = `${props.lineId}-first`;
  return (
    <div data-sound-scene="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <Help id={props.lineId}>{sceneLine(props.sceneName, props.sound)}</Help>
      <Actions>
        <Button size="sm" disabled={!props.canUsePlaying} aria-describedby={props.canUsePlaying ? props.lineId : `${props.lineId} ${firstId}`} onClick={props.onUsePlaying}>
          {USE_PLAYING}
        </Button>
      </Actions>
      {props.canUsePlaying ? null : <Help id={firstId}>{PLAY_FIRST}</Help>}
    </div>
  );
}

/** Use what's playing for the scene on the DM's screen, none with no scene in view. */
function SceneSoundUse(props: { playing: Playing | null }) {
  const actions = useRoomActions();
  const scene = useRoomView((s) => (s.sceneId ? (s.view?.scenes[s.sceneId] ?? null) : null));
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  if (!scene) return null;
  const sound = scene.sound ?? null;
  return (
    <UseWhatsPlaying
      sceneName={scene.name}
      sound={sound ? { names: sceneSoundNames(sound, playlists, sounds) } : null}
      canUsePlaying={somethingPlays(props.playing)}
      lineId={`sound-scene-${scene.id}`}
      onUsePlaying={() => send(actions, { t: "scene.update", sceneId: scene.id, patch: { sound: sceneSoundFrom(props.playing, playlists) } })}
    />
  );
}

/**
 * The music's volume for everyone while music plays, one setting, in Table
 * sound and the chip's player (docs/design/design-v1-sound-layout.md 5.3).
 * `label` is the visible name, "Music" under Table sound's help, and the
 * accessible name says whose volume it is ("for everyone"), or just "Music
 * volume" while only the DM's devices sound it. The chip's player has no
 * heading that says so, so there it shows the whole name.
 */
export function MusicVolume(props: { label?: string } = {}) {
  const actions = useRoomActions();
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const volume = useRoomView((s) => s.view?.playing?.volume.music ?? 100);
  const hearers = useHearers();
  if (!music) return null;
  return <VolumeSlider label={props.label ?? musicVolume(hearers)} name={musicVolume(hearers)} value={volume} onChange={(v) => send(actions, { t: "sound.mix", music: v })} />;
}

/** Players see what is playing, one setting, in Table sound. */
export function NamesSwitch() {
  const actions = useRoomActions();
  const on = useRoomView((s) => s.view?.meta.settings.soundNames === true);
  return <Switch label={NAMES_SWITCH} search="sound.table.names" help={NAMES_HELP} checked={on} onChange={(next) => send(actions, { t: "room.update", settings: { soundNames: next } })} />;
}

/**
 * Only DM devices play (docs/design/design-v1-sound-dm-only.md 4), one
 * setting: last in Table sound, and alone in the Table sound the panel
 * shows while the server's switch is off, since the built-in effects
 * still play on players' devices then, and a room may keep it from
 * before the switch went off. Players see what is playing stays as it is
 * beside it, keeping its value for a game played apart (D-261107-245).
 */
export function DmOnlySwitch() {
  const actions = useRoomActions();
  const on = useRoomView((s) => s.view?.meta.settings.soundDmOnly === true);
  return <Switch label={DM_ONLY_SWITCH} search="sound.table.dmonly" help={DM_ONLY_HELP} checked={on} onChange={(next) => send(actions, { t: "room.update", settings: { soundDmOnly: next } })} />;
}
