import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { useStore } from "zustand";
import { handoutPages } from "#shared/handouts.ts";
import { imageAssetId } from "#shared/imageRef.ts";
import type { Handout, HandoutDoc } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { TAG_TONES } from "../../components/tones.ts";
import type { AssetKind, AssetRow, AssetVariant } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useAssets, useRoomActions, useRoomStore, useRoomView, type AssetSource } from "../../state/view.ts";
import { HandoutViewer, type ViewerPage } from "../handouts/HandoutViewer.tsx";
import { pageCountText, pageName } from "../handouts/handouts.ts";
import { formatBytes } from "../settings/backup.ts";
import { CreditLine } from "./CreditLine.tsx";
import { deleteRunning, docDeleteNote, docDeleteSlot, retryDocDelete, startDocDelete, type DocDelete } from "./docDelete.ts";
import { imageErrorMessage } from "./errors.ts";
import { deleteImages, docAssetIds, docBytes, docShowing, docsNewestFirst, looseHandouts, notInUse, totalBytes, uploadingSlot, useLibrary, type LibraryState } from "./library.ts";

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
 * button that picks it. The Library panel shows the same grid without it,
 * and a tap opens the image in the handout viewer, its size, credit and
 * status in the viewer's header (docs/design-v1-pdf-handouts.md 8.4). The
 * DM and players see the same tiles and the same viewer. For the DM the
 * panel lists handouts and maps too, each tile with its status, and
 * deletes an image nothing uses from the viewer's header, or every one at
 * once under Clean up (docs/design-v1-dm-tools.md 3.19), since only the
 * DM can tell a handout kept for later from one nobody needs.
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
  const emptyText = props.empty ?? "No token images yet.";

  if (props.onPick) {
    const { onPick } = props;
    return (
      <div style={{ display: "grid", gap: theme.space(3) }}>
        <LibraryStatus library={library} />
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

  if (role === "dm") return <ManagedLibrary roomId={props.roomId} library={library} unlisted={ids} unlistedEmpty={emptyText} empty={props.empty ?? "No images yet."} hint={props.hint} />;
  return <PlayerLibrary library={library} ids={ids} empty={(listed || library.failed) && ids.length === 0 ? emptyText : null} hint={props.hint} />;
}

function PlayerLibrary(props: { library: LibraryState; ids: readonly string[]; empty: string | null; hint?: string }) {
  const assets = useAssets();
  const handouts = useRoomView((s) => s.view?.handouts);
  const rows = useMemo(() => new Map((props.library.rows ?? []).map((r) => [r.id, r])), [props.library.rows]);
  const shown = Object.values(handouts ?? {});
  const tiles = props.ids.map((id): Tile => {
    const row = rows.get(id);
    return {
      key: `image:${id}`,
      thumbId: id,
      tag: null,
      ...imageTile(row, { dm: false }),
      view: () => ({ ...imageView(id, row, shown, assets), details: <ImageDetails row={row} status={null} /> }),
    };
  });
  return (
    <TileLibrary
      gap={theme.space(3)}
      before={
        <>
          <LibraryStatus library={props.library} />
          {props.empty ? <Empty>{props.empty}</Empty> : null}
        </>
      }
      sections={[{ id: "tokens", label: "Token images in this room", tiles }]}
      after={props.ids.length > 0 && props.hint ? <Help>{props.hint}</Help> : null}
    />
  );
}

function LibraryStatus(props: { library: LibraryState; failed?: string }) {
  const { library } = props;
  return (
    <>
      {library.rows === null && !library.failed ? <Loading text="Loading the library…" /> : null}
      {library.failed ? <Help>{props.failed ?? "The library did not load. Images already on the map are below."}</Help> : null}
    </>
  );
}

/** After Handouts, which come first: the DM comes to the Library for one a few times a session, and for the rest rarely (docs/design-v1-layout-hierarchy.md M6). */
const SECTIONS: { kind: AssetKind; heading: string }[] = [
  { kind: "map", heading: "Maps" },
  { kind: "token", heading: "Token images" },
];

/**
 * The DM's library: every image by kind with its status, and the means to
 * delete those nothing uses. The bulk delete sits at the foot under "Clean
 * up", with what a delete did, out of the way of the images the DM came
 * for. A rare action that cannot be undone led the panel before.
 *
 * Handouts start with the DM's documents (docs/design-v1-pdf-handouts.md
 * 8.1), which come from the room's state rather than the listing, so they
 * show while the listing loads or after it fails. Until it arrives the
 * other sections are the images already on the map, as a player's are.
 */
function ManagedLibrary(props: { roomId: string; library: LibraryState; unlisted: string[]; unlistedEmpty: string; empty: string; hint?: string }) {
  const rows = props.library.rows;
  const assets = useAssets();
  const handouts = useRoomView((s) => s.view?.handouts);
  const handoutDocs = useRoomView((s) => s.view?.handoutDocs);
  const docs = useMemo(() => docsNewestFirst(handoutDocs), [handoutDocs]);
  const uploading = useStore(useScoped(uploadingSlot), (s) => s.ids);
  const deletes = useDocDeletes(props.roomId);
  // The pages of a document being deleted go with it, so they are not listed loose, or offered to Clean up, meanwhile.
  const going = useMemo(() => new Set(Object.values(deletes.flows).flatMap((f) => (deleteRunning(f) ? f.pages : []))), [deletes.flows]);
  const held = useMemo(() => new Set([...docs.flatMap(docAssetIds), ...uploading, ...going]), [docs, uploading, going]);
  const byId = useMemo(() => (rows ? new Map(rows.map((r) => [r.id, r])) : null), [rows]);
  const unused = rows ? notInUse(rows, held) : [];
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  // The last images going take Clean up's button with them, and focus goes to its section, which then says what the delete did.
  const cleanFocus = useHandsFocusTo<HTMLElement>();

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

  const shown = Object.values(handouts ?? {});
  const imageTileOf = (id: string, row: AssetRow | undefined): Tile => {
    const isUploading = uploading.has(id);
    return {
      key: `image:${id}`,
      thumbId: id,
      tag: null,
      ...imageTile(row, { uploading: isUploading, dm: true }),
      view: (close) => ({
        ...imageView(id, row, shown, assets),
        details: <ImageDetails row={row} status={imageStatus(row, isUploading)} />,
        // As the card offered it: an image nothing uses, and not a running upload's page, which the upload may still save.
        actions:
          row?.inUse === false && !held.has(id) ? (
            <TwoTapDelete busy={busy} confirm="Delete it?" onConfirm={() => void remove([id]).then(close)}>
              Delete
            </TwoTapDelete>
          ) : undefined,
      }),
    };
  };
  const docTileOf = (doc: HandoutDoc): Tile => {
    const showing = docShowing(doc, shown);
    const flow = deletes.flows[doc.id];
    return {
      key: `doc:${doc.id}`,
      thumbId: doc.pages[0]?.assetId ?? "",
      ...docTile(doc, showing),
      view: (close) => ({
        title: doc.title,
        pages: doc.pages.map((page, i) => ({
          src: assets.url(page.assetId, "full"),
          thumb: assets.url(page.assetId, "thumb"),
          alt: pageName(doc.title, i, doc.pages.length),
          width: page.width,
          height: page.height,
        })),
        details: <span>{docDetails(doc.pages.length, docBytes(doc, byId), showing)}</span>,
        actions: showing ? undefined : (
          <TwoTapDelete
            busy={flow !== undefined && deleteRunning(flow)}
            confirm={doc.pages.length === 1 ? "Delete it?" : `Delete all ${doc.pages.length} pages?`}
            onConfirm={() => {
              // The document leaves the state at once, which closes the viewer and moves focus on (TileLibrary). A dispatch refused before sending leaves it, so the viewer closes here and the note says why.
              if (deletes.start(doc).phase.t === "unsent") close();
            }}
          >
            Delete
          </TwoTapDelete>
        ),
      }),
    };
  };

  const flows = Object.values(deletes.flows);
  const sections: LibrarySection[] = [
    {
      id: "handouts",
      heading: "Handouts",
      label: "Handouts in this room",
      tiles: [...docs.map(docTileOf), ...(rows ? looseHandouts(rows, docs, going) : []).map((row) => imageTileOf(row.id, row))],
      // Kept while a note says what a document delete came to.
      keep: flows.length > 0,
      after: flows.map((flow) => <DeleteNote key={flow.docId} flow={flow} onRetry={() => deletes.retry(flow.docId)} />),
    },
    ...(rows
      ? SECTIONS.map((section) => ({
          id: section.kind,
          heading: section.heading,
          label: `${section.heading} in this room`,
          tiles: rows.filter((r) => r.kind === section.kind).map((row) => imageTileOf(row.id, row)),
        }))
      : [{ id: "unlisted", label: "Token images in this room", tiles: props.unlisted.map((id) => imageTileOf(id, undefined)) }]),
  ];

  const bytes = totalBytes(unused);
  const empty = docs.length === 0 && (rows ? rows.every((r) => r.kind === "thumb") : props.unlisted.length === 0 && props.library.failed);
  return (
    <TileLibrary
      gap={theme.space(4)}
      before={<LibraryStatus library={props.library} failed={docs.length > 0 ? "The library did not load. Handouts and images already on the map are below." : undefined} />}
      sections={sections}
      after={
        <>
          {empty ? <Empty>{rows ? props.empty : props.unlistedEmpty}</Empty> : props.hint && (rows || props.unlisted.length > 0) ? <Help>{props.hint}</Help> : null}
          {unused.length > 0 || note || busy ? (
            <section ref={cleanFocus.target} tabIndex={-1} style={{ display: "grid", gap: theme.space(2), outline: "none" }}>
              <SectionLabel>Clean up</SectionLabel>
              {unused.length > 0 ? (
                <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
                  <TwoTapDelete
                    buttonRef={cleanFocus.leaving}
                    busy={busy}
                    onConfirm={() => void remove(unused.map((r) => r.id))}
                    confirm={unused.length === 1 ? "Delete it?" : `Delete all ${unused.length}?`}
                  >
                    {`Delete ${unused.length} not in use${bytes !== null ? ` (${formatBytes(bytes)})` : ""}`}
                  </TwoTapDelete>
                  <Help>No token, scene, stamp or handout uses these. A deleted image is gone for good, from undo too.</Help>
                </div>
              ) : null}
              {note ? <NoteLine error={note.error}>{note.text}</NoteLine> : null}
            </section>
          ) : null}
        </>
      }
    />
  );
}

type DocDeletesApi = { flows: Readonly<Record<string, DocDelete>>; start(doc: HandoutDoc): DocDelete; retry(docId: string): void };

/** The room's document deletes, which run in the room scope so closing the Library never strands one (features/images/docDelete.ts). */
function useDocDeletes(roomId: string): DocDeletesApi {
  const slot = useScoped(docDeleteSlot);
  const flows = useStore(slot.store, (s) => s.flows);
  const actions = useRoomActions();
  const room = useRoomStore();
  const deps = { roomId, room, dispatch: actions.dispatch, deleteImages };
  return { flows, start: (doc) => startDocDelete(slot, deps, doc), retry: (docId) => retryDocDelete(slot, deps, docId) };
}

// ---------------------------------------------------------------- tiles that open the viewer (docs/design-v1-pdf-handouts.md 8.4)

/** What the viewer shows for a tile. `actions` sit in its header, left of Expand and Close. */
type TileView = { title: string; pages: ViewerPage[]; details?: ReactNode; actions?: ReactNode };

/**
 * One tile. `key` is also the viewer's showing key, `image:<id>` or
 * `doc:<id>` (section 5.1). `tag` sits in the bottom left corner and
 * `status`, the DM's, in the bottom right. `view` is asked only for the
 * tile open, with a way to close it once its Delete has run.
 */
type Tile = { key: string; thumbId: string; label: string; tag: string | null; status: string | null; view(close: () => void): TileView };

type LibrarySection = { id: string; heading?: string; label: string; tiles: readonly Tile[]; after?: ReactNode; keep?: boolean };

/** A section's tiles by key, in order, as the focus rule after a delete reads them. */
export type SectionTiles = { id: string; heading: boolean; keys: readonly string[] };

export type FocusTarget = { t: "tile"; key: string } | { t: "heading"; section: string } | { t: "panel" };

/**
 * Where focus goes once the tile open in the viewer is gone, deleted here
 * or on another device (section 8.4): the next tile still in its section,
 * else the one before, else the section's heading while the section is
 * still there, else the panel's first control. `before` is the sections as
 * they were while the tile was there, `now` as they are.
 */
export function focusAfterDelete(before: readonly SectionTiles[], gone: string, now: readonly SectionTiles[]): FocusTarget {
  const section = before.find((s) => s.keys.includes(gone));
  if (!section) return { t: "panel" };
  const still = now.find((s) => s.id === section.id);
  const left = new Set(still?.keys ?? []);
  const at = section.keys.indexOf(gone);
  for (let i = at + 1; i < section.keys.length; i++) if (left.has(section.keys[i]!)) return { t: "tile", key: section.keys[i]! };
  for (let i = at - 1; i >= 0; i--) if (left.has(section.keys[i]!)) return { t: "tile", key: section.keys[i]! };
  return still?.heading ? { t: "heading", section: section.id } : { t: "panel" };
}

/**
 * The tiles of a library, by section, and the one viewer they open. A tap
 * on a tile opens it, and closing the viewer hands focus back to the tile.
 * A tile that goes while open (its Delete ran, or another device deleted
 * its document) closes the viewer, and focus follows focusAfterDelete,
 * since the tile it would return to is gone.
 */
function TileLibrary(props: { sections: readonly LibrarySection[]; before?: ReactNode; after?: ReactNode; gap: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const sectionEls = useRef(new Map<string, HTMLElement>());
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const shownSections = props.sections.filter((s) => s.tiles.length > 0 || s.keep);
  const order: SectionTiles[] = shownSections.map((s) => ({ id: s.id, heading: s.heading !== undefined, keys: s.tiles.map((t) => t.key) }));
  const openTile = open === null ? undefined : props.sections.flatMap((s) => s.tiles).find((t) => t.key === open);
  const lastOrder = useRef<SectionTiles[]>([]);

  useEffect(() => {
    if (open === null) return;
    if (openTile) {
      lastOrder.current = order;
      return;
    }
    setOpen(null);
    const target = focusAfterDelete(lastOrder.current, open, order);
    if (target.t === "tile") tiles.current.get(target.key)?.focus();
    else if (target.t === "heading") focusHeading(sectionEls.current.get(target.section) ?? null);
    else focusPanel(rootRef.current);
  });

  const close = (key: string) => () => setOpen((current) => (current === key ? null : current));
  const view = openTile?.view(close(openTile.key));
  return (
    <div ref={rootRef} style={{ display: "grid", gap: props.gap }}>
      {props.before}
      {shownSections.map((section) => (
        <section
          key={section.id}
          ref={(el) => {
            if (!el) return;
            sectionEls.current.set(section.id, el);
            return () => void sectionEls.current.delete(section.id);
          }}
          style={{ display: "grid", gap: theme.space(2) }}
        >
          {section.heading ? <SectionLabel>{section.heading}</SectionLabel> : null}
          {section.tiles.length > 0 ? (
            <Tiles label={section.label}>
              {section.tiles.map((tile) => (
                <li key={tile.key} style={{ position: "relative" }}>
                  <button
                    type="button"
                    ref={(el) => {
                      if (!el) return;
                      tiles.current.set(tile.key, el);
                      return () => void tiles.current.delete(tile.key);
                    }}
                    aria-label={tile.label}
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setOpen(tile.key);
                    }}
                    style={tileStyle}
                  >
                    <Thumb id={tile.thumbId} />
                  </button>
                  <TileMarks tag={tile.tag} status={tile.status} />
                </li>
              ))}
            </Tiles>
          ) : null}
          {section.after}
        </section>
      ))}
      {props.after}
      {openTile && view ? (
        <HandoutViewer
          title={view.title}
          onClose={() => setOpen(null)}
          pages={view.pages}
          showing={openTile.key}
          details={view.details}
          headerActions={view.actions}
          backClose
          opener={opener}
        />
      ) : null}
    </div>
  );
}

