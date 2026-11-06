import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import { Dialog } from "../../../components/Dialog.tsx";
import { LoadBoundary } from "../../../components/LoadBoundary.tsx";
import { LoadFailed } from "../../../components/LoadFailed.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { retryableLazy } from "../../../lib/retryableLazy.ts";
import { useScoped } from "../../../state/scope.ts";
import { useRoomView } from "../../../state/view.ts";
import { OPENING_PLAYLIST, PLAYLIST_FAILED } from "../panel/words.ts";
import { playlistsOf } from "../panel/state.ts";
import { closeMaker, makerSlot } from "./open.ts";
import { makerTitle } from "./words.ts";

const load = () => import("./MakerDialog.tsx");
const MakerDialog = retryableLazy(load, { roles: ["dm"] });

/**
 * Where the DM's Sound panel mounts the playlist maker's pop-up
 * (docs/design/design-v1-sound-layout.md 4.5 and 9). Its code loads with
 * the panel's, started as the panel first shows, so opening it rarely
 * waits. If it does, the pop-up opens at once on the shared loading line,
 * shown past the shared delay, and a load that fails says so with Try
 * again, in the same card, whose close lets the untouched draft go.
 */
export function MakerHost() {
  const slot = useScoped(makerSlot);
  const draft = useStore(slot, (s) => s.draft);
  const storedName = useRoomView((s) => (draft ? playlistsOf(s.view)[draft.playlistId]?.name : undefined));
  useEffect(() => {
    load().catch(() => {
      // Opening it reports a failure, if it is ever opened.
    });
  }, []);
  if (!draft) return null;
  const close = () => closeMaker(slot);
  const title = makerTitle(storedName, draft.base?.name);
  return (
    <LoadBoundary
      fallback={(f) => (
        <Dialog title={title} onClose={close} width="xl" phone="tall">
          <LoadFailed retry={f.retry}>{PLAYLIST_FAILED}</LoadFailed>
        </Dialog>
      )}
    >
      <Suspense
        fallback={
          <Dialog title={title} onClose={close} width="xl" phone="tall">
            <Loading text={OPENING_PLAYLIST} />
          </Dialog>
        }
      >
        <MakerDialog />
      </Suspense>
    </LoadBoundary>
  );
}
