import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { OptButton } from "../measure/controls.tsx";

/**
 * The select tool's bar while "Select several" is on (state/selection.ts).
 * A phone has no Shift key, so the mode says what a tap does now, and Done
 * ends it. Two fingers still move the map, as everywhere.
 *
 * The hint comes first, as in every tool's bar, but beside Done rather
 * than above it: one short row, so the token bars above it know its
 * height (Stage.tsx SELECT_OPTIONS_PX).
 */
export function SelectOptions() {
  const ui = useRoomUi();
  const count = useRoomView((s) => s.local.selectedIds.length);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), width: "100%", minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>
        <strong style={{ color: theme.color.text }}>{count} selected.</strong> Tap tokens to add or remove them, or drag a box on the map.
      </span>
      <OptButton tone="primary" onClick={() => ui.setMultiSelect(false)}>
        Done
      </OptButton>
    </div>
  );
}
