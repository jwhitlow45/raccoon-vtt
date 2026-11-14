import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../../client/components/Button.tsx";
import { Dialog } from "../../client/components/Dialog.tsx";
import { Spinner, useDelayed } from "../../client/components/Loading.tsx";
import { theme } from "../../client/lib/theme.ts";
import { WORDS } from "../contract.ts";

/** The page's small shared pieces: a titled card, help text, an action hook that refuses a second press, and the confirmation. */

export function Card(props: { id: string; title: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <section
      aria-labelledby={props.id}
      data-card={props.id}
      style={{
        display: "grid",
        gap: theme.space(3),
        padding: theme.space(4),
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        minWidth: 0,
        ...props.style,
      }}
    >
      <h2 id={props.id} style={{ margin: 0, fontSize: theme.font.heading, lineHeight: theme.leading.tight, fontWeight: theme.weight.strong }}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

export function Help(props: { children: ReactNode; role?: "alert" | "status"; tone?: "danger"; style?: CSSProperties }) {
  return (
    <p
      role={props.role}
      style={{
        margin: 0,
        fontSize: theme.font.body14,
        lineHeight: theme.leading.body,
        color: props.tone === "danger" ? theme.color.dangerText : theme.color.textMuted,
        overflowWrap: "anywhere",
        ...props.style,
      }}
    >
      {props.children}
    </p>
  );
}

/** Buttons that wrap as a row, each at its own width. */
export function ButtonRow(props: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), ...props.style }}>{props.children}</div>;
}

/**
 * A slow action (design 9, UI checklist). While it runs, `busy` is true and a
 * second press does nothing, since a button that is busy ignores its click
 * and this guards a keyboard's Enter too. It ends in `error`, a sentence in
 * the window's words, or in nothing when it worked.
 */
export function useAction<A extends unknown[]>(run: (...args: A) => Promise<string | null>): { busy: boolean; error: string | null; start: (...args: A) => Promise<void>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const latest = useRef(run);
  latest.current = run;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  return {
    busy,
    error,
    clear: () => setError(null),
    async start(...args: A) {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      let outcome: string | null;
      try {
        outcome = await latest.current(...args);
      } catch {
        outcome = DID_NOT_ANSWER;
      }
      running.current = false;
      if (!alive.current) return;
      setBusy(false);
      setError(outcome);
    },
  };
}

/** A call that throws means the shell is gone or the call was refused before it ran. */
export const DID_NOT_ANSWER = "RaccoonVTT did not answer. Try again.";

/** A line of status with the shared spinner once the wait passes its delay. The words show at once. */
export function Working(props: { active: boolean; children: ReactNode; style?: CSSProperties }) {
  const spin = useDelayed(props.active);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0, ...props.style }}>
      {spin ? <Spinner size={18} /> : null}
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>{props.children}</div>
    </div>
  );
}

/**
 * A question with two buttons. Focus starts on the safe one (Cancel, Keep
 * running) and Escape cancels, which the dialog does itself. The question
 * carries no heading of its own, so the dialog keeps the words as written.
 */
export function Confirm(props: { name: string; question: string; confirm: string; cancel?: string; danger?: boolean; busy?: boolean; onConfirm(): void; onCancel(): void }) {
  return (
    <Dialog
      title={props.name}
      onClose={props.onCancel}
      header={false}
      width="sm"
      phone="sheet"
      footer={
        <>
          <Button autoFocus onClick={props.onCancel}>
            {props.cancel ?? WORDS.actions.cancel}
          </Button>
          <Button variant={props.danger ? "danger" : "primary"} busy={props.busy} onClick={props.onConfirm}>
            {props.confirm}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: theme.font.input, lineHeight: theme.leading.body, color: theme.color.text, overflowWrap: "anywhere" }}>
        {props.question}
      </p>
    </Dialog>
  );
}
