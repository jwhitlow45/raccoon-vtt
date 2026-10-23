import type { ReactNode, RefObject } from "react";
import { Dialog, type DialogProps } from "../../components/Dialog.tsx";
import { theme } from "../../lib/theme.ts";

/**
 * A modal sheet over the room: from the bottom on a phone, a centered card
 * from 600 px up, as the monster filters and scene sheets are. A thin
 * wrapper over the shared shell (components/Dialog.tsx) in its `sheet`
 * shape, so the callers written against this one keep working unchanged:
 * the room behind is inert, Escape and Android's Back close it, and focus
 * goes back to what opened it. The group action bar's More and the DM's
 * Request a roll use it.
 */
export function SheetDialog(props: {
  title: string;
  onClose(): void;
  opener?: RefObject<HTMLElement | null>;
  /** The card's width from 600 px up. */
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  status?: DialogProps["status"];
  statusGrow?: DialogProps["statusGrow"];
}) {
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      opener={props.opener}
      width={props.width ?? 480}
      phone="sheet"
      backClose
      footer={props.footer}
      status={props.status}
      statusGrow={props.statusGrow}
      bodyStyle={{ fontSize: theme.font.body14 }}
    >
      {props.children}
    </Dialog>
  );
}
