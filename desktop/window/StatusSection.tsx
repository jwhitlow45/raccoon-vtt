import { useEffect, useRef, useState } from "react";
import { Button } from "../../client/components/Button.tsx";
import { Notice as NoticeBox } from "../../client/components/Notice.tsx";
import { Icon } from "../../client/components/Icon.tsx";
import { Spinner } from "../../client/components/Loading.tsx";
import { theme } from "../../client/lib/theme.ts";
import { WORDS, type AppError, type Notice, type SupervisorStatus, type WindowState } from "../contract.ts";
import { formatDate } from "./format.ts";
import { Help, ButtonRow, Confirm, Working, useAction, DID_NOT_ANSWER } from "./ui.tsx";
import { errorActions, errorSentence, RESTORE_STEP_ORDER, statusView, failureText } from "./view.ts";
import type { RaccoonLocal } from "../contract.ts";

/**
 * The top of the page: the update banner, the clock notice, the one-time
 * restore notice, then either the status line, a restore's steps or the
 * stop's words and buttons (design 9).
 */

export function Status(props: { state: WindowState; bridge: RaccoonLocal; now: Date; onRestoreChoice(): void; onQuit(): void }) {
  const { state } = props;
  const sup = state.supervisor;
  const view = statusView(state);
  return (
    <>
      {/* `contents` keeps the box a direct row of the page, which the alignment check reads by its words. */}
      <div aria-live="polite" style={{ display: "contents" }}>
        {sup?.state === "restoring" ? <RestorePanel sup={sup} /> : view.text ? <StatusLine text={view.text} working={view.working} /> : null}
      </div>
      <StopPanel {...props} />
    </>
  );
}

function StatusLine(props: { text: string; working: boolean }) {
  return (
    <div style={{ ...BOX, fontSize: theme.font.input, fontWeight: theme.weight.strong }}>
      <Working active={props.working}>{props.text}</Working>
    </div>
  );
}

/** Every painted box on the page shares one padding and border, so their words start at one edge. */
export const BOX = {
  padding: theme.space(4),
  background: theme.color.surface,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  borderRadius: theme.radius.lg,
} as const;

/** A step still to come: a quiet ring, so every row starts with a mark and the words line up. */
function Waiting() {
  return (
    <svg aria-hidden width={18} height={18} viewBox="0 0 24 24" style={{ display: "block" }}>
      <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="2" />
    </svg>
  );
}

