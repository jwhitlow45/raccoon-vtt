import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { ErrorText } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { api, FileTooLargeError, logExportUrl, type LogRange } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { prefersShare, shareFile } from "../mapexport/save.ts";
import {
  deviceTimeZone,
  everythingLabel,
  EXPORT_LIMIT_NOTE,
  exportErrorText,
  LARGE_FILE_NOTE,
  sessionKey,
  sessionLabel,
  sessionRange,
  whileOpen,
  withOlderAnswer,
  type SessionList,
} from "./exportLog.ts";
type Made = { file: File; url: string; share: boolean };
type Export =
  | { kind: "idle" }
  | { kind: "busy"; key: string }
  | { kind: "made"; key: string; made: Made }
  | { kind: "large"; key: string; href: string }
  | { kind: "error"; key: string; message: string };

/**
 * The Log panel's Export sheet (docs/design-v1-dm-tools.md 3.10): the
 * evenings this viewer's log holds, newest first, and Everything. The
 * server renders the file from what this viewer may read, so it names
 * creatures on every scene and needs no hundred page loads here.
 *
 * Listing and each export count against one hourly limit, so the list is
 * asked for once per opening and kept, 25 sessions at a time with Older
 * sessions for the next 25 (docs/design-v1-log-history.md 5.3). A file is
 * saved as the map export saves its picture (mapexport/save.ts): a download
 * on a computer, and the share sheet on a phone that has one, which needs a
 * second tap of its own. A file past 8 MiB is not read into the page: its
 * row offers the browser's own download, which asks the server again.
 *
 * Every row's Export acts on the side, so each is secondary, and the one
 * primary is the share button a phone's finished file then needs.
 */