/**
 * SectionLabel takes no ref, so its heading is found in its section. It
 * takes focus from script only (`tabIndex` -1), never as a Tab stop.
 */
function focusHeading(section: HTMLElement | null): void {
  const heading = section?.querySelector<HTMLElement>("h2, h3, h4");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus();
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The panel's first control: in the desktop panel's tab panel, or the phone sheet's region, which holds its header too. */
function focusPanel(root: HTMLElement | null): void {
  const panel = root?.closest<HTMLElement>('[role="tabpanel"], section[aria-label]') ?? root?.parentElement ?? null;
  const first = panel ? [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.getClientRects().length > 0) : undefined;
  first?.focus();
}

/** A tile's marks: its tag in the bottom left, and its status in the bottom right, which wraps above the tag where a narrow tile has no room for both. The tile's name says both, so they are hidden from screen readers. */
function TileMarks(props: { tag: string | null; status: string | null }) {
  if (!props.tag && !props.status) return null;
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        left: theme.space(1),
        right: theme.space(1),
        bottom: theme.space(1),
        display: "flex",
        flexWrap: "wrap-reverse",
        alignItems: "flex-end",
        gap: theme.space(0.5),
        pointerEvents: "none",
      }}
    >
      {props.tag ? <Mark>{props.tag}</Mark> : null}
      {props.status ? <Mark end>{props.status}</Mark> : null}
    </span>
  );
}

