import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { imageAssetId } from "#shared/imageRef.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { Tag } from "../../components/Tag.tsx";
import type { AssetKind, AssetRow, AssetVariant } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomView } from "../../state/view.ts";
import { HandoutViewer } from "../handouts/HandoutViewer.tsx";
import { formatBytes } from "../settings/backup.ts";
import { CreditLine } from "./CreditLine.tsx";
import { imageErrorMessage } from "./errors.ts";
import { deleteImages, notInUse, totalBytes, useLibrary } from "./library.ts";

export const tileStyle = {
  display: "block",
  width: "100%",
  aspectRatio: "1",
  padding: 0,
  borderRadius: theme.radius.sm,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  background: theme.color.bg,
  overflow: "hidden",
  cursor: "pointer",
} as const;

export const tileImage = { width: "100%", height: "100%", objectFit: "cover", display: "block" } as const;

/**
 * The room's token images this member may use: the server's list (their
 * own uploads, and for the DM everything), plus every image already on a
 * token or character in view, which is the same set the server allows
 * (design 11.2) and still shows when the list cannot load.
 *
 * The image picker's Library tab passes `onPick`, and each image is a
 * button. The Library panel shows the same grid without it: a tap shows the
 * image larger with its credit when it has one (docs/design-v1-dm-tools.md
 * 3.13), and its View opens it in the handout viewer
 * (docs/design-v1-layout-hierarchy.md 5.3). For the DM the panel lists
 * maps and handouts too, marks each image the room's state does not use as
 * "Not in use", and deletes those on a second tap, one or all at once
 * (section 3.19), since only the DM can tell a handout kept for later from
 * one nobody needs.
 */
export function LibraryGrid(props: {
  roomId: string;
  disabled?: boolean;
  onPick?(id: string): void;
  /** What an empty library says, by default that there are no token images yet. The panel adds how to add one. */
  empty?: string;
  /** A line under the images, once there are some. */
  hint?: string;
}) {
  const library = useLibrary(props.roomId);
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const role = useRoomView((s) => s.you?.role);

  const ids = useMemo(() => {
    const seen = new Set<string>((library.rows ?? []).filter((a) => a.kind === "token").map((a) => a.id));
    for (const t of Object.values(tokens ?? {})) {
      const id = imageAssetId(t?.image);
      if (id !== undefined) seen.add(id);
    }
    for (const c of Object.values(characters ?? {})) {
      const id = imageAssetId(c?.defaultImage);
      if (id !== undefined) seen.add(id);
    }
    return [...seen];
  }, [library.rows, tokens, characters]);

  const listed = library.rows !== null;
  const status = (
    <>
      {!listed && !library.failed ? <Loading text="Loading the library…" /> : null}
      {library.failed ? <Help>The library did not load. Images already on the map are below.</Help> : null}
    </>
  );
  const emptyText = props.empty ?? "No token images yet.";

  if (props.onPick) {
    const { onPick } = props;
    return (
      <div style={{ display: "grid", gap: theme.space(3) }}>
        {status}
        {ids.length === 0 && (listed || library.failed) ? <Empty>{emptyText}</Empty> : null}
        <Tiles label="Token images in this room">
          {ids.map((id) => (
            <li key={id}>
              <button type="button" disabled={props.disabled} onClick={() => onPick(id)} aria-label="Use this image" style={tileStyle}>
                <Thumb id={id} />
              </button>
            </li>
          ))}
        </Tiles>
      </div>
    );
  }

  if (role === "dm" && library.rows) return <ManagedLibrary roomId={props.roomId} rows={library.rows} empty={props.empty ?? "No images yet."} hint={props.hint} />;
  const rows = new Map((library.rows ?? []).map((r) => [r.id, r]));
  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      {status}
      {ids.length === 0 && (listed || library.failed) ? <Empty>{emptyText}</Empty> : null}
      <Browse label="Token images in this room" entries={ids.map((id) => ({ id, row: rows.get(id) }))} />
      {ids.length > 0 && props.hint ? <Help>{props.hint}</Help> : null}
    </div>
  );
}

/** Handouts first: the DM comes to the Library for one a few times a session, and for the rest rarely (docs/design-v1-layout-hierarchy.md M6). */
const SECTIONS: { kind: AssetKind; heading: string }[] = [
  { kind: "handout", heading: "Handouts" },
  { kind: "map", heading: "Maps" },
  { kind: "token", heading: "Token images" },
];

