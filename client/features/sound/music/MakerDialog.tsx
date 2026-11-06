import { useStore } from "zustand";
import { Dialog } from "../../../components/Dialog.tsx";
import { useBackClose } from "../../../lib/backClose.ts";
import { useScoped } from "../../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../../state/view.ts";
import { useLayoutSize } from "../../device/layout.ts";
import { send } from "../panel/ops.ts";
import { playlistsOf, soundsOf } from "../panel/state.ts";
import { MakerBody, useMakerControl } from "./Maker.tsx";
import { closeMaker, makerOpener, makerSlot, setMakerDraft } from "./open.ts";
import { makerTitle } from "./words.ts";

/** From this layout width the 1040 px card holds the maker's two columns (docs/design/design-v1-music-player.md 5). */
export const WIDE_LAYOUT_PX = 912;

/**
 * The playlist maker's pop-up (docs/design/design-v1-sound-layout.md 4.5):
 * the shared Dialog, 1040 px on a computer with its two columns from 912
 * layout px, the tall sheet on a phone, titled with the playlist's name
 * and with no back button. Its body, footer and draft are the maker's
 * (Maker.tsx). Its state is the Room scope's slot (open.ts), so a turn
 * across 900 px, which remounts the panel and this with it, keeps the
 * draft, and focus goes back to the control that opened it, found by its
 * mark.
 *
 * Leaving it, as D-261106-020 settled: Save and Create playlist close once
 * answered. Cancel, the close button, Escape and Android's Back close at
 * once with no changes, and with changes ask "Throw away your changes?"
 * and close on a second press. A swipe down and Put away sheet never ask:
 * with changes the sheet springs back and keeps the draft (MakerBody's
 * useUnsavedInput), and with none they close as the close button does.
 * It loads on its own (MakerHost.tsx), the DM's alone.
 */
export default function MakerDialog() {
  const actions = useRoomActions();
  const store = useRoomStore();
  const slot = useScoped(makerSlot);
  const { draft, opener } = useStore(slot);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const scenes = useRoomView((s) => s.view?.scenes ?? NO_SCENES);
  const playingId = useRoomView((s) => s.view?.playing?.music?.playlistId ?? null);
  const wide = useLayoutSize().width >= WIDE_LAYOUT_PX;
  const stored = draft ? playlists[draft.playlistId] : undefined;
  const close = () => closeMaker(slot);
  const room = () => {
    const view = store.getState().view;
    return { playlists: playlistsOf(view), sounds: soundsOf(view) };
  };
  const maker = useMakerControl({ draft, stored, sounds, playingIt: draft !== null && playingId === draft.playlistId, actions, room, setDraft: (next) => setMakerDraft(slot, next), onSaved: close });
  const leave = () => maker.leave(close);
  // The key changes as the maker asks first, so the next Back has an entry of its own.
  useBackClose(draft ? `maker${maker.asking ? "-asking" : ""}` : null, leave);
  if (!draft) return null;
  return (
    <Dialog
      title={makerTitle(stored?.name, draft.base?.name)}
      onClose={leave}
      width="xl"
      phone="tall"
      opener={makerOpener(opener)}
      footer={maker.footer}
      {...(maker.status ? { status: maker.status } : null)}
    >
      <MakerBody
        draft={draft}
        stored={stored}
        sounds={sounds}
        scenes={scenes}
        wide={wide}
        dirty={maker.dirty}
        playBusy={maker.busy === "play"}
        onChange={(next) => setMakerDraft(slot, next)}
        onPlay={maker.play}
        onDelete={() => {
          send(actions, { t: "playlist.delete", id: draft.playlistId });
          close();
        }}
      />
    </Dialog>
  );
}

const NO_SCENES = {};
