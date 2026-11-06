import { createPortal } from "react-dom";
import { useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { fitToasts, TOAST_MIN, type ToastEdges } from "../canvas/barDock.ts";
import { SCROLL_FOR_MORE_PX, ScrollForMore } from "../canvas/TokenActionBar.tsx";
import { Button } from "../components/Button.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { NOTICE_TONES } from "../components/tones.ts";
import { D20Icon } from "../features/dice/throw/D20Icon.tsx";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";
import { hasButtons, type Toast, type ToastDie } from "../state/types.ts";
import { TOAST_ROW_TOP, toastPortalKey } from "./toastPlacement.ts";

/** The widest a toast stands, and a stack that scrolls with it, so the map either side still takes a tap. */
export const TOAST_MAX_PX = theme.layout.notice;

/** How a stack of toasts over the map fits its room: the height it scrolls in, in the chrome's px, or none while it fits, and whether toasts hide above and below. */
export type StackFit = { max: number | null; above: boolean; below: boolean };

const FITS: StackFit = { max: null, above: false, below: false };

/** One stack's scroller and the stack inside it, which Toasts fills with the toasts' hosts, and how it fits its room. */
export function useToastStack() {
  const box = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<StackFit>(FITS);
  const newest = useRef<number | null>(null);
  /*
   * Whether the box stands at its foot, the newest in view. A resize, the
   * pane's header moving or the tool's options changing shrinks the room
   * with no scroll of its own, so a stack that followed its newest is put
   * back at its foot then (review FU22B-ASTRA-02). A scroll toward older
   * toasts is the reader's, and is left alone until a newer toast comes.
   */
  const following = useRef(true);
  const zoomAt = useRef(1);
  const update = (next: StackFit) => setShown((was) => (was.max === next.max && was.above === next.above && was.below === next.below ? was : next));
  /*
   * "Scroll for more" on the edge that hides toasts. The top's lies only
   * over toasts above the newest, never over the newest kept in view,
   * whose button it would hide: a newest taller than the room shows its
   * foot, cut at the top. The foot's stands where the box holds it over a
   * whole touch target, as on a short screen the newest's button would
   * sit under it.
   */
  const edges = () => {
    const el = box.current;
    if (!el) return;
    following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const fade = SCROLL_FOR_MORE_PX * zoomAt.current;
    const last = stack.current?.lastElementChild?.firstElementChild?.getBoundingClientRect();
    const above = el.scrollTop > 1 && (last === undefined || last.top - el.getBoundingClientRect().top >= fade);
    const below = !following.current;
    setShown((was) => {
      if (was.max === null) return was;
      const foot = below && was.max >= SCROLL_FOR_MORE_PX + TOAST_MIN;
      return was.above === above && was.below === foot ? was : { ...was, above, below: foot };
    });
  };
  const fits = () => {
    newest.current = null;
    following.current = true;
    if (shown.max !== null) update(FITS);
  };
  /** After the hosts are placed: what to drop from `list` (barDock.ts fitToasts), and otherwise the room it scrolls in and its fades, the newest kept in view. */
  const fit = (list: readonly Toast[], height: (t: Toast) => number, foot: number | null, zoom: number): number[] => {
    const el = box.current;
    if (!el || list.length === 0 || foot === null) {
      fits();
      return [];
    }
    zoomAt.current = zoom;
    const room = foot * zoom - el.getBoundingClientRect().top;
    const { drop, scrolls } = fitToasts(
      list.map((t) => ({ id: t.id, height: height(t), action: hasButtons(t), logged: t.logged === true })),
      theme.space(2) * zoom,
      room,
    );
    if (drop.length > 0) return drop;
    if (!scrolls) {
      fits();
      return [];
    }
    // At least a toast's least height, so a stack on too short a room still shows one whole touch target.
    const max = Math.round((Math.max(room, TOAST_MIN * zoom) / zoom) * 2) / 2;
    if (shown.max !== max) {
      update({ ...shown, max });
      return [];
    }
    const last = list[list.length - 1]!.id;
    if (newest.current !== last) {
      newest.current = last;
      following.current = true;
    }
    if (following.current) el.scrollTop = el.scrollHeight;
    edges();
    return [];
  };
  return { box, stack, shown, fit, edges };
}

/** A stack of toasts over the map: a box that scrolls while it runs past its room, its fades, and the stack the toasts' hosts go into. */
export function ToastStack(props: { stack: ReturnType<typeof useToastStack>; style: CSSProperties }) {
  const { box, stack, shown, edges } = props.stack;
  const scrolls = shown.max !== null;
  // Scrolling, the box takes taps and scroll gestures, so it is no wider than its toasts, centered as they are, and the map either side still takes a tap (review FU22B-OP-5).
  const pad = props.style.padding !== undefined ? 2 * theme.space(3) : 0;
  return (
    <div ref={box} onScroll={edges} style={{ ...props.style, ...(scrolls ? { maxHeight: shown.max!, maxWidth: TOAST_MAX_PX + pad, marginLeft: "auto", marginRight: "auto", overflowY: "auto", overscrollBehavior: "contain", pointerEvents: "auto" } : null) }}>
      {scrolls && shown.above ? <ScrollForMore edge="top" /> : null}
      <div ref={stack} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: theme.space(2) }} />
      {scrolls && shown.below ? <ScrollForMore /> : null}
    </div>
  );
}