/** Small text on a solid fill, legible on any image. It wraps rather than run past a narrow tile. */
function Mark(props: { end?: boolean; children: ReactNode }) {
  const tone = TAG_TONES.muted;
  return (
    <span
      style={{
        marginLeft: props.end ? "auto" : 0,
        maxWidth: "100%",
        padding: `1px ${theme.space(1)}px`,
        borderRadius: theme.radius.sm,
        border: `${theme.line.border}px solid ${tone.outline}`,
        background: theme.color.bg,
        color: tone.text,
        fontSize: theme.font.tiny,
        fontWeight: theme.weight.strong,
        lineHeight: theme.leading.tight,
        textAlign: props.end ? "right" : "left",
        overflowWrap: "anywhere",
      }}
    >
      {props.children}
    </span>
  );
}

/** What the image is: its tile's name, and its viewer's title unless a handout shows it under one. */
function kindName(row: AssetRow | undefined): string {
  return row?.kind === "map" ? "Map" : row?.kind === "handout" ? "Handout" : "Token image";
}

/** The DM's status of an image: a running PDF upload's page on this device first, which the upload may still save (section 4.1.2). */
function imageStatus(row: AssetRow | undefined, uploading: boolean): string | null {
  return uploading ? "Uploading" : row?.inUse === true ? "In use" : row?.inUse === false ? "Not in use" : null;
}

