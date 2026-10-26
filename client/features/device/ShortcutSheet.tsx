import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { hasKeyboard, sheetDevice } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import { captureKey, changeKey, holder, keyLabel, keysInEffect, resetKey, swapKey, UNBOUND } from "../../state/keyBindings.ts";
import { useRoomScope } from "../../state/scope.ts";
import { DEFAULT_KEYS, setShortcutSheet, sheetSections, SHORTCUTS, shortcutSheetSlot, useShortcutKeys, type SheetRow } from "../../state/shortcuts.ts";
import { ConfirmButton } from "../scenes/controls.tsx";
import { keyChanges, setKeyChanges } from "./settings.ts";

/**
 * The shortcut sheet (docs/design-v1-dm-tools.md 3.14): the keys this role
 * has, then the keys and buttons that change a click, a drag or the wheel,
 * then the keys that work inside one surface, all from the registries in
 * state/shortcuts.ts, so the sheet and the app never disagree. `?` opens
 * it, and so does Menu, This device. Mounted once by the Room page.
 *
 * The mouse's rows show where there is a mouse or trackpad. The sheet
 * reads the device each time it opens, so a mouse paired with a tablet
 * shows on the next look. Each section is a heading and a table, never a
 * landmark: a dozen landmarks in one dialog would bury the room's own.
 *
 * With a keyboard (lib/device.ts hasKeyboard), each single key has Change,
 * which waits for the next press, and Reset once changed, and the foot has
 * Reset all keys (state/keyBindings.ts). The changes are this device's,
 * kept beside its other settings (settings.ts). A touch screen's sheet
 * stays a plain list, since it has no key to press.
 *
 * The shared dialog (docs/design-v1-visual.md 3.5): a narrow card on a
 * computer, the whole screen on a phone, where the list runs long.
 */
export function ShortcutSheetHost(props: { role: "dm" | "player" }) {
  const scope = useRoomScope();
  const slot = scope.get(shortcutSheetSlot);
  const subscribe = useCallback(
    (listener: () => void) => {
      slot.listeners.add(listener);
      return () => slot.listeners.delete(listener);
    },
    [slot],
  );
  const open = useSyncExternalStore(subscribe, () => slot.open);
  // Focus goes back to whatever had it as the sheet opened: the menu's button, or the page after a key press.
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [said, setSaid] = useState("");
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  if (!open) return null;
  const rebind = hasKeyboard();
  return (
    <Dialog
      title="Shortcuts"
      width="sm"
      phone="fill"
      opener={opener}
      backClose
      onClose={() => {
        setSaid("");
        setShortcutSheet(scope, false);
      }}
      footer={
        rebind ? (
          <ConfirmButton
            label="Reset all keys"
            confirm="Tap again to reset all keys"
            onConfirm={() => {
              setKeyChanges({});
              setSaid("Every key is back to its default.");
            }}
          />
        ) : undefined
      }
    >
      <ShortcutList role={props.role} rebind={rebind} say={setSaid} />
      {/* One polite line for every change and question, so a screen reader hears each once. The rows show the same words. */}
      {rebind ? (
        <div role="status" style={VISUALLY_HIDDEN}>
          {said}
        </div>
      ) : null}
    </Dialog>
  );
}

/** A key as the sheet says it aloud, "no key" for a row whose default another row's change took. */
const spoken = (key: string) => (key === UNBOUND ? "no key" : keyLabel(key));

/** A row waiting for its key, refused one, or asked for one another row has. */
type Editing = { id: string; step: "listening"; refused?: string } | { id: string; step: "taken"; key: string; by: string };

