import { Chip } from "../../components/Chip.tsx";
import { theme } from "../../lib/theme.ts";

/**
 * A save's recent DCs beside its DC field (designs/qol audit Q9): "Recent",
 * then each DC this device sent last for a save, lowest first (logic.ts
 * recentDcChips), each a view of the field as a check's typical DCs are.
 * The request sheet and the group save draw the same row.
 */
export function RecentDcs(props: { chips: readonly { dc: number; pressed: boolean }[]; onTap(dc: number): void }) {
  return (
    <span role="group" aria-label="Recent DCs" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>
      <span aria-hidden="true" style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
        Recent
      </span>
      {props.chips.map((t) => (
        <Chip key={t.dc} circle aria-label={`DC ${t.dc}`} pressed={t.pressed} onClick={() => props.onTap(t.dc)}>
          {t.dc}
        </Chip>
      ))}
    </span>
  );
}