export function ExportLog(props: { onClose(): void }) {
  const roomId = useRoomView((s) => s.roomId);
  const [list, setList] = useState<SessionList>({ kind: "loading" });
  const [job, setJob] = useState<Export>({ kind: "idle" });
  const [shareFailed, setShareFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const openRef = useRef(true);
  const largeRef = useRef<HTMLDivElement>(null);
  const tz = deviceTimeZone();
  const ids = useId();

  useEffect(() => {
    let live = true;
    api.logSessions(roomId).then(
      (res) => live && setList({ kind: "ready", sessions: res.sessions, lines: res.lines, next: res.nextSessionsBefore ?? null, more: { kind: "idle" } }),
      (err: unknown) => live && setList({ kind: "error", message: exportErrorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [roomId]);

  const older = async () => {
    if (list.kind !== "ready" || list.next === null || list.more.kind === "busy") return;
    const before = list.next;
    setList({ ...list, more: { kind: "busy" } });
    try {
      const res = await api.logSessions(roomId, { before });
      if (openRef.current) setList((now) => withOlderAnswer(now, before, res));
    } catch (err) {
      if (openRef.current) setList((now) => withOlderAnswer(now, before, { failed: exportErrorText(err) }));
    }
  };

  useEffect(
    () =>
      whileOpen(openRef, () => {
        abortRef.current?.abort();
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      }),
    [],
  );

  // The note and its Download can open below the sheet's fold on a phone, so they scroll into view.
  useEffect(() => {
    if (job.kind === "large") largeRef.current?.scrollIntoView({ block: "nearest" });
  }, [job]);

  const run = async (key: string, range: LogRange) => {
    if (job.kind === "busy") return;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setShareFailed(false);
    setJob({ kind: "busy", key });
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await api.exportLog(roomId, range, tz, abort.signal);
      const file = new File([res.blob], res.fileName, { type: "text/markdown" });
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      const share = prefersShare(file);
      setJob({ kind: "made", key, made: { file, url, share } });
      // A computer saves it at once. A phone's share sheet needs a tap of its own.
      if (!share) download(url, file.name);
    } catch (err) {
      if (abort.signal.aborted) return;
      // Line counts say nothing of bytes, so only the file itself tells that it is too large to hold here.
      if (err instanceof FileTooLargeError) setJob({ kind: "large", key, href: logExportUrl(roomId, range, tz) });
      else setJob({ kind: "error", key, message: exportErrorText(err) });
    }
  };

  const share = async (file: File) => {
    if (sharing) return;
    setSharing(true);
    setShareFailed(false);
    try {
      if ((await shareFile(file)) === "failed") setShareFailed(true);
    } finally {
      setSharing(false);
    }
  };

  const busy = job.kind === "busy";
  const row = (key: string, index: number, label: string, range: LogRange) => {
    const mine = job.kind !== "idle" && job.key === key;
    const buttonId = `${ids}-export-${index}`;
    const labelId = `${ids}-label-${index}`;
    return (
      <li key={key} style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(2)}px 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span id={labelId} style={{ flex: 1, minWidth: 0, fontSize: theme.font.body14 }}>
            {label}
          </span>
          {/* Every row's button says Export, so its name adds its row's evening: "Export Thursday, October 15, …". */}
          <Button
            id={buttonId}
            aria-labelledby={`${buttonId} ${labelId}`}
            size="sm"
            busy={mine && job.kind === "busy"}
            icon="download"
            disabled={busy && !mine}
            onClick={() => void run(key, range)}
          >
            {mine && job.kind === "busy" ? "Preparing…" : "Export"}
          </Button>
        </div>
        {mine && job.kind === "busy" ? <Loading text="Preparing the log…" /> : null}
        {mine && job.kind === "error" ? <ErrorText>{job.message}</ErrorText> : null}
        {mine && job.kind === "large" ? (
          <div ref={largeRef} style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
            <Help>{LARGE_FILE_NOTE}</Help>
            {/* The browser's own download streams the file to disk, and the server names it. */}
            <a href={job.href} download style={linkButton}>
              Download
            </a>
          </div>
        ) : null}
        {mine && job.kind === "made" ? (
          <div style={{ display: "grid", gap: theme.space(1) }}>
            <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
              {job.made.share ? (
                <Button variant="primary" size="sm" busy={sharing} onClick={() => void share(job.made.file)}>
                  Save or share
                </Button>
              ) : null}
              <a href={job.made.url} download={job.made.file.name} style={linkButton}>
                Download
              </a>
            </div>
            <Help>{job.made.share ? `Ready: ${job.made.file.name}.` : `Saved ${job.made.file.name} to your downloads.`}</Help>
            {shareFailed ? <ErrorText>Sharing did not work here. Use Download instead.</ErrorText> : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    // A short list of sessions: a `sheet` card fits it on a computer, where a `fill` card kept its full height with nothing under the list.
    <Dialog title="Export the log" width="sm" phone="sheet" onClose={props.onClose}>
      <div style={{ display: "grid", gap: theme.space(3), fontSize: theme.font.body14 }}>
        <Help>A Markdown file of the log as you see it, one evening or all of it, with times as this device shows them.</Help>
        {list.kind === "loading" ? <Loading text="Finding the sessions…" /> : null}
        {list.kind === "error" ? <ErrorText>{list.message}</ErrorText> : null}
        {list.kind === "ready" && list.lines === 0 ? <Help>The log is empty, so there is nothing to export yet.</Help> : null}
        {list.kind === "ready" && list.lines > 0 ? (
          <ul aria-label="Sessions" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {list.sessions.map((s, i) => row(sessionKey(s), i, sessionLabel(s), sessionRange(s)))}
            {list.next !== null ? (
              <li style={{ display: "grid", gap: theme.space(1), justifyItems: "start", padding: `${theme.space(2)}px 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
                <Button size="sm" busy={list.more.kind === "busy"} onClick={() => void older()}>
                  {list.more.kind === "busy" ? "Loading…" : "Older sessions"}
                </Button>
                {list.more.kind === "error" ? <ErrorText>{list.more.message}</ErrorText> : null}
              </li>
            ) : null}
            {row("all", list.sessions.length, everythingLabel(list.lines), {})}
          </ul>
        ) : null}
        <Help>{EXPORT_LIMIT_NOTE}</Help>
      </div>
    </Dialog>
  );
}

/** Starts the browser's own download of a file this page made. */
function download(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
}

/** The download link, dressed as a small secondary button so it is a 44 px target too. */
const linkButton: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  minHeight: theme.touch,
  minWidth: theme.touch,
  padding: `0 ${theme.space(3)}px`,
  borderRadius: theme.radius.md,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  textDecoration: "none",
  whiteSpace: "nowrap",
  ...buttonLook("secondary"),
};
