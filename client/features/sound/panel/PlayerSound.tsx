import { Button } from "../../../components/Button.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomView } from "../../../state/view.ts";
import type { Playing } from "#shared/sound.ts";
import { Tile, TILE } from "../music/tile.ts";
import { DeviceSound, retryMusic, useSoundHere, type MusicHere, type SoundHere } from "./engine.ts";
import { soundsOf, type Sounds } from "./state.ts";
import { ANOTHER_WINDOW, CANNOT_PLAY, DM_PLAYS_IT, LOADING_MUSIC, MUSIC_FAILED, MUSIC_IS_PLAYING, NOTHING_PLAYING, playerLoopsLine, TAP_TO_START } from "./words.ts";

/**
 * The name the tile takes its tint from while the DM keeps the names: one
 * fixed name, so every track gets one tint and the tile says nothing the
 * projection lacks (docs/design/design-v1-sound-layout.md 7).
 */
const UNNAMED_TINT = "";

/**
 * A player's Now playing, pure (docs/design/design-v1-music.md 4.3,
 * docs/design/design-v1-sound-layout.md 7): while music plays, a card with
 * the tile and the track's name, or "Music is playing" while the DM keeps
 * the names, over the background line in muted text. Background sounds
 * alone are that line, with no card, since the card stands for the music.
 * Then how this device is doing with them. Effects show nowhere
 * (D-261102-479). A name a player's projection lacks reads as not shared,
 * so nothing here can name what the DM keeps. While Only DM devices play
 * (docs/design/design-v1-sound-dm-only.md 5), one line says the DM plays
 * it, in place of all of that and of this device's tap, other-window and
 * can't-play lines, so it reads the same whether or not anything plays.
 * These are the panel's one status line: On this device's controls below
 * draw none (docs/design/design-v1-volume.md 4).
 */
export function PlayerNow(props: { playing: Playing | null; sounds: Sounds; here: SoundHere; music: MusicHere; dmOnly: boolean; onRetry(): void }) {
  if (props.dmOnly) return <p style={QUIET}>{DM_PLAYS_IT}</p>;
  const music = props.playing?.music ?? null;
  const loops = props.playing ? Object.values(props.playing.loops) : [];
  const musicName = music ? (props.sounds[music.now.soundId]?.name ?? null) : null;
  const loopsLine = playerLoopsLine(loops.map((l) => props.sounds[l.soundId]?.name ?? null));
  return (
    <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {music ? (
        <div data-sound-player-card="" style={{ display: "flex", alignItems: "center", gap: theme.space(3), minWidth: 0 }}>
          <Tile name={musicName ?? UNNAMED_TINT} size={TILE.group} />
          <div style={{ flex: 1, display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
            <span data-sound-player-music="" style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
              {musicName ?? MUSIC_IS_PLAYING}
            </span>
            {loopsLine ? (
              <span data-sound-player-loops="" style={{ fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.textMuted, overflowWrap: "anywhere" }}>
                {loopsLine}
              </span>
            ) : null}
          </div>
        </div>
      ) : loopsLine ? (
        <p data-sound-player-loops="" style={{ margin: 0, fontSize: theme.font.input, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
          {loopsLine}
        </p>
      ) : null}
      {!music && !loopsLine ? <p style={QUIET}>{NOTHING_PLAYING}</p> : null}
      {music && props.here === "plays" && props.music === "loading" ? <Loading text={LOADING_MUSIC} small delay={0} /> : null}
      {music && props.here === "plays" && props.music === "failed" ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
          <Help>{MUSIC_FAILED}</Help>
          <Button size="sm" icon="retry" onClick={props.onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {props.here === "tap" ? <Help>{TAP_TO_START}</Help> : null}
      {props.here === "other" ? <Help>{ANOTHER_WINDOW}</Help> : null}
      {props.here === "cannot" ? <Help>{CANNOT_PLAY}</Help> : null}
    </div>
  );
}

/** A player's Sound panel: Now playing and On this device (4.3). While it stays open after the music and background stop, Now playing says nothing is playing. */
export function PlayerSound() {
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const dmOnly = useRoomView((s) => s.view?.meta.settings.soundDmOnly === true);
  const { here, music } = useSoundHere();
  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <Section label="Now playing" divider={false}>
        <PlayerNow playing={playing} sounds={sounds} here={here} music={music} dmOnly={dmOnly} onRetry={retryMusic} />
      </Section>
      <Section label="On this device">
        <DeviceSound line={false} />
      </Section>
    </div>
  );
}

/** "Nothing is playing." and the DM's line in its place: one muted line. */
const QUIET = { margin: 0, fontSize: theme.font.body14, color: theme.color.textMuted } as const;
