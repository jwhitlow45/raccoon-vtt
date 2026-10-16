import { useMemo } from "react";
import { useStore } from "zustand";
import { Notice } from "../components/Notice.tsx";
import { quietFailures, quietNotice } from "../lib/quietFailures.ts";
import { RoomLoadNotice } from "../panels/Panels.tsx";
import { inModal, useModalSlot } from "./modalSlot.tsx";

/**
 * The one notice for the map's quiet layers whose code did not load
 * (lib/quietLazy.tsx), over the map beside the toasts, since those layers
 * draw nothing where they failed. It offers what a panel that did not load
 * offers: Retry, or a reload that waits for queued edits first. It goes
 * once every failed part loads.
 */
export function QuietLoadNotice() {
  const parts = useStore(quietFailures, (s) => s.parts);
  const notice = useMemo(() => quietNotice(parts), [parts]);
  // Inside a very short sheet while one shows (pages/modalSlot.tsx).
  const slot = useModalSlot("quiet");
  if (!notice) return null;
  return inModal(
    <Notice float style={{ pointerEvents: "auto", width: "100%", maxWidth: 520 }}>
      <RoomLoadNotice failure={notice.failure} retry={notice.retry} subject={notice.subject} verb="load" compact reopen={{}} />
    </Notice>,
    slot,
  );
}
