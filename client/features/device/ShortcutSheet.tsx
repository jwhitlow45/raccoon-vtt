import { useCallback, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { sheetDevice } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { setShortcutSheet, sheetSections, shortcutSheetSlot } from "../../state/shortcuts.ts";

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
  if (open && !wasOpen.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;
  if (!open) return null;
  return (
    <Dialog title="Shortcuts" width="sm" phone="fill" opener={opener} backClose onClose={() => setShortcutSheet(scope, false)}>
      <ShortcutList role={props.role} />
    </Dialog>
  );
}

export function ShortcutList(props: { role: "dm" | "player" }) {
  const sections = sheetSections(props.role, sheetDevice());
  return (
    <div style={{ display: "grid" }}>
      {sections.map((section, i) => (
        <Section key={section.title} label={section.title} divider={i > 0}>
          {section.intro ? <Help>{section.intro}</Help> : null}
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: theme.font.body14 }}>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.id} style={{ borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
                  <th scope="row" style={row.keys ? KEY_CELL : INPUT_CELL}>
                    {row.keys ? <KeyInput text={row.input} /> : row.input}
                  </th>
                  <td style={{ padding: `${theme.space(2)}px 0`, color: theme.color.text, verticalAlign: "top" }}>
                    {row.does}
                    {row.when ? <span style={WHEN}>{capitalized(row.when)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ))}
    </div>
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

/** The condition beyond the role, under what the row does: "With the Select tool". */
const WHEN: CSSProperties = { display: "block", color: theme.color.textMuted, fontSize: theme.font.small };
