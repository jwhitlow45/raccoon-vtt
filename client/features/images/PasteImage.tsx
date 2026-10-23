import { useEffect, useId, useReducer, useRef, useState, type RefObject } from "react";
import { Button } from "../../components/Button.tsx";
import { ErrorText, fieldStyle } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
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
  /** The entry is busy, closed or reading: its Paste button is disabled by the same rule as its file control. */
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
  /*
   * The box and the note close with their entry (design 3.3), and a read
   * still waiting stops counting: when the entry says it closed, and when
   * its element leaves the page while the component stays, as a form that
   * folds away does.
   */
  const closed = spec.closed === true;
  useEffect(() => {
    if (closed) control.close();
  }, [closed, control]);
  const drawn = useRef(false);
  useEffect(() => {
    const now = ref.current !== null;
    if (drawn.current && !now) control.close();
    drawn.current = now;
  });
  const view = control.view;
  return { ...view, press: () => control.press(), closeBox: () => control.closeBox(), disabled: spec.disabled || closed || view.reading, control };
}

const PASTING = "Pasting…";

/**
 * "Paste an image", a secondary button beside the entry's file control
 * (2.2). Busy while the browser answers, which may include its permission
 * prompt or iOS's own Paste callout, and a second press waits. A busy
 * button names its wait (docs/design-v1-look-pass-2.md 2.2).
 */
export function PasteButton(props: { paste: PasteHandle; label?: string; size?: "md" | "sm" }) {
  const { paste } = props;
  return (
    <Button size={props.size ?? "sm"} disabled={!paste.reading && paste.disabled} busy={paste.reading} onClick={paste.press}>
      {paste.reading ? PASTING : (props.label ?? "Paste an image")}
    </Button>
  );
}

/**
 * What a paste left under its entry: its note, and the paste box while it
 * is open. `only` shows one of the two, for a dialog that shows its notes
 * above its tabs, in view whichever tab is open, and the box by its button.
 */
export function PasteStatus(props: { paste: PasteHandle; only?: "note" | "box" }) {
  const { paste } = props;
  return (
    <>
      {/* An error in the one look every paste error has, and anything else as help (docs/design-v1-look-pass-2.md 2.9). */}
      {paste.note && props.only !== "box" ? (
        paste.note.tone === "error" ? (
          <ErrorText>{paste.note.text}</ErrorText>
        ) : (
          <div role="status">
            <Help>{paste.note.text}</Help>
          </div>
        )
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
  const lineId = useId();
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
    // In view, since its words may sit above a dialog's tabs. On a computer it is where Ctrl+V goes next. A phone's press and hold needs no focus first.
    el.scrollIntoView({ block: "nearest" });
    if (!isCoarsePointer()) el.focus({ preventScroll: true });
    return () => {
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("beforeinput", refuse);
      el.removeEventListener("drop", refuse);
    };
  }, [control]);
  // Its words stand over it as its label, never inside it, where they read as a placeholder with nothing to type.
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <Help id={lineId}>{line}</Help>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        <div
          ref={box}
          role="textbox"
          aria-labelledby={lineId}
          aria-multiline={false}
          contentEditable
          suppressContentEditableWarning
          inputMode="none"
          spellCheck={false}
          // Anything that got in some other way, such as an IME's composition, goes at once.
          onInput={(e) => {
            e.currentTarget.textContent = "";
          }}
          style={{ ...fieldStyle(), flex: "1 1 200px", minWidth: 0, minHeight: theme.touch, boxSizing: "border-box", caretColor: "transparent", cursor: "text", overflow: "hidden", whiteSpace: "nowrap" }}
        />
        <Button size="sm" onClick={paste.closeBox}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
