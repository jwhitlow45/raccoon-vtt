import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { barDockSlot } from "../../canvas/barDock.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { OptButton, OptionsStrip, StripText } from "../measure/controls.tsx";

const SENTENCE = "Tap tokens to add or remove them, or drag a box on the map.";

/**
 * The select tool's row while "Multi-select" is on (state/selection.ts,
 * docs/design-v1-tool-options.md 9.1). A phone has no Shift key, so the
 * row says what a tap does now, and Done ends the mode and lets go of the
 * group. A tap on empty map hides the group's action bar and keeps the
 * group, and Actions, shown only while the bar is hidden, brings it back
 * with focus on its frame. Two fingers still move the map, as everywhere.
 *
 * Its words stand in the row, with no line above: "3 selected." first and
 * bold, then the sentence where the row holds it, cut with an ellipsis
 * where it holds only part. The whole sentence stays the options' description.
 */
export function SelectOptions() {
  const ui = useRoomUi();
  const count = useRoomView((s) => s.local.selectedIds.length);
  const barHidden = useRoomView((s) => s.local.selectedIds.length > 0 && !s.local.actionBar);
  const dock = useScoped(barDockSlot);
  return (
    <OptionsStrip
      tool="Select"
      description={`${count} selected. ${SENTENCE}`}
      slots={[
        {
          id: "words",
          priority: 1,
          flex: theme.layout.options.text,
          control: (
            <StripText>
              <strong style={{ color: theme.color.text }}>{count} selected.</strong> {SENTENCE}
            </StripText>
          ),
        },
        barHidden && {
          id: "actions",
          priority: 1,
          control: (
            <OptButton
              onClick={() => {
                dock.setState({ focusFrame: true });
                ui.showActions(true);
              }}
            >
              Actions
            </OptButton>
          ),
        },
        {
          id: "done",
          priority: 1,
          control: (
            <OptButton tone="primary" onClick={() => ui.doneSelecting()}>
              Done
            </OptButton>
          ),
        },
      ]}
    />
  );
}
