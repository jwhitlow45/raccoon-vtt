import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { Button } from "../../components/Button.tsx";
import { fieldStyle } from "../../components/Field.tsx";
import { isAppleDevice, isCoarsePointer } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import { useScopedIfAny } from "../../state/scope.ts";
import { isIos } from "../uvtt/limits.ts";
import { boxHint, boxLine } from "./paste.ts";
import { PasteControl, pasteSlot, type PasteRegistration, type PasteSpec, type PasteView } from "./pasteRouter.ts";

/**
 * Pasting into an image entry (docs/design-v1-paste.md 1.2, 2.2 and 3.3):
 * `usePasteTarget` registers the entry with its Room page's router, so a
 * key paste can land there, and gives the Paste button and the paste box
 * their state. A pasted image goes to the handler the entry's file control
 * already calls, so it keeps that entry's every rule.
 */

export type PasteHandle = PasteView & {
  /** The Paste button's press: reads the clipboard, or opens the box where the browser will not. */
  press(): void;
  closeBox(): void;
  /** The entry is busy or reading: its Paste button is disabled by the same rule as its file control. */
  disabled: boolean;
  control: PasteControl;
};

function clipboardRead(): (() => Promise<readonly ClipboardItem[]>) | null {
  if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.read !== "function") return null;
  return () => navigator.clipboard.read();
}

/**
 * Registers `ref`'s element as an entry. The element must have a box of
 * its own, never `display: contents`, since the router asks it whether it
 * is shown. The spec is read afresh at each paste, so a change to it never
 * makes the entry newer than one opened after it.
 */
export function usePasteTarget(ref: RefObject<HTMLElement | null>, spec: PasteSpec): PasteHandle {
  const latest = useRef(spec);
  latest.current = spec;
  const [, changed] = useReducer((n: number) => n + 1, 0);
  const [control] = useState(
    () =>
      new PasteControl({
        spec: () => latest.current,
        read: clipboardRead(),
        now: () => new Date(),
        ios: typeof navigator !== "undefined" && isIos({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }),
        boxHint: boxHint({ touch: isCoarsePointer(), apple: isAppleDevice() }),
        onChange: changed,
      }),
  );
  const registry = useScopedIfAny(pasteSlot);
  const entry = useRef<PasteRegistration | null>(null);
  useEffect(() => {
    control.attach();
    if (!registry) return () => control.detach();
    const mine: PasteRegistration = { seq: ++registry.seq, el: () => ref.current, takes: () => latest.current.takes, control };
    entry.current = mine;
    registry.targets.add(mine);
    return () => {
      registry.targets.delete(mine);
      entry.current = null;
      control.detach();
    };
  }, [registry, control, ref]);
  // "The newest open entry" is the one opened last, such as a form opened after another, not the one mounted last.
  const opens = spec.takes === "open";
  useEffect(() => {
    if (opens && registry && entry.current) entry.current.seq = ++registry.seq;
  }, [opens, registry]);
  const view = control.view;
  return { ...view, press: () => control.press(), closeBox: () => control.closeBox(), disabled: spec.disabled || view.reading, control };
}

/**
 * "Paste an image", a secondary button beside the entry's file control
 * (2.2). Busy while the browser answers, which may include its permission
 * prompt or iOS's own Paste callout, and a second press waits.
 */
export function PasteButton(props: { paste: PasteHandle; label?: string; size?: "md" | "sm" }) {
  const { paste } = props;
  return (
    <Button size={props.size ?? "sm"} disabled={!paste.reading && paste.disabled} busy={paste.reading} onClick={paste.press}>
      {props.label ?? "Paste an image"}
    </Button>
  );
}

/**
 * What a paste left under its entry: its note, and the paste box while it
 * is open. `only="note"` leaves the box out, for a picker tab other than
 * the one its Paste button is on.
 */
export function PasteStatus(props: { paste: PasteHandle; only?: "note" }) {
  const { paste } = props;
  return (
    <>
      {paste.note ? (
        <p
          role={paste.note.tone === "error" ? "alert" : "status"}
          style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: paste.note.tone === "error" ? theme.color.dangerText : theme.color.textMuted }}
        >
          {paste.note.text}
        </p>
      ) : null}
      {paste.box && props.only !== "note" ? <PasteBox paste={paste} /> : null}
    </>
  );
}

/**
 * The floor every browser meets (3.3): an editable box a phone's long
 * press offers Paste in, images included, where `read()` is missing or
 * refused. A paste event into an editable element needs no permission.
 *
 * It must be `contenteditable`, never `plaintext-only` and never an input:
 * iOS offers no Paste for a picture in a text input, nor in plain-text
 * editing. `inputmode="none"` keeps the keyboard closed. Its own paste
 * handler takes the image and cancels the event, so nothing is inserted
 * and the router, which cancelled pastes skip, passes it on to nothing.
 * Typing and drops are refused.
 */
function PasteBox(props: { paste: PasteHandle }) {
  const { paste } = props;
  const box = useRef<HTMLDivElement>(null);
  const control = paste.control;
  const line = boxLine({ touch: isCoarsePointer(), apple: isAppleDevice() });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      if (e.clipboardData) control.fromBox(e.clipboardData);
    };
    const refuse = (e: Event) => e.preventDefault();
    el.addEventListener("paste", onPaste);
    el.addEventListener("beforeinput", refuse);
    el.addEventListener("drop", refuse);
    // On a computer the box is where Ctrl+V goes next. A phone's press and hold needs no focus first.
    if (!isCoarsePointer()) el.focus({ preventScroll: true });
    return () => {
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("beforeinput", refuse);
      el.removeEventListener("drop", refuse);
    };
  }, [control]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
      <div style={{ position: "relative", flex: "1 1 200px", minWidth: 0 }}>
        <div
          ref={box}
          role="textbox"
          aria-label={line}
          aria-multiline={false}
          contentEditable
          suppressContentEditableWarning
          inputMode="none"
          spellCheck={false}
          // Anything that got in some other way, such as an IME's composition, goes at once.
          onInput={(e) => {
            e.currentTarget.textContent = "";
          }}
          style={{ ...fieldStyle(), minHeight: theme.touch, width: "100%", boxSizing: "border-box", caretColor: "transparent", cursor: "text", overflow: "hidden", whiteSpace: "nowrap" }}
        />
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            padding: `0 ${theme.space(3)}px`,
            color: theme.color.textMuted,
            fontSize: theme.font.body14,
            pointerEvents: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {line}
        </span>
      </div>
      <Button size="sm" onClick={paste.closeBox}>
        Cancel
      </Button>
    </div>
  );
}
