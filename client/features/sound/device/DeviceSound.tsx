import { Fragment, useId, useRef, type CSSProperties } from "react";
import type { IconName } from "../../../components/Icon.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Help } from "../../../components/Panel.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { theme } from "../../../lib/theme.ts";
import { useKeyHint, withKey } from "../../../state/shortcuts.ts";
import { useRoomRoleIfAny, useRoomView } from "../../../state/view.ts";
import { SOUND_MIX_DEFAULT, setSoundMix, soundMix as soundMixNow, useSoundMix, type SoundMix } from "../../device/settings.ts";
import { setSoundOn, useSoundOn } from "../../encounter/alerts.ts";
import { setSoundEnabled, usePingSound } from "../../pings/feedback.ts";
import { setRoomSound, useDeviceVolume, useServerRoomSoundState, useSoundHere, type DeviceVolume, type ServerSound, type SoundHere } from "../engine/store.ts";
import {
  ANOTHER_WINDOW,
  CANNOT_PLAY,
  DEVICE_HELP_DM,
  DEVICE_HELP_PLAYER,
  DM_PLAYS_IT,
  MUTE,
  PING_SOUND,
  PING_SOUND_HELP,
  TAP_TO_START,
  TURN_SOUND,
  TURN_SOUND_HELP,
  UNMUTE,
  VOLUME,
  volumeNote,
} from "../panel/words.ts";

/*
 * This device's sound (docs/design/design-v1-volume.md 4): one set of
 * controls for the top bar's speaker (its popover, card and sheet), This
 * device's Sounds and the Sound panel's On this device. The master Volume
 * with its mute toggle, then Music, Background and Effects, then Turn
 * sound and Ping sound, which play while muted. Mute is the stored "off"
 * of what was Room sound, and Volume a field of the stored mix.
 */

/** The speaker's and the toggle's icon: muted, low under 50%, loud from 50%. */
export function volumeIcon(v: DeviceVolume): IconName {
  return v.muted ? "muted" : v.volume < 50 ? "volumeLow" : "volume";
}

/**
 * What a move of the master slider does (5): a level unmutes and is kept,
 * and 0 mutes with the level the slider had when it was taken, so
 * unmuting returns there. `kept` is the stored level read at the
 * slider's pointerdown or focus, never the 0 a muted slider shows, so a
 * drag that goes up and back to 0 keeps the level from before it. Never 0:
 * a stored 0 would leave unmuting nothing to return to.
 */
export function volumeStep(kept: number, value: number): DeviceVolume {
  if (value > 0) return { muted: false, volume: value };
  return { muted: true, volume: kept > 0 ? kept : SOUND_MIX_DEFAULT.volume };
}

/**
 * The controls' one status line, or null (4, VOL-ASTRA-01): a player's
 * Only DM devices play wins, then waiting for a tap, another window, and a
 * browser that cannot play. Muted and playing say nothing here: the
 * toggle and the master's 0% show them.
 */
export function deviceSoundLine(s: { player: boolean; dmOnly: boolean; here: SoundHere }): string | null {
  if (s.player && s.dmOnly) return DM_PLAYS_IT;
  if (s.here === "tap") return TAP_TO_START;
  if (s.here === "other") return ANOTHER_WINDOW;
  if (s.here === "cannot") return CANNOT_PLAY;
  return null;
}

/** Music and Background hide only while the server says it offers no sound files, never while it is still asked or failed to answer, so the controls never jump when it answers (D-261108-367). */
export function mixShown(server: ServerSound): readonly MixKey[] {
  return server === "off" ? ["effects"] : ["music", "loops", "effects"];
}

type MixKey = Exclude<keyof SoundMix, "volume">;

const MIX_PARTS: Readonly<Record<MixKey, { label: string; search: string }>> = {
  music: { label: "Music", search: "menu.this-device.sounds.music" },
  loops: { label: "Background", search: "menu.this-device.sounds.loops" },
  effects: { label: "Effects", search: "menu.this-device.sounds.effects" },
};

/**
 * The controls. `line` draws the status line, where nothing above already
 * says it: the Sound panel's Now playing does, except on the DM's first
 * page while the server's switch is not on. `anchored` gives them This
 * device's search ids (features/device/search.ts), which one place alone
 * may carry.
 */
