import type { ReactNode } from "react";
import { useStore } from "zustand";
import { Dialog } from "../../../components/Dialog.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { useBackClose } from "../../../lib/backClose.ts";
import { theme } from "../../../lib/theme.ts";
import { useScoped } from "../../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { useLayoutSize } from "../../device/layout.ts";
import { MusicVolume, NamesSwitch } from "../panel/NowPlaying.tsx";
import { send } from "../panel/ops.ts";
import { nameOf, playlistsOf, soundsOf } from "../panel/state.ts";
import { SoundPage } from "../panel/SoundPage.tsx";
import { JumpsScope } from "./jumps.ts";
import { Library } from "./Library.tsx";
import { draftOf, MakerBody, newDraft, useMakerControl } from "./Maker.tsx";
import { NowFull } from "./NowFull.tsx";
import { closeMusicWindow, musicWindowSlot, type MakerDraft, type MusicStep, type MusicTab } from "./open.ts";
import { UpNext } from "./UpNext.tsx";
import { BACK_TO_MUSIC, LIBRARY_TAB, MUSIC_TABS, MUSIC_TITLE, NEW_PLAYLIST, NOW_TAB } from "./words.ts";

/** From this layout width the card is 880 px or more, room for Library beside Now playing (4.1). */
export const WIDE_LAYOUT_PX = 912;

/** Where focus goes back on close: Open music, found afresh, since a resize across 900 px remounts the panel that holds it. */
const OPEN_MUSIC_BUTTON = {
  get current(): HTMLElement | null {
    return document.querySelector<HTMLElement>("[data-music-open]");
  },
};

/**
 * The Music window (docs/design/design-v1-music-player.md 3.2, 4 and 5):
 * on a computer a 1040 px dialog with Library beside Now playing and Up
 * next, on a phone the tall sheet with two tabs. The maker and a track's
 * page are steps of it, back "Music". Its state is the Room scope's slot
 * (open.ts), so a remount keeps the step and the draft. It loads on its
 * own (MusicWindowHost.tsx), the DM's alone.
 */
export default function MusicWindow() {
  const actions = useRoomActions();
  return (
    <JumpsScope actions={actions}>
      <MusicDialog />
    </JumpsScope>
  );
}

function MusicDialog() {
  const actions = useRoomActions();
  const slot = useScoped(musicWindowSlot);
  const state = useStore(slot);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const scenes = useRoomView((s) => s.view?.scenes ?? NO_SCENES);
  const playingId = useRoomView((s) => s.view?.playing?.music?.playlistId ?? null);
  const wide = useLayoutSize().width >= WIDE_LAYOUT_PX;
  // A track deleted elsewhere takes its page with it.
  const step: MusicStep = state.step.t === "track" && !sounds[state.step.soundId] ? { t: "home" } : state.step;
  const draft = step.t === "maker" ? step.draft : null;
  const stored = draft ? playlists[draft.playlistId] : undefined;
  const home = () => slot.setState({ step: { t: "home" } });
  const close = () => closeMusicWindow(slot);
  const setDraft = (next: MakerDraft) => {
    // An answer that comes after the maker went changes nothing.
    if (slot.getState().step.t === "maker") slot.setState({ step: { t: "maker", draft: next } });
  };
  const maker = useMakerControl({ draft, stored, sounds, playingIt: draft !== null && playingId === draft.playlistId, actions, setDraft, onSaved: home });
  const back = step.t === "home" ? null : () => (step.t === "maker" ? maker.leave(home) : home());
  // Android's Back steps back from a step, then closes. The key changes as the maker asks first, so the next Back has an entry of its own.
  useBackClose(state.open ? `music-${step.t}${maker.asking ? "-asking" : ""}` : null, () => (back ? back() : close()));

  const openMaker = (playlistId: string | null, seed?: string) => {
    const playlist = playlistId === null ? undefined : playlists[playlistId];
    slot.setState({ step: { t: "maker", draft: playlist ? draftOf(playlist) : newDraft(actions.newId(), seed) } });
  };

  let title = MUSIC_TITLE;
  let body: ReactNode;
  if (step.t === "maker") {
    title = stored?.name ?? step.draft.base?.name ?? NEW_PLAYLIST;
    body = (
      <MakerBody
        draft={step.draft}
        stored={stored}
        sounds={sounds}
        scenes={scenes}
        wide={wide}
        dirty={maker.dirty}
        playBusy={maker.busy === "play"}
        onChange={setDraft}
        onPlay={maker.play}
        onDelete={() => {
          send(actions, { t: "playlist.delete", id: step.draft.playlistId });
          home();
        }}
      />
    );
  } else if (step.t === "track") {
    const track = sounds[step.soundId]!;
    title = nameOf(track);
    body = <SoundPage key={track.id} sound={track} onDeleted={home} />;
  } else {
    const library = <Library onOpenMaker={openMaker} onOpenTrack={(soundId) => slot.setState({ step: { t: "track", soundId } })} />;
    body = wide ? (
      // Each column scrolls on its own, so Up next stays beside a long Library (4.1).
      <div data-music-wide="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px", height: "100%", minHeight: 0 }}>
        <div data-music-column="library" style={{ overflowY: "auto", overscrollBehavior: "contain", padding: theme.space(4), minHeight: 0 }}>
          {library}
        </div>
        <div data-music-column="now" style={{ overflowY: "auto", overscrollBehavior: "contain", padding: theme.space(4), minHeight: 0, borderLeft: `${theme.line.border}px solid ${theme.color.border}` }}>
          <NowColumn />
        </div>
      </div>
    ) : (
      <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
        <Segmented<MusicTab>
          label={MUSIC_TABS}
          grow
          value={state.tab}
          options={[
            { value: "now", label: NOW_TAB },
            { value: "library", label: LIBRARY_TAB },
          ]}
          onChange={(tab) => slot.setState({ tab })}
        />
        {state.tab === "now" ? <NowColumn /> : library}
      </div>
    );
  }
  const columns = wide && step.t === "home";
  return (
    <Dialog
      title={title}
      onClose={() => (step.t === "maker" ? maker.leave(close) : close())}
      width="xl"
      phone="tall"
      opener={OPEN_MUSIC_BUTTON}
      back={back ? { label: BACK_TO_MUSIC, onBack: back } : null}
      {...(step.t === "maker" ? { footer: maker.footer, ...(maker.status ? { status: maker.status } : null) } : null)}
      {...(columns ? { bodyStyle: { padding: 0, overflowY: "hidden" } } : null)}
    >
      <div data-music-window={step.t} style={{ minWidth: 0, ...(columns ? { height: "100%" } : null) }}>
        {body}
      </div>
    </Dialog>
  );
}

const NO_SCENES = {};

/** Now playing's column: the music, Up next, then the music's volume and the names switch, both also in the Sound group (3.1). */
function NowColumn() {
  return (
    <div data-music-column-now="" style={{ display: "grid", gap: theme.space(6), alignContent: "start", minWidth: 0 }}>
      <NowFull />
      <UpNext />
      <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
        <MusicVolume />
        <NamesSwitch />
      </div>
    </div>
  );
}
