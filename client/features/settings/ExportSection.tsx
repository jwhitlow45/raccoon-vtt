import { useRef, useState, type MouseEvent } from "react";
import { ErrorText } from "../../components/Field.tsx";
import { Spinner } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help, Section } from "../../components/Panel.tsx";
import { api, exportUrl, MAX_IMPORT_BYTES } from "../../lib/api.ts";
import { formatRoomId } from "../../lib/roomId.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { ADMIN_IMPORT_COMMAND, exportErrorText, formatBytes } from "./backup.ts";

type Status = { kind: "idle" } | { kind: "checking" } | { kind: "started" } | { kind: "refused"; text: string };

/**
 * The DM's room backup (design 16.4).
 *
 * The download itself stays a plain link, so the browser streams the zip
 * to disk. A room with its maps can run to hundreds of MB, and fetching it
 * here would hold the whole body in this page's memory as a Blob before it
 * could be saved, which a phone cannot spare. But a link that the server
 * refuses (the hourly limit, another backup running, a device that is no
 * longer the DM) fails only in the browser's download list, where nobody
 * looks. So a tap first sends a HEAD, which runs the server's checks
 * without making the zip or counting toward the limit, and shows any
 * refusal here. Only then does the link download. A refusal in the moment
 * between the two still ends up in the download list, which the help text
 * after a start covers.
 *
 * The link looks like a small secondary button. While the check runs it
 * shows a spinner and "Checking…" at full color, as a busy Button does.
 */
export function ExportSection() {
  const roomId = useRoomView((s) => s.roomId);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const link = useRef<HTMLAnchorElement>(null);
  const checked = useRef(false);

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // The second click is the one this handler made after a passing check: let the browser download.
    if (checked.current) {
      checked.current = false;
      setStatus({ kind: "started" });
      return;
    }
    e.preventDefault();
    if (status.kind === "checking") return;
    setStatus({ kind: "checking" });
    api.checkExport(roomId).then(
      () => {
        checked.current = true;
        link.current?.click();
      },
      (err: unknown) => setStatus({ kind: "refused", text: exportErrorText(err) }),
    );
  };

  return (
    <Section label="Backup">
      <Help>
        Download the whole room as one .zip file: every scene, token, character and image. Anyone can import it from the
        Home page as a new room, on this server or another.
      </Help>
      <a
        ref={link}
        href={exportUrl(roomId)}
        download={`raccoon-room-${formatRoomId(roomId)}.zip`}
        onClick={onClick}
        aria-busy={status.kind === "checking" ? true : undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: theme.space(2),
          justifySelf: "start",
          minHeight: theme.touch,
          padding: `0 ${theme.space(3)}px`,
          borderRadius: theme.radius.md,
          fontSize: theme.font.body14,
          fontWeight: theme.weight.strong,
          textDecoration: "none",
          ...buttonLook("secondary"),
        }}
      >
        {status.kind === "checking" ? <Spinner size={theme.icon.sm} /> : null}
        {status.kind === "checking" ? "Checking…" : "Download a backup"}
      </a>
      {status.kind === "refused" ? <ErrorText>{status.text}</ErrorText> : null}
      {status.kind === "started" ? (
        <Help>
          The download has started. Play can go on while it runs. At most 4 backups an hour: if it fails, wait a few
          minutes and try again.
        </Help>
      ) : null}
      <Help>
        The site imports backups up to {formatBytes(MAX_IMPORT_BYTES)}. The server owner can restore a bigger one with{" "}
        <code style={{ fontFamily: theme.font.mono, wordBreak: "break-all" }}>{ADMIN_IMPORT_COMMAND}</code>
      </Help>
    </Section>
  );
}
