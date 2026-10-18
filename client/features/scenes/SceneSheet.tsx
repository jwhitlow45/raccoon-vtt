import type { ReactNode, RefObject } from "react";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { dangerLook } from "../../components/looks.ts";
import { theme } from "../../lib/theme.ts";

/**
 * A modal sheet over the room for a scene's menu: from the bottom on a
 * phone, a centered card from 600 px up, as the monster filters sheet is.
 * The shared dialog shell in its `sheet` shape (components/Dialog.tsx), so
 * the room behind is inert, Escape and Android's Back close it, and focus
 * goes back to the button that opened it. `onBack` puts a back button in
 * the header, for a step reached from the menu.
 */
export function SceneSheet(props: {
  title: string;
  onClose(): void;
  onBack?(): void;
  opener: RefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      opener={props.opener}
      back={props.onBack ? { label: "Back to the menu", onBack: props.onBack } : null}
      width="md"
      phone="sheet"
      backClose
      footer={props.footer}
      bodyStyle={{ fontSize: theme.font.body14 }}
    >
      {props.children}
    </Dialog>
  );
}

/**
 * A menu choice in a scene sheet: a card row, as a Row that is a button
 * looks (components/Row.tsx), whose hint wraps rather than cuts off, since
 * it says what the choice will do ("Open this scene first").
 */
export function SheetRow(props: { label: ReactNode; hint?: ReactNode; disabled?: boolean; danger?: "rest" | "armed"; onClick(): void }) {
  const { disabled } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={props.onClick}
      // Armed keeps the row's size, so the second tap lands where the first did.
      style={{
        display: "grid",
        alignContent: "center",
        gap: theme.space(0.5),
        width: "100%",
        minHeight: props.hint ? 56 : theme.touch,
        padding: `${theme.space(2)}px ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.surfaceRaised,
        color: disabled ? theme.color.textDisabled : theme.color.text,
        fontFamily: theme.font.body,
        fontSize: theme.font.input,
        fontWeight: theme.weight.strong,
        lineHeight: theme.leading.tight,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        ...(props.danger && !disabled ? dangerLook(props.danger === "armed") : null),
      }}
    >
      {props.label}
      {props.hint ? (
        <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.regular, lineHeight: theme.leading.body, color: disabled ? theme.color.textDisabled : theme.color.textMuted }}>
          {props.hint}
        </span>
      ) : null}
    </button>
  );
}

/** A checkbox row with a muted line under its label: an option the sheet's button reads. */
export function CheckRow(props: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void }) {
  return <Checkbox label={props.label} help={props.hint} checked={props.checked} disabled={props.disabled} onChange={props.onChange} />;
}
