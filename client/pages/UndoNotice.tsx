import { IconButton } from "../components/IconButton.tsx";
import { Notice } from "../components/Notice.tsx";
import { useLayoutSize } from "../features/device/layout.ts";
import { SHORT_LANDSCAPE_MAX } from "../features/encounter/band.ts";
import { theme } from "../lib/theme.ts";
import { UNDO_NOTICE } from "../state/historyNotice.ts";
import { useIsDisplay, useRoomUi, useRoomView } from "../state/view.ts";
import { inModal, useModalSlot } from "./modalSlot.tsx";

export function UndoNotice() {
  const shown = useRoomView((s) => s.you?.role === "dm" && s.undoNotice === true);
  const ui = useRoomUi();
  const display = useIsDisplay();
  const slot = useModalSlot("undo");
  const compact = useLayoutSize().height < SHORT_LANDSCAPE_MAX;
  if (!shown || display) return null;
  return inModal(
    <div data-undo-rollout-notice="" style={{ pointerEvents: "auto", width: "100%", maxWidth: theme.layout.notice, minWidth: 0 }}>
      <Notice float compact={compact} role="status" action={<IconButton icon="close" label="Dismiss undo notice" onClick={() => ui.dismissUndoNotice?.()} />}>
        {UNDO_NOTICE}
      </Notice>
    </div>,
    slot,
  );
}
