import { Suspense, useEffect } from "react";
import { useStore } from "zustand";
import { Dialog } from "../../../components/Dialog.tsx";
import { LoadBoundary } from "../../../components/LoadBoundary.tsx";
import { LoadFailed } from "../../../components/LoadFailed.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { retryableLazy } from "../../../lib/retryableLazy.ts";
import { useScoped } from "../../../state/scope.ts";
import { closeMusicWindow, musicWindowSlot } from "./open.ts";
import { MUSIC_TITLE, OPEN_FAILED, OPENING } from "./words.ts";

const load = () => import("./MusicWindow.tsx");
const MusicWindow = retryableLazy(load, { roles: ["dm"] });

/**
 * Where the DM's Sound group mounts the Music window
 * (docs/design/design-v1-music-player.md 3.2 and 9). Its code loads with
 * the panel's, started as the group first shows, so Open music rarely
 * waits. If it does, the window opens at once on the shared loading line,
 * shown past the shared delay, and a load that fails says so with Try
 * again, in the same card.
 */
export function MusicWindowHost() {
  const slot = useScoped(musicWindowSlot);
  const open = useStore(slot, (s) => s.open);
  useEffect(() => {
    load().catch(() => {
      // Opening it reports a failure, if it is ever opened.
    });
  }, []);
  if (!open) return null;
  const close = () => closeMusicWindow(slot);
  return (
    <LoadBoundary
      fallback={(f) => (
        <Dialog title={MUSIC_TITLE} onClose={close} width="xl" phone="tall">
          <LoadFailed retry={f.retry}>{OPEN_FAILED}</LoadFailed>
        </Dialog>
      )}
    >
      <Suspense
        fallback={
          <Dialog title={MUSIC_TITLE} onClose={close} width="xl" phone="tall">
            <Loading text={OPENING} />
          </Dialog>
        }
      >
        <MusicWindow />
      </Suspense>
    </LoadBoundary>
  );
}
