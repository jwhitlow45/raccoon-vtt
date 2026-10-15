import { Dialog, type DialogProps } from "../../components/Dialog.tsx";

/**
 * A dialog over the whole room: full screen on a phone, a centered card
 * from 600 px up. A thin wrapper over the shared shell
 * (components/Dialog.tsx), which every dialog now uses, so the callers
 * written against this one keep working unchanged while they move over.
 * It keeps its 600 px card unless a caller names one of the shell's
 * widths.
 */
export function Modal(props: Omit<DialogProps, "phone"> & { phone?: DialogProps["phone"] }) {
  return <Dialog width={600} phone="fill" {...props} />;
}
