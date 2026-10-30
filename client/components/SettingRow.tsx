import { useId, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";

export type SettingIds = {
  /** The name's id, for the control's `aria-labelledby` (or a Segmented's `labelledBy`). */
  nameId: string;
  /** The help's id, for the control's `aria-describedby`, when there is help. */
  helpId: string | undefined;
};

/**
 * One setting in a panel (docs/design-v1-visual.md 2.3): its name at 16 px
 * weight 600, the help under it, and its control at the right, or under
 * both when `wide` (a Segmented with several options, a long field). The
 * DM tab, Room settings, This device, Scenes and Initiative lay their
 * settings out this way, so one setting looks like another wherever it is.
 *
 * The control comes as a function of the row's ids, so it is named by the
 * setting's name and described by its help without the caller making ids
 * of its own. A setting that is simply on or off is a Switch, which is a
 * whole row itself.
 */
export function SettingRow(props: { name: string; help?: ReactNode; wide?: boolean; disabled?: boolean; children: ReactNode | ((ids: SettingIds) => ReactNode) }) {
  const nameId = useId();
  const helpId = useId();
  const ids: SettingIds = { nameId, helpId: props.help ? helpId : undefined };
  const control = typeof props.children === "function" ? props.children(ids) : props.children;
  return (
    // Marked for the spacing check (e2e/helpers/spacing.ts), which holds a settings section's label one distance over its first row.
    <div
      data-setting-row=""
      style={{
        display: "flex",
        flexWrap: props.wide ? "wrap" : "nowrap",
        alignItems: "center",
        gap: `${theme.space(2)}px ${theme.space(3)}px`,
        minHeight: theme.touch,
        padding: `${theme.space(2)}px 0`,
      }}
    >
      <div style={{ flex: props.wide ? "1 1 100%" : "1 1 auto", minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
        <span
          id={nameId}
          style={{
            fontSize: theme.font.input,
            fontWeight: theme.weight.strong,
            lineHeight: theme.leading.tight,
            color: props.disabled ? theme.color.textDisabled : theme.color.text,
          }}
        >
          {props.name}
        </span>
        {props.help ? (
          <span id={helpId} style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: props.disabled ? theme.color.textDisabled : theme.color.textMuted }}>
            {props.help}
          </span>
        ) : null}
      </div>
      <div style={{ flex: props.wide ? "1 1 100%" : "none", minWidth: 0, display: "flex", justifyContent: props.wide ? "flex-start" : "flex-end" }}>{control}</div>
    </div>
  );
}