/** An image tile's name and its status, which only the DM's tiles show. */
export function imageTile(row: AssetRow | undefined, opts: { uploading?: boolean; dm: boolean }): { label: string; status: string | null } {
  const name = kindName(row);
  const uploading = opts.uploading === true;
  const label = uploading ? `${name}, uploading` : row?.inUse === false ? `${name}, not in use` : name;
  return { label, status: opts.dm ? imageStatus(row, uploading) : null };
}

/** A document's tile: its page count in the tag, and "Showing now" while a handout shows exactly its pages (section 8.1). */
export function docTile(doc: Pick<HandoutDoc, "title" | "pages">, showing: boolean): { label: string; tag: string; status: string | null } {
  const count = pageCountText(doc.pages.length);
  return { label: `${doc.title}, handout, ${count}${showing ? ", showing now" : ""}`, tag: count, status: showing ? "Showing now" : null };
}

/** The viewer's line for an image: its size once the list has it, then the DM's status. */
export function imageDetails(row: Pick<AssetRow, "width" | "height" | "bytes"> | undefined, status: string | null): string | null {
  const size = row ? `${row.width} × ${row.height} px${typeof row.bytes === "number" ? `, ${formatBytes(row.bytes)}` : ""}.` : null;
  const parts = [size, status ? `${status}.` : null].filter((p) => p !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The viewer's line for a document. A showing one has no Delete, so the line says how to get one. */
export function docDetails(pages: number, bytes: number | null, showing: boolean): string {
  return `${pageCountText(pages)}${bytes !== null ? `, ${formatBytes(bytes)}` : ""}.${showing ? " Showing now. Close it in the DM panel to delete it." : ""}`;
}

function ImageDetails(props: { row: AssetRow | undefined; status: string | null }) {
  const line = imageDetails(props.row, props.status);
  return (
    <>
      {line ? <span>{line}</span> : null}
      {props.row?.credit ? <CreditLine credit={props.row.credit} stored={props.row} /> : null}
    </>
  );
}

function imageView(id: string, row: AssetRow | undefined, handouts: readonly Handout[], assets: AssetSource): TileView {
  const title = viewTitle(id, row, handouts);
  return { title, pages: [{ src: assets.url(id, viewVariant(row)), alt: title }] };
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

type ShownHandout = Parameters<typeof handoutPages>[0] & { title: string; shownAt: string };

/**
 * The viewer's title: a handout's that shows this image, the one shown
 * last, else what the image is. A handout of pages names the page, "Strange
 * letter, page 3", its first when the image fills several
 * (docs/design-v1-pdf-handouts.md 8.1).
 */
export function viewTitle(id: string, row: AssetRow | undefined, handouts: readonly ShownHandout[]): string {
  let shown: { title: string; shownAt: string; page: number; pages: number } | null = null;
  for (const h of handouts) {
    const pages = handoutPages(h);
    const page = pages.findIndex((p) => p.assetId === id);
    if (page >= 0 && (!shown || h.shownAt > shown.shownAt)) shown = { title: h.title, shownAt: h.shownAt, page, pages: pages.length };
  }
  if (!shown) return kindName(row);
  return shown.pages > 1 ? `${shown.title}, page ${shown.page + 1}` : shown.title;
}

function DeleteNote(props: { flow: DocDelete; onRetry(): void }) {
  const connected = useRoomView((s) => s.connection === "open");
  const note = docDeleteNote(props.flow, connected);
  const focus = useHandsFocusTo<HTMLDivElement>();
  return (
    <div ref={focus.target} tabIndex={-1} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), outline: "none" }}>
      <NoteLine error={note.error}>{note.text}</NoteLine>
      {note.retry ? (
        <Button ref={focus.leaving} size="sm" onClick={props.onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A button that leaves as it is pressed, its work done (a delete's Try
 * again, Clean up's last delete), hands focus to `target`, which takes it
 * from script only. Otherwise focus would fall to the page, and a keyboard
 * or screen reader user would have to find the Library again. `leaving` is
 * the button's ref. Where focus goes is chosen once the step is drawn.
 */
function useHandsFocusTo<T extends HTMLElement>(): { target: RefObject<T | null>; leaving(el: HTMLElement | null): (() => void) | undefined } {
  const target = useRef<T>(null);
  const lost = useRef(false);
  useLayoutEffect(() => {
    if (!lost.current) return;
    lost.current = false;
    const active = document.activeElement;
    // Something else took focus meanwhile, which it keeps.
    if (active !== null && active !== document.body) return;
    target.current?.focus({ preventScroll: true });
  });
  const leaving = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    return () => {
      if (el.contains(document.activeElement)) lost.current = true;
    };
  }, []);
  return { target, leaving };
}

function NoteLine(props: { error?: boolean; children: ReactNode }) {
  return (
    <p role={props.error ? "alert" : "status"} style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere", fontSize: theme.font.body14, color: props.error ? theme.color.dangerText : theme.color.textMuted }}>
      {props.children}
    </p>
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
function TwoTapDelete(props: { busy: boolean; confirm: string; onConfirm(): void; children: ReactNode; buttonRef?: Ref<HTMLButtonElement> }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      ref={props.buttonRef}
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
