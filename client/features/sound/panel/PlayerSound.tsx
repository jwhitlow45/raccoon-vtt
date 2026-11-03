import { Button } from "../../../components/Button.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomView } from "../../../state/view.ts";
import type { Playing } from "#shared/sound.ts";
import { RoomSoundControls, retryMusic, useSoundHere, type MusicHere, type SoundHere } from "./engine.ts";
import { soundsOf, type Sounds } from "./state.ts";
import { ANOTHER_WINDOW, LOADING_MUSIC, MUSIC_FAILED, NOTHING_PLAYING, playerLoopsLine, playerMusicLine, TAP_TO_START } from "./words.ts";

/**
 * A player's Now playing, pure (docs/design/design-v1-music.md 4.3): the
 * music and background sounds by name while the DM shares names, else
 * how many play, and how this device is doing with them. Effects show
 * nowhere (D-261102-479). A name a player's projection lacks reads as not
 * shared, so nothing here can name what the DM keeps.
 */
export function PlayerNow(props: { playing: Playing | null; sounds: Sounds; here: SoundHere; music: MusicHere; onRetry(): void }) {
  const music = props.playing?.music ?? null;
  const loops = props.playing ? Object.values(props.playing.loops) : [];
  const musicName = music ? (props.sounds[music.now.soundId]?.name ?? null) : null;
  const loopsLine = playerLoopsLine(loops.map((l) => props.sounds[l.soundId]?.name ?? null));
  const line = (text: string, attr: string) => (
    <p {...{ [attr]: "" }} style={{ margin: 0, fontSize: theme.font.input, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
      {text}
    </p>
  );
  return (
    <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {music ? line(playerMusicLine(musicName), "data-sound-player-music") : null}
      {loopsLine ? line(loopsLine, "data-sound-player-loops") : null}
      {!music && !loopsLine ? <p style={{ margin: 0, fontSize: theme.font.body14, color: theme.color.textMuted }}>{NOTHING_PLAYING}</p> : null}
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
    </div>
  );
}

/** A player's Sound panel: Now playing and On this device (4.3). */
export function PlayerSound() {
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const { here, music } = useSoundHere();
  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <Section label="Now playing" divider={false}>
        <PlayerNow playing={playing} sounds={sounds} here={here} music={music} onRetry={retryMusic} />
      </Section>
      <Section label="On this device">
        <RoomSoundControls />
      </Section>
    </div>
  );
}
