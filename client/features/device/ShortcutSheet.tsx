import { useCallback, useRef, useSyncExternalStore } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { setShortcutSheet, shortcutSheetSlot, shortcutsFor } from "../../state/shortcuts.ts";

/**
 * The shortcut sheet (docs/design-v1-dm-tools.md 3.14): the keys this role
 * has, from the registry itself, so the sheet and the keys never disagree.
 * `?` opens it, and so does Menu, This device. Mounted once by the Room page.
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
    <Dialog title="Keyboard shortcuts" width="sm" phone="fill" opener={opener} backClose onClose={() => setShortcutSheet(scope, false)}>
      <ShortcutList role={props.role} />
    </Dialog>
  );
}

export function ShortcutList(props: { role: "dm" | "player" }) {
  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      <Help>
        On any device with a keyboard. They do nothing while you type in a field or a window is open. On a Mac, Cmd works where Ctrl is written.
      </Help>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: theme.font.body14 }}>
        <tbody>
          {shortcutsFor(props.role).map((s) => (
            <tr key={s.id} style={{ borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
              <th scope="row" style={{ padding: `${theme.space(2)}px ${theme.space(3)}px ${theme.space(2)}px 0`, textAlign: "left", whiteSpace: "nowrap", verticalAlign: "top" }}>
                <kbd
                  style={{
                    fontFamily: theme.font.mono,
                    fontSize: theme.font.small,
                    padding: `${theme.space(0.5)}px ${theme.space(1.5)}px`,
                    borderRadius: theme.radius.sm,
                    border: `${theme.line.border}px solid ${theme.color.border}`,
                    background: theme.color.surfaceRaised,
                  }}
                >
                  {s.keys}
                </kbd>
              </th>
              <td style={{ padding: `${theme.space(2)}px 0`, color: theme.color.text }}>{s.does}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
