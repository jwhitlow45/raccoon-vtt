import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Spinner } from "./Loading.tsx";
import { buttonLook, dangerLook, type ButtonVariant } from "./looks.ts";

export type { ButtonVariant } from "./looks.ts";

/**
 * destructiveStyle for a button styled by hand: red text at rest, the red
 * outline and tint once armed (looks.ts dangerLook). Spread it last into a
 * button's own style, after its border and background. Focus rings
 * (globals.css) are unchanged.
 */
export function destructiveStyle(armed = false): CSSProperties {
  return dangerLook(armed);
}

const SIZES = {
  md: { fontSize: theme.font.input, padding: `0 ${theme.space(4)}px` },
  sm: { fontSize: theme.font.body14, padding: `0 ${theme.space(3)}px` },
} as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  /** `md` for pages, forms and dialogs, `sm` for panels, panes and tool bars. Both stay 44 px tall. */
  size?: "md" | "sm";
  /** Full width, as a card's or a form's one action. */
  block?: boolean;
  /** A `danger` button waiting for its second tap (looks.ts dangerLook). */
  armed?: boolean;
  /**
   * An option that is on or off and takes effect at once, named by what
   * pressed means ("DM only", "Snap", "Hidden"): sets `aria-pressed` and
   * the chosen look. Its name never changes with its state.
   */
  pressed?: boolean;
  /**
   * A disclosure that shows or hides more, such as the "Rolls" button past
   * the first two requests: `aria-expanded`, and the chosen look while
   * open. Never `aria-pressed`, which would make it a toggle button whose
   * role changes with its state.
   */
  expanded?: boolean;
  /**
   * The work this button started is under way: a spinner before the
   * caller's busy label ("Saving…"), `aria-busy`, and further taps
   * ignored, at full color so it does not read as unavailable.
   */
  busy?: boolean;
  /** An icon before the label, such as the copy icon on "Copy link". */
  icon?: IconName;
};

/**
 * The one button (docs/design-v1-visual.md 2.3). At least 44 px tall and
 * wide, the minimum touch target (design section 14.4). One primary per
 * view: the main action of a form, dialog, card or page. Buttons that open
 * something or act on the side are secondary, and `quiet` sits in rows and
 * headers where an outline would crowd. `variant="danger"` is for
 * destructive actions, and `armed` marks one that waits for its second tap.
 */
export function Button(props: ButtonProps) {
  const { variant = "secondary", size = "md", block, armed, pressed, expanded, busy, icon, style, disabled, onClick, children, ...rest } = props;
  const ignore = busy === true && disabled !== true;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-busy={busy ? true : undefined}
      {...rest}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        // Not `disabled`: a busy button keeps its focus and its color. A submit button's default would send the form again.
        if (ignore) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space(2),
        minHeight: theme.touch,
        minWidth: theme.touch,
        ...SIZES[size],
        borderRadius: theme.radius.md,
        fontWeight: theme.weight.strong,
        fontFamily: theme.font.body,
        cursor: disabled || busy ? "default" : "pointer",
        width: block ? "100%" : undefined,
        ...buttonLook(variant, { pressed: pressed ?? expanded, disabled, armed }),
        ...style,
      }}
    >
      {busy ? <Spinner size={theme.icon.sm} /> : icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}
