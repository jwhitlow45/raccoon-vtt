import { FORGET_ASK } from "#shared/protocol.ts";
import { useEffect, useRef, useState } from "react";
import type { HistoryDirection, HistoryHead, HistoryScope } from "#shared/undoContract.ts";
import { Button } from "../components/Button.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Loading } from "../components/Loading.tsx";
import { usePreview } from "../features/dm/previewContext.ts";
import { theme } from "../lib/theme.ts";
import { blockerText, EMPTY_HISTORY, HISTORY_LOADING } from "../state/history.ts";
import { setupHistoryShortcut, useSurfaceKeyHint, withKey } from "../state/shortcuts.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../state/view.ts";

export function HistoryDialogs() {
  const selected = useRoomView((s) => s.historyReview);
  const ui = useRoomUi();
  return selected ? <SetupHistory scope={selected.scope} direction={selected.direction} onClose={() => ui.openHistory?.(null)} /> : null;
}

/** The same retained-step controls apply to either scope, including a Play refusal. */
export function SetupHistory(props: { scope?: HistoryScope; direction?: HistoryDirection; onClose(): void }) {
  const scope = props.scope ?? "setup";
  const history = useRoomView((s) => s.history ?? EMPTY_HISTORY);
  const held = useRoomView((s) => s.buildHeldSince !== undefined);
  const connected = useRoomView((s) => s.connection === "open");
  const dm = useRoomView((s) => s.you?.role === "dm");
  const preview = usePreview() !== null;
  const actions = useRoomActions();
  const undoKey = useSurfaceKeyHint("setupUndo");
  const redoKey = useSurfaceKeyHint("setupRedo");
  const body = useRef<HTMLDivElement>(null);
  const [review, setReview] = useState<HistoryDirection | null>(props.direction ?? null);
  const [discard, setDiscard] = useState<{ direction: HistoryDirection; head: HistoryHead } | null>(null);
  const ui = useRoomUi();
  const forget = useRoomView((s) => s.toasts.find((toast) => toast.text === FORGET_ASK && toast.action));
  const disabled = !connected || !dm || preview || held || history.pending > 0;
  const title = scope === "setup" ? "Setup history" : "Play history";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const direction = setupHistoryShortcut(event, { focused: body.current?.closest("dialog")?.contains(event.target as Node) === true, dm, preview, confirming: discard !== null, scope });
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      if (!connected || held || !dm || preview || discard) return;
      // Separate keydowns stay deliberate even while the preceding command waits.
      actions[direction]({ scope });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [actions, connected, held, dm, preview, scope, discard]);

  if (!dm || preview) return null;
  return (
    <Dialog title={title} phone="sheet" width="sm" onClose={props.onClose}>
      <div ref={body} data-setup-history={scope} style={{ display: "grid", gap: theme.space(4), minWidth: 0, overflowWrap: "anywhere" }}>
        <p style={{ margin: 0 }}>{scope === "setup" ? "Your saved definitions and configuration have their own history. Play and board changes stay in Undo." : "Your play and board changes have their own history. Saved definitions and configuration stay in Setup history."}</p>
        {!connected ? <p role="status">Connect to use history.</p> : <Loading text={HISTORY_LOADING} active={!history.ready || history.pending > 0} />}
        {(["undo", "redo"] as const).map((direction) => {
          const head = history.summary?.[scope]?.[direction].head;
          const verb = direction === "undo" ? "Undo" : "Redo";
          const label = `${verb}${scope === "setup" ? " setup" : ""}`;
          const key = scope === "setup" ? direction === "undo" ? undoKey : redoKey : null;
          return (
            <section key={direction} aria-label={`${label} step`} style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
              <p id={`history-${scope}-${direction}`} style={{ margin: 0, whiteSpace: "normal" }}>{head?.label ?? (history.ready ? `Nothing to ${direction}.` : "Waiting for history.")}</p>
              <Button disabled={disabled || (history.ready && !head)} title={withKey(label, key)} aria-keyshortcuts={key?.aria} aria-describedby={`history-${scope}-${direction}`} onClick={(event) => actions[direction]({ scope, control: `history-${scope}-${direction}`, detail: event.detail })}>{label}</Button>
              {head?.retained ? (
                <div data-history-review style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
                  <p style={{ margin: 0 }}>{blockerText(head.retained)}</p>
                  <Button expanded={review === direction} onClick={() => setReview(review === direction ? null : direction)}>Review step</Button>
                  {review === direction ? <>
                    <Button disabled={disabled} onClick={(event) => actions[direction]({ scope, expected: head.id, control: `retry-${scope}-${direction}`, detail: event.detail })}>Retry</Button>
                    <Button variant="danger" disabled={disabled} onClick={() => setDiscard({ direction, head })}>Discard this step</Button>
                  </> : null}
                </div>
              ) : null}
            </section>
          );
        })}
        {/* ToastVoice announces each terminal answer once. Keep its words visible here without a second live region. */}
        {history.result ? <p data-history-result style={{ margin: 0 }}>{history.result}</p> : null}
        {history.result === FORGET_ASK && forget?.action ? <div data-history-forget style={{ display: "grid", gap: theme.space(2) }}>
          <Button disabled={disabled || forget.action.ready?.() === false} onClick={() => { forget.action?.run(); ui.dismissToast(forget.id); }}>{forget.action.label}</Button>
          <Button onClick={() => ui.dismissToast(forget.id)}>Cancel</Button>
        </div> : null}
      </div>
      {discard ? (
        <Dialog title="Discard this step" phone="sheet" width="sm" onClose={() => setDiscard(null)} footer={<>
          <Button onClick={() => setDiscard(null)}>Cancel</Button>
          <Button variant="danger" disabled={disabled} onClick={(event) => {
            actions[discard.direction]({ scope, expected: discard.head.id, discard: true, control: `discard-${scope}-${discard.direction}`, detail: event.detail });
            setDiscard(null);
          }}>Discard this step</Button>
        </>}>
          <div data-history-discard style={{ overflowWrap: "anywhere" }}>
            <p>Discard this undo step? The game stays as it is.</p>
            <p>{discard.head.label}</p>
          </div>
        </Dialog>
      ) : null}
    </Dialog>
  );
}
