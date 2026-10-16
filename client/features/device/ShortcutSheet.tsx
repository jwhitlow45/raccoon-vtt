import { useCallback, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { pointerKinds } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { setShortcutSheet, sheetSections, shortcutSheetSlot } from "../../state/shortcuts.ts";

/**
 * The shortcut sheet (docs/design-v1-dm-tools.md 3.14): the keys this role
 * has, then what the mouse and touch do, then the keys and gestures that
 * work inside one surface, all from the registries in state/shortcuts.ts,
 * so the sheet and the app never disagree. `?` opens it, and so does Menu,
 * This device. Mounted once by the Room page.
 *
 * Mouse shows on a device with a mouse or trackpad, Touch on one with a
 * touch screen, and both on a laptop with a touch screen. The sheet reads
 * the device each time it opens, so a mouse paired with a tablet shows on
 * the next look.
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
  const sections = sheetSections(props.role, pointerKinds());
  return (
    <div style={{ display: "grid" }}>
      {sections.map((section, i) => (
        <Section key={section.title} label={section.title} region divider={i > 0}>
          {section.intro ? <Help>{section.intro}</Help> : null}
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: theme.font.body14 }}>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.id} style={{ borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
                  <th scope="row" style={row.keys ? KEY_CELL : INPUT_CELL}>
                    {row.keys ? <kbd style={KBD}>{row.input}</kbd> : row.input}
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

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const KEY_CELL: CSSProperties = {
  padding: `${theme.space(2)}px ${theme.space(3)}px ${theme.space(2)}px 0`,
  textAlign: "left",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};

/** What you do with a mouse or a finger is a phrase, which wraps in a column of about half the card. */
const INPUT_CELL: CSSProperties = {
  ...KEY_CELL,
  whiteSpace: "normal",
  width: "45%",
  fontWeight: theme.weight.strong,
};

const KBD: CSSProperties = {
  fontFamily: theme.font.mono,
  fontSize: theme.font.small,
  padding: `${theme.space(0.5)}px ${theme.space(1.5)}px`,
  borderRadius: theme.radius.sm,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
};

/** The condition beyond the role, under what the row does: "With the Select tool". */
const WHEN: CSSProperties = { display: "block", color: theme.color.textMuted, fontSize: theme.font.small };
