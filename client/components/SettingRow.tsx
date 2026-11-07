import { useId, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { Icon } from "./Icon.tsx";

export type SettingIds = {
  /** The name's id, for the control's `aria-labelledby` (or a Segmented's `labelledBy`). */
  nameId: string;
  /** The help's id, for the control's `aria-describedby`, when there is help. */
  helpId: string | undefined;
};

/** A row holds its control, or is itself the one button that opens where the setting lives (`onOpen`), never both. */
export type SettingRowProps = {
  name: string;
  help?: ReactNode;
  wide?: boolean;
  disabled?: boolean;
  /** The room search's anchor id (features/search/entry.ts) on the whole row, so a landing shows the setting's name over its control and focuses the control. */
  search?: string;
} & (
  | { children: ReactNode | ((ids: SettingIds) => ReactNode); onOpen?: undefined; label?: undefined }
  | {
      /**
       * Makes the whole row one button that opens the setting where it lives
       * (docs/design/design-v1-scenes-reorg.md 5), a row that only jumps to another
       * panel, which none draws since docs/design/design-v1-sound-layout.md 6:
       * the name, the help under it, and a chevron where a control would sit.
       * It keeps a setting's look, never a raised Row card, so its name starts
       * at its neighbors' edge.
       */
      onOpen(): void;
      /** The button's name where the row's name alone says too little, such as "Scene sound, in Scenes". */
      label?: string;
      children?: undefined;
    }
);

/**
 * One setting in a panel (docs/design/design-v1-visual.md 2.3): its name at 16 px
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
export function SettingRow(props: SettingRowProps) {
  const nameId = useId();
  const helpId = useId();
  const ids: SettingIds = { nameId, helpId: props.help ? helpId : undefined };
  const row = {
    display: "flex",
    flexWrap: props.wide ? "wrap" : "nowrap",
    alignItems: "center",
    gap: `${theme.space(2)}px ${theme.space(3)}px`,
    minHeight: theme.touch,
    padding: `${theme.space(2)}px 0`,
  } as const;
  const words = (
    <>
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
    </>
  );
  if (props.onOpen) {
    // A button holds phrasing content only, so its parts are spans. Its own box takes the row's look, with the browser's padding, border and font gone.
    return (
      <button
        type="button"
        data-setting-row=""
        // Named by its label or its name, and described by its help, as a control in a row is: the help read once, not twice.
        aria-label={props.label}
        aria-labelledby={props.label ? undefined : nameId}
        aria-describedby={ids.helpId}
        disabled={props.disabled}
        onClick={props.onOpen}
        style={{ ...row, width: "100%", margin: 0, background: "transparent", border: "none", color: theme.color.text, fontFamily: theme.font.body, textAlign: "left", cursor: props.disabled ? "default" : "pointer" }}
      >
        <span style={{ flex: "1 1 auto", minWidth: 0, display: "grid", gap: theme.space(0.5) }}>{words}</span>
        <span style={{ flex: "none", display: "flex", color: props.disabled ? theme.color.textDisabled : theme.color.textMuted }}>
          {/* Small, as an opening group's, so the two kinds of row that open elsewhere wear one chevron. */}
          <Icon name="chevronRight" size="sm" />
        </span>
      </button>
    );
  }
  const control = typeof props.children === "function" ? props.children(ids) : props.children;
  return (
    // Marked for the spacing check (e2e/helpers/spacing.ts), which holds a settings section's label one distance over its first row.
    <div data-setting-row="" data-search={props.search} style={row}>
      <div style={{ flex: props.wide ? "1 1 100%" : "1 1 auto", minWidth: 0, display: "grid", gap: theme.space(0.5) }}>{words}</div>
      <div style={{ flex: props.wide ? "1 1 100%" : "none", minWidth: 0, display: "flex", justifyContent: props.wide ? "flex-start" : "flex-end" }}>{control}</div>
    </div>
  );
}
