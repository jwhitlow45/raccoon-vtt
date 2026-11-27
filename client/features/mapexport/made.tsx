import { useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help, Note } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { shareFile } from "./save.ts";
import { plural } from "./vttNotes.ts";

/**
 * What Export as image and Export as VTT file show once a file is made:
 * its name, size and notes, then Save or share where the device prefers
 * it, and Download (save.ts says why a second tap saves).
 */

/** A made file: one floor's, or every floor's zip (`floors`). */
export type Made = { file: File; url: string; width: number; height: number; pxPerCell: number; share: boolean; notes: string[]; floors?: number };

/** A run that a newer one overtook, which drops its result without a word. */
export class Overtaken extends Error {}

export function MadeFile(props: { made: Made; cell: string }) {
  const { made, cell } = props;
  const [shareFailed, setShareFailed] = useState(false);
  /** The share sheet is open. A second tap would be refused while it is, and read as a failure. */
  const [sharing, setSharing] = useState(false);
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    setShareFailed(false);
    try {
      if ((await shareFile(made.file)) === "failed") setShareFailed(true);
    } finally {
      setSharing(false);
    }
  };
  return (
    <>
      <Help>
        {made.floors !== undefined
          ? `Made ${made.file.name}: ${plural(made.floors, "floor")} at ${made.pxPerCell} px per ${cell}, ${formatBytes(made.file.size)}.`
          : `Made ${made.file.name}: ${made.width} × ${made.height} px at ${made.pxPerCell} px per ${cell}, ${formatBytes(made.file.size)}.`}
      </Help>
      {made.notes.map((n) => (
        <Help key={n}>{n}</Help>
      ))}
      <Row>
        {made.share ? (
          <Button size="sm" variant="primary" disabled={sharing} onClick={() => void share()}>
            Save or share
          </Button>
        ) : null}
        <a href={made.url} download={made.file.name} style={linkButton(!made.share)}>
          Download
        </a>
      </Row>
      {shareFailed ? <Note>Sharing did not work here. Use Download instead.</Note> : null}
    </>
  );
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The download link, dressed as a small button so it is a 44 px target too: the primary when it is the one way to save. */
function linkButton(primary: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: theme.touch,
    minWidth: theme.touch,
    padding: `0 ${theme.space(3)}px`,
    borderRadius: theme.radius.md,
    fontFamily: theme.font.body,
    fontSize: theme.font.body14,
    fontWeight: theme.weight.strong,
    textDecoration: "none",
    whiteSpace: "nowrap",
    ...buttonLook(primary ? "primary" : "secondary"),
  };
}

export function Row(props: { children: ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>{props.children}</div>;
}