/**
 * The DM's library: every image by kind, those nothing uses marked, and
 * the means to delete them. The bulk delete sits at the foot under "Clean
 * up", with what a delete did, out of the way of the images the DM came
 * for. A rare action that cannot be undone led the panel before.
 */
function ManagedLibrary(props: { roomId: string; rows: readonly AssetRow[]; empty: string; hint?: string }) {
  const unused = notInUse(props.rows);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const remove = async (ids: string[]) => {
    setBusy(true);
    setNote(null);
    const result = await deleteImages(props.roomId, ids);
    setBusy(false);
    const parts: string[] = [];
    if (result.deleted > 0) parts.push(result.deleted === 1 ? "Deleted 1 image." : `Deleted ${result.deleted} images.`);
    if (result.inUse) parts.push("Some were in use again by then, so they were kept.");
    if (result.error) parts.push(imageErrorMessage(result.error));
    setNote({ text: parts.join(" ") || "Nothing was deleted.", error: result.error !== null });
  };

  const bytes = totalBytes(unused);
  return (
    <div style={{ display: "grid", gap: theme.space(4) }}>
      {SECTIONS.map((section) => {
        const rows = props.rows.filter((r) => r.kind === section.kind);
        if (rows.length === 0) return null;
        return (
          <section key={section.kind} style={{ display: "grid", gap: theme.space(2) }}>
            <SectionLabel>{section.heading}</SectionLabel>
            <Browse
              label={`${section.heading} in this room`}
              entries={rows.map((row) => ({ id: row.id, row }))}
              renderActions={(row) =>
                row.inUse === false ? (
                  <TwoTapDelete busy={busy} onConfirm={() => void remove([row.id])} confirm="Delete it?">
                    Delete
                  </TwoTapDelete>
                ) : null
              }
            />
          </section>
        );
      })}
      {props.rows.every((r) => r.kind === "thumb") ? <Empty>{props.empty}</Empty> : props.hint ? <Help>{props.hint}</Help> : null}
      {unused.length > 0 || note ? (
        <section style={{ display: "grid", gap: theme.space(2) }}>
          <SectionLabel>Clean up</SectionLabel>
          {unused.length > 0 ? (
            <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
              <TwoTapDelete busy={busy} onConfirm={() => void remove(unused.map((r) => r.id))} confirm={unused.length === 1 ? "Delete it?" : `Delete all ${unused.length}?`}>
                {`Delete ${unused.length} not in use${bytes !== null ? ` (${formatBytes(bytes)})` : ""}`}
              </TwoTapDelete>
              <Help>No token, scene, stamp or handout uses these. A deleted image is gone for good, from undo too.</Help>
            </div>
          ) : null}
          {note ? (
            <p role={note.error ? "alert" : "status"} style={{ margin: 0, fontSize: theme.font.body14, color: note.error ? theme.color.dangerText : theme.color.textMuted }}>
              {note.text}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** A grid of images to look at: a tap shows one larger, with its credit and, for the DM, what can be done with it. */
function Browse(props: { label: string; entries: { id: string; row: AssetRow | undefined }[]; renderActions?(row: AssetRow): ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = props.entries.find((e) => e.id === open);
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <Tiles label={props.label}>
        {props.entries.map(({ id, row }) => (
          <li key={id} style={{ position: "relative" }}>
            <button
              type="button"
              aria-pressed={open === id}
              aria-label={tileLabel(row)}
              onClick={() => setOpen(open === id ? null : id)}
              style={{ ...tileStyle, borderColor: open === id ? theme.color.accent : theme.color.border }}
            >
              <Thumb id={id} />
            </button>
            {row?.inUse === false ? <NotInUse /> : null}
          </li>
        ))}
      </Tiles>
      {shown ? <Detail id={shown.id} row={shown.row} actions={shown.row && props.renderActions ? props.renderActions(shown.row) : null} /> : null}
    </div>
  );
}

/** What the image is: its tile's name, and its viewer's title unless a handout shows it under one. */
function kindName(row: AssetRow | undefined): string {
  return row?.kind === "map" ? "Map" : row?.kind === "handout" ? "Handout" : "Token image";
}

function tileLabel(row: AssetRow | undefined): string {
  const name = kindName(row);
  return row?.inUse === false ? `${name}, not in use` : name;
}

/**
 * The variant to look at large: `full` when the row lists it, else the
 * largest it lists. With no row (an image only seen on a token, the list
 * not loaded) `full`, which every kind but a scene's thumbnail has.
 */
export function viewVariant(row: Pick<AssetRow, "variants"> | undefined): AssetVariant {
  const listed = row?.variants ?? ["full"];
  return (["full", "mobile", "thumb"] as const).find((v) => listed.includes(v)) ?? "full";
}

/** The viewer's title: a handout's that shows this image, the one shown last, else what the image is. */
export function viewTitle(id: string, row: AssetRow | undefined, handouts: readonly { assetId: string; title: string; shownAt: string }[]): string {
  let shown: { title: string; shownAt: string } | null = null;
  for (const h of handouts) if (h.assetId === id && (!shown || h.shownAt > shown.shownAt)) shown = h;
  return shown?.title ?? kindName(row);
}

function Detail(props: { id: string; row: AssetRow | undefined; actions: ReactNode }) {
  const { row } = props;
  const [viewing, setViewing] = useState(false);
  const viewRef = useRef<HTMLButtonElement>(null);
  const assets = useAssets();
  const handouts = useRoomView((s) => s.view?.handouts);
  const title = viewTitle(props.id, row, Object.values(handouts ?? {}));
  return (
    <div
      style={{
        display: "flex",
        gap: theme.space(3),
        alignItems: "flex-start",
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        background: theme.color.bg,
        border: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    >
      {/* A pointer shortcut to View, which is the one named control and keyboard stop. */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => setViewing(true)}
        style={{ flex: "none", display: "block", width: 96, height: 96, padding: 0, border: "none", borderRadius: theme.radius.sm, overflow: "hidden", background: theme.color.surfaceRaised, cursor: "zoom-in" }}
      >
        <Thumb id={props.id} />
      </button>
      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(2), alignContent: "start" }}>
        {row ? (
          <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
            {row.width} × {row.height} px
            {typeof row.bytes === "number" ? `, ${formatBytes(row.bytes)}` : ""}
            {row.inUse === true ? ". In use." : row.inUse === false ? ". Not in use." : ""}
          </span>
        ) : null}
        {row?.credit ? <CreditLine credit={row.credit} stored={row} /> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          <Button ref={viewRef} size="sm" onClick={() => setViewing(true)}>
            View
          </Button>
          {props.actions}
        </div>
      </div>
      {viewing ? (
        // No Download: the popup's stays the players' way to save a handout, and the DM holds the images already.
        <HandoutViewer title={title} onClose={() => setViewing(false)} pages={[{ src: assets.url(props.id, viewVariant(row)), alt: title }]} backClose opener={viewRef} />
      ) : null}
    </div>
  );
}

/** A muted Tag over the tile's corner. Its solid fill keeps it legible on any image. The tile's name already says it, so it is hidden from screen readers. */
function NotInUse() {
  return (
    <span aria-hidden style={{ position: "absolute", left: theme.space(1), bottom: theme.space(1), display: "flex", pointerEvents: "none" }}>
      <Tag dense>Not in use</Tag>
    </span>
  );
}

function Tiles(props: { label: string; children: ReactNode }) {
  return (
    <ul
      aria-label={props.label}
      style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: theme.space(2) }}
    >
      {props.children}
    </ul>
  );
}

/** An image's small copy, or a plain tile that says so when it will not load (offline, say), never a broken image. */
function Thumb(props: { id: string }) {
  const assets = useAssets();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span style={{ display: "grid", placeItems: "center", width: "100%", height: "100%", color: theme.color.textMuted, fontSize: theme.font.tiny, textAlign: "center" }}>
        No preview
      </span>
    );
  }
  return <img src={assets.url(props.id, "thumb")} alt="" loading="lazy" onError={() => setFailed(true)} style={tileImage} />;
}

/** Red text at rest, armed with the red outline for 4 s after the first tap, busy while the delete runs. */
function TwoTapDelete(props: { busy: boolean; confirm: string; onConfirm(): void; children: ReactNode }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      size="sm"
      variant="danger"
      armed={armed && !props.busy}
      busy={props.busy}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        props.onConfirm();
      }}
    >
      {props.busy ? "Deleting…" : armed ? props.confirm : props.children}
    </Button>
  );
}
