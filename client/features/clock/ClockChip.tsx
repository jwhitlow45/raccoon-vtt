import { clockNow } from "#shared/calendar.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { chipName, chipText } from "./words.ts";

/** The text a chip shows, or null while the viewer's clock is off or hidden. Read by the top bar, which needs it to know the chip's width has changed. */
export function useClockChipText(): string | null {
  return useRoomView((s) => {
    const clock = s.view?.clock;
    return clock ? chipText(clockNow(clock, s.view?.encounter), clock.calendar) : null;
  });
}

/**
 * The clock in the top bar from 900 px up (docs/design/design-v1-calendar.md
 * 4.8): "Day 4, 6:00 AM", a button that opens the Time panel. The pill is
 * 28 px like the other chips, inside a 44 px touch target. The top bar
 * steps it aside first when the row overflows (pages/Room.tsx TopBar).
 */
export function ClockChip(props: { onOpen(): void }) {
  const clock = useRoomView((s) => s.view?.clock);
  const encounter = useRoomView((s) => s.view?.encounter);
  if (!clock) return null;
  const now = clockNow(clock, encounter);
  const name = chipName(now, clock.calendar);
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      onClick={props.onOpen}
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        height: theme.touch,
        padding: 0,
        background: "transparent",
        border: 0,
        color: theme.color.text,
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          boxSizing: "border-box",
          height: 28,
          padding: `0 ${theme.space(2.5)}px`,
          borderRadius: theme.radius.pill,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          fontSize: theme.font.small,
          fontWeight: theme.weight.bold,
          whiteSpace: "nowrap",
        }}
      >
        {chipText(now, clock.calendar)}
      </span>
    </button>
  );
}