/** A restore's steps, each done, under way or waiting. The page below refuses every change meanwhile (the status's `restore`). */
function RestorePanel(props: { sup: SupervisorStatus }) {
  const at = props.sup.restore ? RESTORE_STEP_ORDER.indexOf(props.sup.restore) : -1;
  return (
    <div style={{ ...BOX, display: "grid", gap: theme.space(2), borderColor: theme.color.accentSoft }}>
      <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: theme.space(2) }}>
        {RESTORE_STEP_ORDER.map((step, i) => (
          <li
            key={step}
            aria-current={i === at ? "step" : undefined}
            style={{ display: "flex", alignItems: "center", gap: theme.space(2), fontSize: theme.font.input, color: i > at ? theme.color.textMuted : theme.color.text, fontWeight: i === at ? theme.weight.strong : theme.weight.regular }}
          >
            <span aria-hidden style={{ width: 18, display: "grid", placeItems: "center", flex: "none" }}>
              {i < at ? <Icon name="check" size={18} /> : i === at ? <Spinner size={18} /> : <Waiting />}
            </span>
            <span style={{ minWidth: 0 }}>{WORDS.backups.steps[step]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function noticeText(notice: Notice, now: Date): { text: string; tone: "info" | "warning" } {
  switch (notice.kind) {
    case "restored":
      return { text: WORDS.backups.restored(formatDate(notice.backupStarted, now)), tone: "info" };
    case "restoreFinished":
      return { text: WORDS.backups.restoreFinished(formatDate(notice.backupStarted, now)), tone: "info" };
    case "restoreFailed":
      return { text: WORDS.backups.restoreFailed(notice.reason), tone: "warning" };
    case "restoreInterrupted":
      return { text: WORDS.backups.restoreInterrupted, tone: "warning" };
  }
}

/** The one-time restore notice. `seq` grows with each new one, so a dismissed notice stays gone through every later status. */
export function RestoreNotice(props: { notice: Notice | null; now: Date }) {
  const [seen, setSeen] = useState(-1);
  const { notice } = props;
  if (!notice || notice.seq <= seen) return null;
  const { text, tone } = noticeText(notice, props.now);
  return (
    <NoticeBox tone={tone} role="status" style={{ padding: theme.space(4) }} action={<Button size="sm" variant="quiet" onClick={() => setSeen(notice.seq)}>{DISMISS}</Button>}>
      {text}
    </NoticeBox>
  );
}

/** Not in the design's list of words: the notice needs a way to go. */
const DISMISS = "Dismiss";

/** The stop's words (role alert) and the buttons it offers. */
function StopPanel(props: { state: WindowState; bridge: RaccoonLocal; onRestoreChoice(): void; onQuit(): void }) {
  const error = props.state.shell.error ?? props.state.supervisor?.error ?? null;
  if (!error) return null;
  return <StopBody key={error.kind} error={error} {...props} />;
}

function StopBody(props: { error: AppError; state: WindowState; bridge: RaccoonLocal; onRestoreChoice(): void; onQuit(): void }) {
  const { error, bridge } = props;
  const [confirm, setConfirm] = useState<"startWithoutBackup" | "deleteGuard" | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);
  const command = useAction(async (which: "retry" | "startWithoutBackup" | "deleteGuard" | "usePort") => {
    const result = which === "usePort" ? await bridge.setPort(error.kind === "portInUse" ? error.next : 0) : await bridge[which]();
    return result.ok ? null : failureText(result.failure, "other");
  });
  const download = useAction(async () => {
    await bridge.openRelease();
    return null;
  });
  const busy = command.busy || download.busy;

  const press = (action: ReturnType<typeof errorActions>[number]["action"]) => {
    switch (action) {
      case "tryAgain":
        return void command.start("retry");
      case "showLogs":
        return void bridge.openFolder("logs");
      case "showData":
        return void bridge.openFolder("data");
      case "usePort":
        return void command.start("usePort");
      case "quit":
        return props.onQuit();
      case "downloadLatest":
        return void download.start();
      case "restoreBackup":
        return props.onRestoreChoice();
      case "startWithoutBackup":
        return setConfirm("startWithoutBackup");
      case "deleteGuard":
        return setConfirm("deleteGuard");
      case "copyPath":
        if (error.kind === "guardLeft" || error.kind === "guardUnreadable") {
          void bridge.copyText(error.path);
          setCopied(true);
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => setCopied(false), 2000);
        }
        return;
      case "cancel":
        return;
    }
  };

  return (
    <div role="alert" style={{ ...BOX, display: "grid", gap: theme.space(3), borderColor: theme.color.danger, background: theme.color.dangerFill }}>
      <p style={{ margin: 0, fontSize: theme.font.input, lineHeight: theme.leading.body, overflowWrap: "anywhere", userSelect: "text" }}>{errorSentence(props.state, error)}</p>
      <ButtonRow>
        {errorActions(error).map(({ action, label }) => (
          <Button
            key={action}
            variant={action === "tryAgain" || action === "usePort" || action === "downloadLatest" ? "primary" : "secondary"}
            busy={busy && (action === "tryAgain" || action === "usePort" || action === "downloadLatest")}
            onClick={() => press(action)}
          >
            {action === "copyPath" && copied ? WORDS.players.copied : label}
          </Button>
        ))}
      </ButtonRow>
      {command.error || download.error ? <Help role="alert" tone="danger">{command.error ?? download.error ?? DID_NOT_ANSWER}</Help> : null}
      {confirm === "startWithoutBackup" ? (
        <Confirm
          name={WORDS.actions.startWithoutBackup}
          question={WORDS.confirmStartWithoutBackup}
          confirm={WORDS.actions.startAnyway}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void command.start("startWithoutBackup");
          }}
        />
      ) : null}
      {confirm === "deleteGuard" ? (
        <Confirm
          name={WORDS.actions.deleteGuard}
          question={WORDS.confirmDeleteGuard}
          confirm={WORDS.actions.deleteGuard}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void command.start("deleteGuard");
          }}
        />
      ) : null}
    </div>
  );
}
