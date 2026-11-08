import { useId, type CSSProperties } from "react";
import { Button } from "../../../components/Button.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { sectionLabelLook } from "../../../components/Panel.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import type { Playing } from "#shared/sound.ts";
import { comingNext } from "../music/dragOrder.ts";
import { NowFull, type FadeControl } from "../music/NowFull.tsx";
import { useSoundToStop, useWakeAt } from "../panel/controls.tsx";
import { DmOnlyLine, MusicVolume, nextWords, StopAllButton } from "../panel/NowPlaying.tsx";
import { send } from "../panel/ops.ts";
import { nameOf, serverNow, soundsOf, type Sounds } from "../panel/state.ts";
import { BACKGROUND, OPEN_SOUND, stopName } from "../panel/words.ts";
import { crossfadeAt } from "./NowChip.tsx";

/**
 * The Now playing chip's player (docs/design/design-v1-sound-layout.md
 * 5.3), loaded with the music's code once the chip first shows: the
 * player the Sound panel holds (NowFull), with no Library to point at,
 * Only DM devices play's reminder while the room keeps it on
 * (docs/design/design-v1-sound-dm-only.md 4), the Next line and the
 * music's volume while music plays, each background
 * sound with its Stop while any plays, then Stop all sound while anything
 * sounds and Open Sound. So with only background sounds playing the
 * player still has its reason to open. In the chip's popover Crossfade is
 * a row of its choices in place, since its menu would be a second popover
 * and close this one. The card and the sheet keep the menu. It fills its
 * container: the popover holds it to 340 px, the card and the sheet let it
 * reach their edges.
 */
export default function NowPlayer(props: { fadeControl: FadeControl; onOpenSound(): void }) {
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const sounding = useSoundToStop();
  return (
    <div data-now-player="" style={BODY}>
      <NowFull fadeControl={props.fadeControl} />
      <DmOnlyLine />
      {music ? <NextLine /> : null}
      <MusicVolume />
      <Background />
      <div data-now-foot="" style={FOOT}>
        {sounding ? <StopAllButton /> : null}
        <Button size="sm" icon="music" data-now-open-sound="" onClick={props.onOpenSound}>
          {OPEN_SOUND}
        </Button>
      </div>
    </div>
  );
}

/**
 * What follows the playing track, "Next: Tavern in the rain", as Up next's
 * folded summary says it. It changes as a crossfade starts, when the
 * incoming track becomes the one playing with no frame from the server,
 * so it renders once then and never on a tick.
 */
function NextLine() {
  const music = useRoomView((s) => s.view?.playing?.music ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const t = serverNow({ serverOffset });
  useWakeAt(crossfadeAt(music, t), t);
  const next = comingNext(music, sounds, t);
  if (!next) return null;
  return (
    <p data-now-next="" style={NEXT}>
      {nextWords(next, sounds)}
    </p>
  );
}

/** The background sounds playing, in the order they started, each by its name and its loop's id for its Stop. */
export function backgroundRows(playing: Pick<Playing, "loops"> | null, sounds: Sounds): { id: string; name: string }[] {
  if (!playing) return [];
  return Object.entries(playing.loops)
    .sort(([a, x], [b, y]) => x.at - y.at || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, loop]) => ({ id, name: nameOf(sounds[loop.soundId]) }));
}

/** Background: each background sound playing, with its Stop ("Stop Rain on the cobblestones"). Nothing while none plays. */
function Background() {
  const actions = useRoomActions();
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const id = useId();
  const rows = backgroundRows(playing, sounds);
  if (rows.length === 0) return null;
  return (
    <section data-now-background="" aria-labelledby={id} style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <h3 id={id} style={{ margin: 0, ...sectionLabelLook() }}>
        {BACKGROUND}
      </h3>
      {rows.map((row) => (
        <div key={row.id} data-now-loop="" style={ROW}>
          <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>{row.name}</span>
          <IconButton icon="stop" label={stopName(row.name)} onClick={() => send(actions, { t: "loop.stop", id: row.id })} />
        </div>
      ))}
    </section>
  );
}

const BODY: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(4), minWidth: 0 };
const NEXT: CSSProperties = { margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.textMuted, overflowWrap: "anywhere" };
const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0, minHeight: theme.touch };
const FOOT: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 };
