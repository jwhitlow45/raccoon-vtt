import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { ErrorText } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { api, type LogSession } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { prefersShare, shareFile } from "../mapexport/save.ts";
import { deviceTimeZone, everythingLabel, EXPORT_LIMIT_NOTE, exportErrorText, sessionLabel } from "./exportLog.ts";

type List = { kind: "loading" } | { kind: "ready"; sessions: LogSession[]; lines: number } | { kind: "error"; message: string };
type Made = { file: File; url: string; share: boolean };
type Export = { kind: "idle" } | { kind: "busy"; key: string } | { kind: "made"; key: string; made: Made } | { kind: "error"; key: string; message: string };

/**
 * The Log panel's Export sheet (docs/design-v1-dm-tools.md 3.10): the
 * evenings this viewer's log holds, newest first, and Everything. The
 * server renders the file from what this viewer may read, so it names
 * creatures on every scene and needs no hundred page loads here.
 *
 * Listing and each export count against one hourly limit, so the list is
 * asked for once per opening and kept. A file is saved as the map export
 * saves its picture (mapexport/save.ts): a download on a computer, and the
 * share sheet on a phone that has one, which needs a second tap of its own.
 *
 * Every row's Export acts on the side, so each is secondary, and the one
 * primary is the share button a phone's finished file then needs.
 */
export function ExportLog(props: { onClose(): void }) {
  const roomId = useRoomView((s) => s.roomId);
  const [list, setList] = useState<List>({ kind: "loading" });
  const [job, setJob] = useState<Export>({ kind: "idle" });
  const [shareFailed, setShareFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const tz = deviceTimeZone();

  useEffect(() => {
    let live = true;
    api.logSessions(roomId).then(
      (res) => live && setList({ kind: "ready", sessions: res.sessions, lines: res.lines }),
      (err: unknown) => live && setList({ kind: "error", message: exportErrorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [roomId]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const run = async (key: string, range: { from?: string; to?: string }) => {
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
      setJob({ kind: "error", key, message: exportErrorText(err) });
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
  const row = (key: string, label: string, range: { from?: string; to?: string }) => {
    const mine = job.kind !== "idle" && job.key === key;
    return (
      <li key={key} style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(2)}px 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.body14 }}>{label}</span>
          <Button size="sm" busy={mine && job.kind === "busy"} disabled={busy && !mine} onClick={() => void run(key, range)}>
            {mine && job.kind === "busy" ? "Preparing…" : "Export"}
          </Button>
        </div>
        {mine && job.kind === "busy" ? <Loading text="Preparing the log…" /> : null}
        {mine && job.kind === "error" ? <ErrorText>{job.message}</ErrorText> : null}
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
            {list.sessions.map((s) => row(`${s.from}|${s.to}`, sessionLabel(s), { from: s.from, to: s.to }))}
            {row("all", everythingLabel(list.lines), {})}
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
