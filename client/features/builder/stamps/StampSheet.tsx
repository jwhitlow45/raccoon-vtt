import type { ReactNode } from "react";
import { Dialog } from "../../../components/Dialog.tsx";
import { theme } from "../../../lib/theme.ts";

/**
 * A small sheet at the foot of the screen for the selected stamp's tint and
 * its less used buttons on a phone, so the options bar keeps to two rows
 * over the map. It is the one Dialog shell in its `sheet` shape
 * (docs/design-v1-visual.md 2.3), over the light scrim rather than the
 * usual dim, so the stamp stays in view while each choice applies to it.
 * Escape, Back, the close button or a tap above it closes it.
 */
export function StampSheet(props: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <Dialog title={props.title} onClose={props.onClose} width="sm" phone="sheet" scrim={theme.color.scrimLight} backClose>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>{props.children}</div>
    </Dialog>
  );
}