export function DeviceSound(props: { line: boolean; anchored?: boolean; keyHint?: boolean }) {
  const room = useRoomRoleIfAny();
  const volume = useDeviceVolume();
  const mix = useSoundMix();
  const server = useServerRoomSoundState();
  const turnSound = useSoundOn();
  const pingSound = usePingSound();
  const dmOnly = useRoomView((s) => s.view?.meta.settings.soundDmOnly === true);
  const { here } = useSoundHere();
  // U does what the toggle does, so its tooltip names the key as this device has it.
  const hint = useKeyHint("mute");
  // Under a dialog every key stops, so the Volume card and sheet name no key (D-261108-438).
  const muteKey = props.keyHint === false ? null : hint;
  const id = useId();
  // The level a drag or a key press started from, read from storage as it is taken.
  const kept = useRef<number | null>(null);
  const take = () => {
    kept.current = soundMixNow().volume;
  };
  const player = room?.role !== "dm";
  const line = props.line ? deviceSoundLine({ player: room?.role === "player" && !room.display, dmOnly, here }) : null;
  const shown = volume.muted ? 0 : volume.volume;
  const anchor = (search: string) => (props.anchored ? search : undefined);
  const onVolume = (value: number) => {
    const next = volumeStep(kept.current ?? soundMixNow().volume, value);
    if (next.volume !== soundMixNow().volume) setSoundMix({ ...soundMixNow(), volume: next.volume });
    // Unmuting resumes the audio inside the press: a mouse's press is the gesture, and a touch drag's release unlocks through the armed listeners now the setting wants sound.
    if (next.muted !== volume.muted) setRoomSound(!next.muted);
  };
  return (
    <div data-device-sound="" style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {line ? <Help>{line}</Help> : null}
      {/* One grid for the four, so the names share a column and the sliders start and end together. */}
      <div style={GRID}>
        <IconButton
          icon={volumeIcon(volume)}
          label={MUTE}
          title={withKey(volume.muted ? UNMUTE : MUTE, muteKey)}
          aria-keyshortcuts={muteKey?.aria}
          pressed={volume.muted}
          data-volume-mute=""
          onClick={() => setRoomSound(volume.muted)}
          // The bar's icon color while it plays. Muted, the pressed look holds.
          style={volume.muted ? { justifySelf: "start" } : { justifySelf: "start", color: theme.color.text }}
        />
        <input
          id={`${id}-volume`}
          data-search={anchor("menu.this-device.sounds.volume")}
          aria-label={VOLUME}
          aria-describedby={`${id}-help`}
          type="range"
          min={0}
          max={100}
          step={5}
          value={shown}
          aria-valuetext={volumeNote({ muted: volume.muted, volume: shown })}
          onPointerDown={take}
          onFocus={take}
          onChange={(e) => onVolume(Number(e.target.value))}
          style={RANGE}
        />
        <span aria-hidden style={PERCENT}>
          {shown}%
        </span>
        {mixShown(server).map((key) => (
          <Fragment key={key}>
            <label htmlFor={`${id}-${key}`} style={{ fontSize: theme.font.body14, color: theme.color.text }}>
              {MIX_PARTS[key].label}
            </label>
            <input
              id={`${id}-${key}`}
              data-search={anchor(MIX_PARTS[key].search)}
              type="range"
              min={0}
              max={100}
              step={5}
              value={mix[key]}
              aria-valuetext={`${mix[key]}%`}
              onChange={(e) => setSoundMix({ ...soundMixNow(), [key]: Number(e.target.value) })}
              style={RANGE}
            />
            <span aria-hidden style={PERCENT}>
              {mix[key]}%
            </span>
          </Fragment>
        ))}
      </div>
      <Help id={`${id}-help`}>{player ? DEVICE_HELP_PLAYER : DEVICE_HELP_DM}</Help>
      <div style={{ display: "grid", gap: theme.space(2), borderTop: `${theme.line.border}px solid ${theme.color.border}`, paddingTop: theme.space(2) }}>
        <Switch label={TURN_SOUND} search={anchor("menu.this-device.sounds.turn")} help={TURN_SOUND_HELP} checked={turnSound} onChange={setSoundOn} />
        <Switch label={PING_SOUND} search={anchor("menu.this-device.sounds.ping")} help={PING_SOUND_HELP} checked={pingSound} onChange={setSoundEnabled} />
      </div>
    </div>
  );
}

const GRID: CSSProperties = { display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr) 3.2em", alignItems: "center", columnGap: theme.space(3) };
const RANGE: CSSProperties = { width: "100%", minWidth: 0, height: theme.touch, margin: 0, accentColor: theme.color.accent };
const PERCENT: CSSProperties = { fontSize: theme.font.small, color: theme.color.textMuted, textAlign: "right", fontVariantNumeric: "tabular-nums" };
