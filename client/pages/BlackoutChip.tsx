import { theme } from "../lib/theme.ts";
import { Icon } from "../components/Icon.tsx";

/** The DM's reminder that players see the blackout screen. */
export function BlackoutChip(props: { compact: boolean }) {
  const title = props.compact ? "You are the DM. Players see black" : "Players see black";
  return (
    <span
      role={props.compact ? "img" : undefined}
      aria-label={props.compact ? title : undefined}
      title={title}
      style={{
        flex: "none", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
        width: props.compact ? 28 : undefined, height: 28, padding: props.compact ? 0 : `0 ${theme.space(2.5)}px`,
        borderRadius: theme.radius.pill, border: `${theme.line.border}px solid ${theme.color.danger}`, color: theme.color.dangerText,
        fontSize: theme.font.small, fontWeight: theme.weight.bold, whiteSpace: "nowrap",
      }}
    >
      {props.compact ? <Icon name="hidden" size="sm" /> : "Players see black"}
    </span>
  );
}
