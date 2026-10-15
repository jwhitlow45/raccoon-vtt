import { useId, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { barDockSlot, hintRoom, shortHint } from "../../canvas/barDock.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { useLayoutSize } from "../device/layout.ts";
import { OptButton } from "../measure/controls.tsx";

/** The options bar's padding and edges from 900 px up, before the safe areas (pages/Room.tsx OptionsBar). */
const WIDE_BAR_PADDING = 2 * theme.space(2) + 2 * theme.line.border;
const SENTENCE = "Tap tokens to add or remove them, or drag a box on the map.";

/**
 * The select tool's bar while "Select several" is on (state/selection.ts).
 * A phone has no Shift key, so the mode says what a tap does now, and Done
 * ends it and lets go of the group. A tap on empty map hides the group's
 * action bar and keeps the group, and Actions, shown only while the bar is
 * hidden, brings it back with focus on its frame. Two fingers still move
 * the map, as everywhere.
 *
 * The hint comes first, as in every tool's bar, but beside the buttons
 * rather than above them: one short row (docs/design-v1-bar-dock.md
 * section 3). Where the whole sentence would wrap, the row shows only
 * "3 selected.", and the sentence stays the toolbar's description. Which
 * one shows follows the room the bar may take (canvas/barDock.ts
 * hintRoom), never the bar's own drawn width, which from 900 px up
 * follows its content and would keep whichever hint showed first.
 */
export function SelectOptions() {
  const ui = useRoomUi();
  const count = useRoomView((s) => s.local.selectedIds.length);
  const barHidden = useRoomView((s) => s.local.selectedIds.length > 0 && !s.local.actionBar);
  const dock = useScoped(barDockSlot);
  const safe = useStore(dock, (s) => s.chrome?.safe ?? null);
  const { width } = useLayoutSize();
  const wide = width >= theme.layout.wideMinWidth;
  const rowRef = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState(0);
  const descId = useId();

  // The toolbar Room draws around these options (pages/Room.tsx OptionsBar) takes the whole sentence as its description. On a phone it spans the screen, so this row's own width is the room it has.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const toolbar = row.closest('[role="toolbar"]');
    toolbar?.setAttribute("aria-describedby", descId);
    const observer = new ResizeObserver(([entry]) => setInner(entry ? entry.contentRect.width : 0));
    observer.observe(row);
    return () => {
      observer.disconnect();
      if (toolbar?.getAttribute("aria-describedby") === descId) toolbar.removeAttribute("aria-describedby");
    };
  }, [descId]);

  const sides = safe ? safe.left + safe.right : 0;
  // Before a phone's row is measured its room reads as 0, so the first frame shows the short hint and never wraps.
  const short = shortHint(hintRoom({ wide, mapWidth: width - theme.layout.sidePanelWidth, padding: WIDE_BAR_PADDING + sides, inner }));
  return (
    <div ref={rowRef} style={{ display: "flex", alignItems: "center", gap: theme.space(2), width: "100%", minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>
        <strong style={{ color: theme.color.text }}>{count} selected.</strong>
        {short ? null : ` ${SENTENCE}`}
      </span>
      <span id={descId} hidden>
        {`${count} selected. ${SENTENCE}`}
      </span>
      {barHidden ? (
        <OptButton
          onClick={() => {
            dock.setState({ focusFrame: true });
            ui.showActions(true);
          }}
        >
          Actions
        </OptButton>
      ) : null}
      <OptButton tone="primary" onClick={() => ui.doneSelecting()}>
        Done
      </OptButton>
    </div>
  );
}