export function ShortcutList(props: { role: "dm" | "player"; rebind?: boolean; say?(text: string): void }) {
  const keys = useShortcutKeys();
  const sections = sheetSections(props.role, sheetDevice(), keys);
  const rebind = props.rebind === true;
  const [editing, setEditing] = useState<Editing | null>(null);
  const changeButtons = useRef(new Map<string, HTMLButtonElement>());
  const swapButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the next render is drawn: a row's Change, or the Swap of a key already taken.
  const focusNext = useRef<string | "swap" | null>(null);
  const { say = () => {} } = props;

  useEffect(() => {
    const next = focusNext.current;
    if (next === null) return;
    focusNext.current = null;
    // Scrolled to where needed: a taken key's Swap sits under its row, past the bottom of a long list.
    (next === "swap" ? swapButton.current : changeButtons.current.get(next))?.focus();
  });

  const nameOf = useCallback(
    (id: string) => {
      const s = SHORTCUTS.find((row) => row.id === id);
      if (!s?.name) return id;
      // Uniqueness covers the whole device, so a player's key may be taken by the DM's Fog.
      return s.roles.includes(props.role) ? s.name : `${s.name}, ${s.roles.includes("dm") ? "a DM key" : "a player key"}`;
    },
    [props.role],
  );

  /*
   * While a row waits, the next press is its key, ahead of everything
   * else: the window's capture phase, used and stopped there, so the
   * dialog's Escape, its Tab wrapping and the room's own keys never see
   * it. Focus may not be on Change at all (Safari leaves a clicked button
   * unfocused), which is why it is the window's.
   */
  const listening = editing?.step === "listening" ? editing.id : null;
  useEffect(() => {
    if (listening === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const name = nameOf(listening);
      const got = captureKey(e);
      if (got.t === "wait") return;
      if (got.t === "cancel") {
        setEditing(null);
        say(`${name} keeps ${spoken(keys[listening] ?? "")}.`);
        return;
      }
      if (got.t === "refused") {
        setEditing({ id: listening, step: "listening", refused: got.reason });
        say(`${got.reason} Press another key, or Escape to cancel.`);
        return;
      }
      const result = changeKey(DEFAULT_KEYS, keyChanges(), listening, got.key);
      if (result.t === "taken") {
        setEditing({ id: listening, step: "taken", key: got.key, by: result.by });
        focusNext.current = "swap";
        say(`${keyLabel(got.key)} is already used by ${nameOf(result.by)}. Swap the two keys, or cancel.`);
        return;
      }
      setKeyChanges(result.changes);
      setEditing(null);
      say(`${name} is now ${keyLabel(got.key)}.`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, keys, nameOf, say]);

  // Asked to swap, Escape is Cancel rather than the sheet's close, and every other key works Swap and Cancel as usual.
  const asking = editing?.step === "taken" ? editing.id : null;
  useEffect(() => {
    if (asking === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setEditing(null);
      focusNext.current = asking;
      say(`${nameOf(asking)} keeps ${spoken(keys[asking] ?? "")}.`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [asking, keys, nameOf, say]);

  const actions: RowActions = {
    change(id, button) {
      if (editing?.step === "listening" && editing.id === id) return;
      button.focus({ preventScroll: true });
      setEditing({ id, step: "listening" });
      say(`Press a key for ${nameOf(id)}, or Escape to cancel.`);
    },
    leave(id) {
      // Focus left a waiting row: a click elsewhere, or another row's Change, which then waits itself.
      setEditing((now) => (now?.step === "listening" && now.id === id ? null : now));
    },
    swap() {
      if (editing?.step !== "taken") return;
      const next = swapKey(DEFAULT_KEYS, keyChanges(), editing.id, editing.key);
      setKeyChanges(next);
      setEditing(null);
      focusNext.current = editing.id;
      // Read back, not assumed: swapped with a row that had no key, the other takes its own default again.
      say(`${nameOf(editing.id)} is now ${keyLabel(editing.key)}, and ${nameOf(editing.by)} is now ${spoken(keysInEffect(DEFAULT_KEYS, next)[editing.by] ?? "")}.`);
    },
    cancel() {
      if (!editing) return;
      setEditing(null);
      focusNext.current = editing.id;
      say(`${nameOf(editing.id)} keeps ${spoken(keys[editing.id] ?? "")}.`);
    },
    reset(id) {
      const own = DEFAULT_KEYS[id] ?? "";
      // Where another row has taken the default since, the two swap (keyBindings.ts resetKey).
      const moved = holder(keys, id, own);
      const next = resetKey(DEFAULT_KEYS, keyChanges(), id);
      setKeyChanges(next);
      setEditing(null);
      focusNext.current = id;
      const back = `${nameOf(id)} is back to ${keyLabel(own)}`;
      say(moved ? `${back}, and ${nameOf(moved)} is now ${spoken(keysInEffect(DEFAULT_KEYS, next)[moved] ?? "")}.` : `${back}.`);
    },
    ref(id, el) {
      if (el) changeButtons.current.set(id, el);
      else changeButtons.current.delete(id);
    },
    swapRef: swapButton,
  };

  return (
    <div style={{ display: "grid" }}>
      {sections.map((section, i) => {
        const controls = rebind && section.rows.some((row) => row.rebind);
        return (
          <Section key={section.title} label={section.title} divider={i > 0}>
            {section.intro ? <Help>{section.intro}</Help> : null}
            {controls ? <Help>Change gives a key another letter, digit or symbol, on this device only.</Help> : null}
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: theme.font.body14 }}>
              <tbody>
                {section.rows.map((row) => (
                  <KeyRows key={row.id} row={row} controls={controls} editing={editing?.id === row.id ? editing : null} takenBy={editing?.step === "taken" && editing.id === row.id ? nameOf(editing.by) : ""} actions={actions} />
                ))}
              </tbody>
            </table>
          </Section>
        );
      })}
    </div>
  );
}

type RowActions = {
  change(id: string, button: HTMLButtonElement): void;
  leave(id: string): void;
  swap(): void;
  cancel(): void;
  reset(id: string): void;
  ref(id: string, el: HTMLButtonElement | null): void;
  swapRef: RefObject<HTMLButtonElement | null>;
};

/**
 * One row of the sheet, and with `controls` a third cell for its Change
 * and Reset. While the row waits, or its key is taken, a line under it
 * says so, with Swap and Cancel for a taken key.
 */
function KeyRows(props: { row: SheetRow; controls: boolean; editing: Editing | null; takenBy: string; actions: RowActions }) {
  const { row, editing, actions } = props;
  const lineId = `rvtt-key-${row.id}`;
  const border = `${theme.line.border}px solid ${theme.color.border}`;
  // The line under a row that waits shows in full, as the row may be the last one in view.
  const line = useRef<HTMLTableRowElement>(null);
  const step = editing ? `${editing.step}:${editing.step === "listening" ? (editing.refused ?? "") : editing.by}` : null;
  useEffect(() => {
    if (step !== null) line.current?.scrollIntoView({ block: "nearest" });
  }, [step]);
  // Beside a 44 px Change, the key and its words sit at its middle.
  const align: CSSProperties | null = props.controls ? { verticalAlign: "middle" } : null;
  return (
    <>
      <tr style={{ borderTop: border }}>
        <th scope="row" style={{ ...(row.keys ? KEY_CELL : INPUT_CELL), ...align }}>
          {row.keys ? <KeyInput text={row.input} /> : row.input}
        </th>
        <td style={{ padding: `${theme.space(2)}px 0`, color: theme.color.text, verticalAlign: "top", ...align }}>
          {row.does}
          {row.when ? <span style={WHEN}>{capitalized(row.when)}</span> : null}
        </td>
        {props.controls ? (
          <td style={CONTROLS_CELL}>
            {row.rebind ? (
              <div style={CONTROLS}>
                <Button
                  ref={(el) => actions.ref(row.id, el)}
                  size="sm"
                  aria-label={`Change the key for ${row.rebind.name}`}
                  aria-describedby={editing ? lineId : undefined}
                  onClick={(e) => actions.change(row.id, e.currentTarget)}
                  onBlur={() => actions.leave(row.id)}
                  style={editing?.step === "listening" ? { borderColor: theme.color.accent } : undefined}
                >
                  Change
                </Button>
                {row.rebind.changed ? (
                  <Button size="sm" variant="quiet" aria-label={`Reset the key for ${row.rebind.name}`} onClick={() => actions.reset(row.id)}>
                    Reset
                  </Button>
                ) : null}
              </div>
            ) : null}
          </td>
        ) : null}
      </tr>
      {editing ? (
        <tr ref={line}>
          <td colSpan={3} style={{ padding: `0 0 ${theme.space(2)}px` }}>
            <div id={lineId} style={{ fontSize: theme.font.small, color: editing.step === "listening" && editing.refused ? theme.color.dangerText : theme.color.text }}>
              {editing.step === "listening"
                ? editing.refused
                  ? `${editing.refused} Press another key, or Escape to cancel.`
                  : "Press a key, or Escape to cancel."
                : `Already ${props.takenBy}.`}
            </div>
            {editing.step === "taken" ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), marginTop: theme.space(1) }}>
                <Button ref={actions.swapRef} size="sm" variant="primary" aria-describedby={lineId} onClick={actions.swap}>
                  Swap
                </Button>
                <Button size="sm" onClick={actions.cancel}>
                  Cancel
                </Button>
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Keys in their keycaps, one per key or chord, and a trailing note such as
 * "(Cmd+V on a Mac)" as muted text under them. A keycap breaks only past
 * the length KBD allows, so the row wraps between keycaps and in the note
 * instead: one keycap holding "Page Up, Page Down" or a long note would
 * push the sheet past a narrow phone at a large interface size.
 */
function KeyInput(props: { text: string }) {
  const note = /^(.+?) (\(.+\))$/.exec(props.text);
  const keys = (note?.[1] ?? props.text).split(", ");
  return (
    <>
      {keys.map((key, i) => (
        <span key={i}>
          {i > 0 ? ", " : null}
          <kbd style={KBD}>{key}</kbd>
        </span>
      ))}
      {note ? (
        <>
          {" "}
          <span style={KEY_NOTE}>{note[2]}</span>
        </>
      ) : null}
    </>
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const KEY_CELL: CSSProperties = {
  padding: `${theme.space(2)}px ${theme.space(3)}px ${theme.space(2)}px 0`,
  textAlign: "left",
  verticalAlign: "top",
};

/** What you do with the mouse is a phrase, which wraps in a column of about half the card. */
const INPUT_CELL: CSSProperties = {
  ...KEY_CELL,
  width: "45%",
  fontWeight: theme.weight.strong,
};

/**
 * A keycap keeps a key or chord on one line, and one with words after it,
 * such as "Shift+Tab in the list", wraps inside it past 14 characters. On
 * one line it ran the sheet past a 320 px phone at 130%. The keycap is as
 * wide as its text up to that, so the table never squeezes a shorter one
 * onto two lines. The width counts the padding and border, as every box does.
 */
const KBD: CSSProperties = {
  display: "inline-block",
  width: "max-content",
  maxWidth: `calc(14ch + ${2 * (theme.space(1.5) + theme.line.border)}px)`,
  whiteSpace: "normal",
  fontFamily: theme.font.mono,
  fontSize: theme.font.small,
  padding: `${theme.space(0.5)}px ${theme.space(1.5)}px`,
  borderRadius: theme.radius.sm,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
};

const KEY_NOTE: CSSProperties = { display: "block", whiteSpace: "normal", color: theme.color.textMuted, fontSize: theme.font.small, fontWeight: theme.weight.regular, marginTop: theme.space(1) };

/** Change and Reset, at the row's end, as narrow as their words. */
const CONTROLS_CELL: CSSProperties = { padding: `${theme.space(1)}px 0 ${theme.space(1)}px ${theme.space(2)}px`, verticalAlign: "top", width: "1%", whiteSpace: "nowrap" };

/**
 * Change above Reset, at the right. The column is the buttons' own width.
 * The table sizes this cell at its narrowest, and a grid's auto column
 * there stops at its buttons' 44 px minimum, so Change, wider than that,
 * ran left over the row's words. A max-content column holds the widest
 * button whole at any interface size, and the words wrap beside it.
 */
const CONTROLS: CSSProperties = { display: "grid", gridTemplateColumns: "max-content", justifyItems: "end", gap: theme.space(1) };

/** The condition beyond the role, under what the row does: "With the Select tool". */
const WHEN: CSSProperties = { display: "block", color: theme.color.textMuted, fontSize: theme.font.small };