/**
 * One toast. In the stack, as it always was. As the one row over the top
 * bar's row (docs/design/design-v1-bar-compact.md 3.5): 44 px with its outline
 * drawn inside, its words on one line cut with an ellipsis and whole as
 * the text button's name, which shows it whole, and its action at the
 * right end, its words whole and the row's full height. Whole: the stack's
 * form with a 44 px Close at its top right, which shrinks it back.
 *
 * Buttons that wait on the server (types.ts ToastSend) follow the words
 * on a line of their own after their label, such as a damage roll's
 * "Apply to" and its creatures, each pressed through `onPress`. The one
 * row has no room for them, so there they stay mounted and hidden, and a
 * tap on its words shows them whole. While one is busy a tap on the words
 * closes nothing, since the toast waits for its answer.
 */
export function ToastNote(props: { toast: Toast; onDismiss(): void; form?: "stack" | "row" | "whole"; onWhole?(): void; onShrink?(): void; onPress?(index: number): void }) {
  const t = props.toast;
  const form = props.form ?? "stack";
  const tone = NOTICE_TONES[t.tone === "error" ? "danger" : "info"];
  const look: CSSProperties = {
    pointerEvents: "auto",
    width: "100%",
    maxWidth: TOAST_MAX_PX,
    minHeight: theme.touch,
    borderRadius: theme.radius.md,
    background: tone.fill,
    border: `${theme.line.border}px solid ${tone.outline}`,
    color: tone.text,
    fontFamily: theme.font.body,
    fontSize: theme.font.body14,
    lineHeight: theme.leading.body,
    textAlign: "left",
    boxShadow: theme.shadow.float,
  };
  const action = t.action;
  const sends = t.actions ?? [];
  const row = form === "row";
  const whole = form === "whole";
  const buttons = action !== undefined || sends.length > 0;
  const boxed = row || buttons;
  const waits = t.busy !== undefined;
  const wordsStyle: CSSProperties = row
    ? { flex: "1 1 auto", minWidth: theme.touch, padding: `0 ${theme.space(2)}px 0 ${theme.space(3)}px`, background: "transparent", border: "none", color: "inherit", font: "inherit", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }
    : buttons
      ? { flex: "1 1 200px", minWidth: 0, minHeight: theme.touch, padding: 0, background: "transparent", border: "none", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" }
      : { ...look, padding: `${theme.space(2)}px ${whole ? theme.touch : theme.space(3)}px ${theme.space(2)}px ${theme.space(3)}px`, cursor: "pointer" };
  // Keep the same controls at the same React positions when a resize changes
  // the form. Only their layout changes, so a focused action is never detached.
  return (
    <div data-toast-form={whole ? "whole" : undefined} style={whole ? { position: "relative", width: "100%", maxWidth: TOAST_MAX_PX, pointerEvents: "auto" } : { display: "flex", flexDirection: "column", width: "100%", maxWidth: row ? "none" : TOAST_MAX_PX }}>
      <div
        data-toast={boxed ? "" : undefined}
        data-toast-form={row ? "row" : undefined}
        style={row
          ? { ...look, maxWidth: "none", height: theme.touch, minHeight: 0, boxSizing: "border-box", border: "none", outline: `${theme.line.border}px solid ${tone.outline}`, outlineOffset: -theme.line.border, display: "flex", alignItems: "stretch", overflow: "hidden" }
          : buttons
            ? { ...look, display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(2), padding: `${theme.space(1)}px ${whole ? theme.touch : theme.space(2)}px ${theme.space(1)}px ${theme.space(3)}px` }
            : { display: "contents" }}
      >
        <button type="button" data-toast={boxed ? undefined : ""} aria-label={row ? t.text : undefined} onClick={row ? props.onWhole : waits ? undefined : props.onDismiss} style={wordsStyle}>
          {!row && !buttons && t.die ? <ToastD20 die={t.die} text={t.text} /> : t.text}
        </button>
        {action ? (
          <Button
            size="sm"
            onClick={() => {
              // A button not ready, such as Forget and undo while a builder gesture waits, does nothing and keeps the toast.
              if (action.ready?.() === false) return;
              props.onDismiss();
              action.run();
            }}
            style={{ flex: "none", ...(row ? { height: theme.touch, minHeight: theme.touch } : null) }}
          >
            {action.label}
          </Button>
        ) : null}
        {sends.length > 0 ? (
          // The group says its label, so the label's own words are not said twice. No hook here: the form tests call this as a function.
          <div role="group" aria-label={t.actionsLabel} data-toast-sends="" hidden={row} style={{ flex: "1 1 100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
            <span aria-hidden="true" style={{ fontSize: theme.font.small, color: tone.text, marginRight: theme.space(1) }}>
              {t.actionsLabel}
            </span>
            {sends.map((send, i) => (
              <Button
                key={i}
                size="sm"
                busy={t.busy === i}
                disabled={waits && t.busy !== i}
                aria-label={send.name}
                onClick={() => props.onPress?.(i)}
                // Each grows to share its line, so one that wraps alone fills its line.
                style={{ flex: "1 1 auto", maxWidth: "100%", whiteSpace: "normal", textAlign: "center" }}
              >
                {send.label}
              </Button>
            ))}
          </div>
        ) : null}
        {t.said && !row ? (
          <p role="alert" style={{ flex: "1 1 100%", margin: 0, fontSize: theme.font.small, overflowWrap: "anywhere" }}>
            {t.said}
          </p>
        ) : null}
      </div>
      {whole ? <IconButton icon="close" label="Close" onClick={props.onShrink} style={{ position: "absolute", top: 0, right: 0 }} /> : null}
    </div>
  );
}

/** The toast die's size, and its ring's gap and width, in CSS px. */
const TOAST_DIE_PX = 28;
const TOAST_RING_GAP_PX = 3;
const TOAST_RING_PX = 2;

/**
 * Someone else's D20 Test leads with a flat d20 showing its kept face
 * (docs/design/design-v1-roll-animation.md 4), in the app's neutral colors, never
 * the roller's set. A natural 20 or a critical hit rings once in the accent,
 * and a natural 1 is outlined in danger. The icon is hidden from a screen
 * reader, so the verdict follows the text as hidden words.
 */
function ToastD20(props: { die: ToastDie; text: ReactNode }) {
  const { die } = props;
  const outer = TOAST_DIE_PX / 2 + TOAST_RING_GAP_PX + TOAST_RING_PX;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
      <span data-toast-die={die.face} style={{ position: "relative", flex: "none", width: TOAST_DIE_PX, height: TOAST_DIE_PX }}>
        <D20Icon size={TOAST_DIE_PX} text={String(die.face)} body={theme.color.surface} edge={theme.color.textMuted} ink={theme.color.text} {...(die.fumble ? { outline: theme.color.danger } : {})} />
        {die.ring ? (
          <span
            aria-hidden="true"
            data-toast-ring=""
            style={{
              position: "absolute",
              left: TOAST_DIE_PX / 2 - outer,
              top: TOAST_DIE_PX / 2 - outer,
              width: 2 * outer,
              height: 2 * outer,
              boxSizing: "border-box",
              borderRadius: theme.radius.round,
              border: `${TOAST_RING_PX}px solid ${theme.color.accent}`,
              opacity: 0.95,
              animation: "rvtt-tray-ring 520ms ease-out both",
            }}
          />
        ) : null}
      </span>
      <span>
        {props.text}
        {die.verdict ? <span style={VISUALLY_HIDDEN}> {die.verdict}.</span> : null}
      </span>
    </span>
  );
}

/**
 * The toasts' two stacks, the notices' and the layer's. Both stay drawn while
 * empty, so React cannot detach a stack whose focused action has not yet moved
 * to the other (review FU39-ASTRA-01).
 */
export function toastStacks(a: { layer: HTMLElement | null; lowAt: { top: number; edges: ToastEdges | null } | null; stacks: { notices: ReturnType<typeof useToastStack>; layer: ReturnType<typeof useToastStack> } }): ReactNode {
  return (
    <>
      <ToastStack stack={a.stacks.notices} style={{ width: "100%" }} />
      {a.layer
        ? createPortal(
            // Below the drawn column cards, take their edges. Under a pane's header, span the map as the notices do.
            <ToastStack stack={a.stacks.layer} style={{ position: "absolute", top: a.lowAt?.top ?? 0, ...(a.lowAt?.edges ? { left: a.lowAt.edges.left, right: a.lowAt.edges.right } : { left: 0, right: 0, padding: `0 ${theme.space(3)}px` }) }} />,
            a.layer,
          )
        : null}
    </>
  );
}

/**
 * A portal per drawn toast, into the host the toast keeps (toastHostOf). The
 * key and the host do not change with the toast's form, so a form change
 * never remounts its buttons.
 */
export function toastPortals(a: {
  drawn: readonly Toast[];
  rowToast: Toast | undefined;
  wholeToast: Toast | undefined;
  hostOf(id: number): HTMLElement;
  dismiss(id: number): void;
  showWhole(id: number): void;
  shrink(): void;
  /** A press on one of a toast's buttons that wait on the server (ToastNote `onPress`). */
  press?(id: number, index: number): void;
}): ReactNode[] {
  return a.drawn.map((t) =>
    createPortal(
      <ToastNote toast={t} form={toastForm(t.id, a.rowToast, a.wholeToast)} onDismiss={() => a.dismiss(t.id)} onWhole={() => a.showWhole(t.id)} onShrink={a.shrink} onPress={(i) => a.press?.(t.id, i)} />,
      a.hostOf(t.id),
      toastPortalKey(t.id),
    ),
  );
}

/** The form a toast takes: the one row over the top bar, that row shown whole, or the usual stack. */
export function toastForm(id: number, rowToast: Toast | undefined, wholeToast: Toast | undefined): "stack" | "row" | "whole" {
  return id === rowToast?.id ? (wholeToast ? "whole" : "row") : "stack";
}

/**
 * The one row's box over the top bar's row, 4 px from the safe top, as wide as
 * the layer less its sides and `right`, what stands over the top bar's row at
 * the right (toastPlacement.ts phoneToastRoom). Whole, it stands from the safe
 * top down. Its stack stays mounted while empty, until its focused host moves out.
 */
export function toastRow(a: { layer: HTMLElement | null; rowBox: RefObject<HTMLDivElement | null>; rowStack: RefObject<HTMLDivElement | null>; safeTop: number; right: number; whole: boolean }): ReactNode {
  if (!a.layer) return null;
  return createPortal(
    <div ref={a.rowBox} data-toast-over-bars="" style={{ position: "absolute", top: a.safeTop + (a.whole ? 0 : TOAST_ROW_TOP), left: 0, right: a.right, padding: `0 ${theme.space(3)}px`, display: "flex", justifyContent: "center" }}>
      <div ref={a.rowStack} style={{ display: "contents" }} />
    </div>,
    a.layer,
  );
}
