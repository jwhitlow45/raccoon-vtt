import { Children, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type ReactNode, type Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Spinner } from "./Loading.tsx";
import { addsWords, useTooltip } from "./Tooltip.tsx";
import { isCoarsePointer } from "../lib/device.ts";
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

/** The box every button draws, shared with `ButtonGhost`, which must measure as the button does. */
function buttonBox(size: "md" | "sm"): CSSProperties {
  return {
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
  };
}

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
  /**
   * The icon alone, its words (`children`, or `aria-label`) its name and
   * its tooltip (docs/design-v1-icons.md 3.1): `always` for an icon read at
   * once without hover, such as the trash can (rule 1), and `fine` for one
   * a mouse learns from its tooltip, which a touch screen draws with its
   * words, since nothing may need hover (rule 2).
   */
  iconOnly?: "always" | "fine";
};

/**
 * The words among a button's children, its name when its icon stands
 * alone. A caller may pass its words beside a mark that is not always
 * there (a tool row's check), so an array of words and nothing counts too.
 */
function wordsOf(children: ReactNode): string | undefined {
  const parts: string[] = [];
  const walk = (node: ReactNode) => {
    if (typeof node === "string" || typeof node === "number") parts.push(String(node));
    else if (Array.isArray(node)) node.forEach(walk);
  };
  walk(children);
  const text = parts.join("").trim();
  return text === "" ? undefined : text;
}

/**
 * The one button (docs/design-v1-visual.md 2.3). At least 44 px tall and
 * wide, the minimum touch target (design section 14.4). One primary per
 * view: the main action of a form, dialog, card or page. Buttons that open
 * something or act on the side are secondary, and `quiet` sits in rows and
 * headers where an outline would crowd. `variant="danger"` is for
 * destructive actions, and `armed` marks one that waits for its second tap.
 */
export function Button(props: ButtonProps) {
  const { variant = "secondary", size = "md", block, armed, pressed, expanded, busy, icon, iconOnly, title, style, disabled, onClick, children, onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onPointerCancel, onClickCapture, onFocus, onBlur, ...rest } = props;
  const ignore = busy === true && disabled !== true;
  const bare = icon !== undefined && (iconOnly === "always" || (iconOnly === "fine" && !isCoarsePointer()));
  const name = rest["aria-label"] ?? wordsOf(children);
  // An icon alone shows its name on hover, keyboard focus and a long press (Tooltip.tsx), never the native title, which a keyboard never shows.
  // Nothing drawn counts as alone, such as a tool row's `[undefined, null]` beside its icon (OptButton).
  const tipped = icon !== undefined && (bare || Children.toArray(children).length === 0);
  const tooltip = useTooltip(title ?? name ?? "", { describes: addsWords(title, name) });
  const handlers = { onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onPointerCancel, onClickCapture, onFocus, onBlur };
  const button = (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-busy={busy ? true : undefined}
      {...rest}
      aria-label={bare ? name : rest["aria-label"]}
      title={tipped ? undefined : title}
      {...(tipped ? tooltip.anchor({ ...handlers, "aria-describedby": rest["aria-describedby"] }) : handlers)}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        // Not `disabled`: a busy button keeps its focus and its color. A submit button's default would send the form again.
        if (ignore) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      style={{
        ...buttonBox(size),
        cursor: disabled || busy ? "default" : "pointer",
        width: block ? "100%" : undefined,
        ...buttonLook(variant, { pressed: pressed ?? expanded, disabled, armed }),
        ...(bare ? { padding: 0 } : null),
        ...style,
      }}
    >
      {busy ? <Spinner size={theme.icon.sm} /> : icon ? <Icon name={icon} size={bare ? "md" : "sm"} /> : null}
      {bare ? null : children}
    </button>
  );
  if (!tipped) return button;
  return (
    <>
      {button}
      {tooltip.tip}
    </>
  );
}

/**
 * An unseen copy of a button with its words and icon, the size the button
 * would draw at. A slot that stacks it under a button keeps the button's
 * widest form, so a button that grows into it moves nothing around it
 * (docs/design-v1-icons.md 4.1), such as Delete growing "Sure?". A span,
 * so nothing that counts a row's buttons, or focus, ever finds it.
 */
export function ButtonGhost(props: { size?: "md" | "sm"; icon?: IconName; children: ReactNode; style?: CSSProperties }) {
  return (
    <span aria-hidden style={{ ...buttonBox(props.size ?? "md"), border: `${theme.line.border}px solid transparent`, visibility: "hidden", ...props.style }}>
      {props.icon ? <Icon name={props.icon} size="sm" /> : null}
      {props.children}
    </span>
  );
}
