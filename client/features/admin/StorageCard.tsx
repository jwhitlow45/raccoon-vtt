import type { ReactNode } from "react";
import { Card } from "../../components/Field.tsx";
import { Notice } from "../../components/Notice.tsx";
import { theme } from "../../lib/theme.ts";
import type { AdminStorage } from "./api.ts";
import { backupLines, formatBytes, plural } from "./format.ts";

/**
 * What the server holds (docs/design-v1-dm-tools.md 3.18): the image
 * volume, the database, the images on disk counted once each, what waits
 * for cleanup, and the backups.
 */
export function StorageCard(props: { storage: AdminStorage }) {
  const { volume, databaseBytes, images, cleanup, backup } = props.storage;
  return (
    <Card title="Storage">
      <dl style={{ margin: 0, display: "grid", gap: theme.space(3) }}>
        <Item label="Image volume">
          {volume ? `${formatBytes(volume.usedBytes)} used, ${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}` : "Could not be read."}
        </Item>
        <Item label="Database">{formatBytes(databaseBytes)}</Item>
        <Item label="Images on disk" hint="Each file once, though rooms that uploaded the same image share it.">
          {`${plural(images.count, "image")}, ${formatBytes(images.bytes)}`}
        </Item>
        <Item label="Waiting for cleanup" hint="Old scene thumbnails go a day after their scene stops using them. Deleted files wait 48 hours in the trash.">
          {`${plural(cleanup.waiting.count, "thumbnail")}, ${formatBytes(cleanup.waiting.bytes)}. In the trash: ${plural(cleanup.trash.files, "file")}, ${formatBytes(cleanup.trash.bytes)}.`}
        </Item>
        <Item label="Last backup">{backup.last ? <Run lines={backupLines(backup.last)} /> : "None yet."}</Item>
        {backup.lastGood && backup.lastGood.id !== backup.last?.id ? (
          <Item label="Last good backup">
            <Run lines={backupLines(backup.lastGood)} />
          </Item>
        ) : null}
      </dl>
      {backup.warning ? (
        <Notice tone="warning" role="alert">
          {backup.warning}
        </Notice>
      ) : null}
    </Card>
  );
}

function Item(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: theme.space(0.5) }}>
      <dt style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{props.label}</dt>
      <dd style={{ margin: 0 }}>{props.children}</dd>
      {props.hint ? <dd style={{ margin: 0, fontSize: theme.font.small, color: theme.color.textMuted }}>{props.hint}</dd> : null}
    </div>
  );
}

function Run(props: { lines: { title: string; detail: string | null } }) {
  return (
    <>
      <span style={{ display: "block" }}>{props.lines.title}</span>
      {props.lines.detail ? <span style={{ display: "block", fontSize: theme.font.small, color: theme.color.textMuted }}>{props.lines.detail}</span> : null}
    </>
  );
}
