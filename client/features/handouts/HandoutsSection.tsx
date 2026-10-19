import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStore } from "zustand";
import { handoutPages } from "#shared/handouts.ts";
import type { Handout, HandoutDoc, Member } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { useExpansionFocus } from "../../components/expansionFocus.ts";
import { ErrorText, Field } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Row, RowDot, RowList } from "../../components/Row.tsx";
import { Tag } from "../../components/Tag.tsx";
import { api, ApiError, type AssetRow } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useAssets, useRoomActions, useRoomView } from "../../state/view.ts";
import { FileButton, RadioGroup } from "../dm/controls.tsx";
import { honorsImageOrientation } from "../images/orientation.ts";
import { PasteButton, PasteStatus, usePasteTarget } from "../images/PasteImage.tsx";
import { apartFromStarter, docShowing } from "../images/library.ts";
import { checkImageFile, prepareImageUpload } from "../images/upload.ts";
import { EMPTY_DRAFT, handoutDraftSlot, withPick, withTypedTitle, type HandoutDraft } from "./draft.ts";
import { HANDOUT_MAX_BYTES, HANDOUT_MAX_SIDE } from "./downscale.ts";
import { audienceText, pageCountText, showHandoutOp, showingKey, TITLE_FIELD_MAX, titleFromFileName, viewerPagesOf } from "./handouts.ts";
import { HandoutViewer, type ViewerPage } from "./HandoutViewer.tsx";
import { JobBlock } from "./pdf/JobBlock.tsx";
import { isPdfFile, jobPageIds, pdfPickRefusal } from "./pdf/job.ts";
import { usePdfJob } from "./pdf/live.ts";
import { StarterDialog } from "../starter/StarterDialog.tsx";

const STARTER_HANDOUT_USES = ["handout"] as const;

/** A handout's thumbnail in its row: a picture, so larger than a row's 32 px disk, still inside a 56 px two-line row. */
const THUMB_PX = 44;

/**
 * What the viewer shows, by its identity only: a showing or a document.
 * Its pages and the lines under its title are read from the room as it is
 * now, so they follow a change made elsewhere, and the viewer closes when
 * the item goes, as the Library's does (docs/design-v1-pdf-handouts.md 5.9
 * and 8.4).
 */
type Viewing = { kind: "handout"; id: string } | { kind: "doc"; id: string } | { kind: "image"; asset: AssetRow; title: string };

/** What the viewer draws for the item: its title, its pages, the showing it is (the players' key, or `doc:<id>`), and its details. */
type Viewed = { title: string; pages: ViewerPage[]; showing: string; details: string };

/**
 * The DM's handouts (features section 16): a PDF being uploaded, what is
 * showing now, with a way to look at each as players see it and to close
 * it for everyone, and a form to show a new one from the room's library or
 * a fresh upload (docs/design-v1-pdf-handouts.md 4.1, 8.2 and 8.4).
 */
export function HandoutsSection() {
  const handouts = useRoomView((s) => s.view?.handouts);
  const members = useRoomView((s) => s.view?.members);
  const docs = useRoomView((s) => s.view?.handoutDocs);
  const actions = useRoomActions();
  const assets = useAssets();
  const draft = useScoped(handoutDraftSlot);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const viewOpener = useRef<HTMLElement | null>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const showing = useMemo(
    () => Object.values(handouts ?? {}).filter((h): h is Handout => h !== undefined).sort((a, b) => (a.shownAt < b.shownAt ? 1 : -1)),
    [handouts],
  );
  const view = (next: Viewing, opener: HTMLElement | null) => {
    viewOpener.current = opener;
    setViewing(next);
  };
  /** A document's View: every page, under the Library's key for it, with its page count and whether it shows. */
  const viewDoc = useCallback((docId: string, opener: HTMLElement | null) => view({ kind: "doc", id: docId }, opener), []);
  const viewedHandout = viewing?.kind === "handout" ? handouts?.[viewing.id] : undefined;
  const viewedDoc = viewing?.kind === "doc" ? docs?.[viewing.id] : undefined;
  // A document's "Showing now." changes only with the showings, which the memo below follows through `handouts`.
  const viewed = useMemo((): Viewed | null => {
    const url = (id: string, variant: "full" | "thumb") => assets.url(id, variant);
    if (viewedHandout) {
      const h = viewedHandout;
      const pages = handoutPages(h);
      return {
        title: h.title,
        pages: viewerPagesOf(h.title, pages, url),
        showing: showingKey(h),
        details: `To ${audienceText(h.to, members ?? {})}${pages.length > 1 ? `, ${pageCountText(pages.length)}` : ""}. Showing now.`,
      };
    }
    if (viewedDoc) {
      const shown = docShowing(viewedDoc, Object.values(handouts ?? {}));
      return {
        title: viewedDoc.title,
        pages: viewerPagesOf(viewedDoc.title, viewedDoc.pages, url),
        showing: `doc:${viewedDoc.id}`,
        details: `${pageCountText(viewedDoc.pages.length)}.${shown ? " Showing now." : ""}`,
      };
    }
    // A loose image picked in the form, under the Library's key for it.
    if (viewing?.kind === "image") {
      const { asset, title } = viewing;
      return {
        title,
        pages: viewerPagesOf(title, [{ assetId: asset.id, width: asset.width, height: asset.height }], url),
        showing: `image:${asset.id}`,
        details: `${asset.width} × ${asset.height} px.`,
      };
    }
    return null;
  }, [viewing, viewedHandout, viewedDoc, handouts, members, assets]);
  // Closed or deleted elsewhere while open: the viewer closes, and focus goes back to its opener if that is still there, else on in the section.
  useEffect(() => {
    if (!viewing || viewed) return;
    setViewing(null);
    /*
     * The opener may go with the item: a Showing now row, or the form's
     * pick of a deleted document, which the form drops in an effect of its
     * own after this one. So the place for focus is chosen once both have
     * settled, and only when focus was left nowhere.
     */
    setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      (formRef.current?.querySelector<HTMLElement>("button, input") ?? showButton.current)?.focus();
    }, 0);
  }, [viewing, viewed]);
  // Where focus goes when the upload's block leaves: the form when it is open, else Show a handout (4.1.7).
  const afterBlock = useCallback(() => {
    const form = formRef.current;
    if (form) form.querySelector<HTMLElement>("button, input")?.focus();
    else showButton.current?.focus();
  }, []);
  // Show it: the saved document picked in the form, opening it, in place of any other pick, and keeping a title the DM typed (4.1.5, the project owner, 2026-10-16).
  const showSaved = useCallback(
    (docId: string) => {
      const now = draft.getState();
      draft.setState({ ...withPick(now, { kind: "doc", docId }, docs?.[docId]?.title ?? ""), open: true });
    },
    [draft, docs],
  );
  return (
    <Section label="Handouts" divider={false}>
      <JobBlock
        onLeave={afterBlock}
        onShow={showSaved}
        onView={viewDoc}
      />
      {showing.length === 0 ? <Help>No handout is showing.</Help> : <Help>Showing now. Players can close their own copy.</Help>}
      {showing.length > 0 ? (
        <RowList label="Handouts showing">
          {showing.map((h) => {
            const pages = handoutPages(h);
            return (
              <Row
                key={h.id}
                leading={
                  // The DM sees what the players see, at the same showing (8.4).
                  <button
                    type="button"
                    aria-label={`View ${h.title}`}
                    onClick={(e) => view({ kind: "handout", id: h.id }, e.currentTarget)}
                    style={{ display: "block", padding: 0, border: "none", background: "transparent", cursor: "pointer", borderRadius: theme.radius.sm }}
                  >
                    <img
                      src={assets.url(h.assetId, "thumb")}
                      alt=""
                      width={THUMB_PX}
                      height={THUMB_PX}
                      style={{ display: "block", objectFit: "cover", borderRadius: theme.radius.sm, background: theme.color.bg }}
                    />
                  </button>
                }
                title={h.title}
                detail={`To ${audienceText(h.to, members ?? {})}${pages.length > 1 ? `, ${pageCountText(pages.length)}` : ""}`}
                trailing={
                  // Hide, not Close: it stops showing the handout to players, and Close is the app's word for closing a pane (docs/design-v1-icons.md 2.3).
                  <Button variant="danger" size="sm" icon="hidden" onClick={() => actions.dispatch({ t: "handout.close", handoutId: h.id })}>
                    Hide
                  </Button>
                }
              />
            );
          })}
        </RowList>
      ) : null}
      <ShowHandout
        members={members ?? {}}
        docs={docs ?? {}}
        opener={showButton}
        formRef={formRef}
        onViewDoc={viewDoc}
        onViewImage={(asset, title, opener) => view({ kind: "image", asset, title }, opener)}
      />
      {viewed ? (
        <HandoutViewer
          title={viewed.title}
          pages={viewed.pages}
          showing={viewed.showing}
          details={<span>{viewed.details}</span>}
          onClose={() => setViewing(null)}
          backClose
          opener={viewOpener}
        />
      ) : null}
    </Section>
  );
}

function ShowHandout(props: {
  members: Record<string, Member | undefined>;
  docs: Record<string, HandoutDoc | undefined>;
  opener: RefObject<HTMLButtonElement | null>;
  formRef: RefObject<HTMLDivElement | null>;
  onViewDoc(docId: string, opener: HTMLElement | null): void;
  /** View on a picked image: it opens as the Library opens it. */
  onViewImage(asset: AssetRow, title: string, opener: HTMLElement | null): void;
}) {
  const roomId = useRoomView((s) => s.roomId);
  const actions = useRoomActions();
  const assets = useAssets();
  const draftStore = useScoped(handoutDraftSlot);
  const draft = useStore(draftStore);
  const set = useCallback((patch: Partial<HandoutDraft>) => draftStore.setState({ ...draftStore.getState(), ...patch }), [draftStore]);
  const { open, pick, title, audience, chosen } = draft;
  const pdf = usePdfJob();
  const [library, setLibrary] = useState<AssetRow[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starter, setStarter] = useState(false);
  const starterButton = useRef<HTMLButtonElement>(null);
  // A PDF saved while the form is open with nothing picked is picked at once, its title too unless one was typed (4.1.5).
  const savedDocId = pdf.job?.phase.k === "saved" ? pdf.job.docId : null;
  const savedDocHere = savedDocId !== null && props.docs[savedDocId] !== undefined;
  const autoPicked = useRef<string | null>(null);
  useEffect(() => {
    if (!savedDocId || !savedDocHere || autoPicked.current === savedDocId) return;
    autoPicked.current = savedDocId;
    const now = draftStore.getState();
    if (!now.open || now.pick) return;
    draftStore.setState(withPick(now, { kind: "doc", docId: savedDocId }, props.docs[savedDocId]?.title ?? ""));
  }, [savedDocId, savedDocHere, draftStore, props.docs]);
  // The form opens at its first field, and Show or Cancel gives focus back to the button that opened it.
  const { opener, formRef: form } = props;
  useExpansionFocus(open, { inside: form, opener });
  // Start the orientation check now, so it has finished by the first upload.
  useEffect(() => void honorsImageOrientation(), []);
  const players = Object.values(props.members)
    .filter((m): m is Member => m !== undefined && m.kind === "player")
    .sort((a, b) => a.name.localeCompare(b.name));
  // Documents first, newest first, from the DM's state with no request (8.2).
  const docs = useMemo(() => Object.values(props.docs).filter((d): d is HandoutDoc => d !== undefined).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), [props.docs]);
  const picked = pick?.kind === "doc" ? props.docs[pick.docId] : undefined;
  // A document picked here and deleted on another device lets the form go (8.2).
  useEffect(() => {
    if (pick?.kind === "doc" && !props.docs[pick.docId]) {
      set({ pick: null });
      setError("That handout was deleted.");
    }
  }, [pick, props.docs, set]);
  // The loose images: none a document names, and none a running upload made or reused on this device (4.1.2).
  const uploading = jobPageIds(pdf.job);
  const inDocs = useMemo(() => new Set(docs.flatMap((d) => d.pages.map((p) => p.assetId))), [docs]);
  const loose = library?.filter((a) => !inDocs.has(a.id) && !uploading.has(a.id)) ?? null;
  // The DM's own images first, then the starter picks apart (docs/design-v1-starter-art.md 5), as the Library panel lists them.
  const looseApart = apartFromStarter(loose ?? [], (a) => a);
  // A paste takes Upload a file's path, a PDF to its page job and an image shrunk and uploaded, while the form is open with nothing picked (docs/design-v1-paste.md 1.2).
  const paste = usePasteTarget(form, { accepts: "image-or-pdf", takes: open && !pick ? "open" : "none", disabled: status !== null, onFile: (f) => upload(f) });
  const imageTile = (a: AssetRow) => (
    <button
      key={a.id}
      type="button"
      aria-label="Use this image"
      onClick={() => draftStore.setState(withPick(draftStore.getState(), { kind: "image", asset: a }, ""))}
      style={{ padding: 0, border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.sm, background: "transparent", cursor: "pointer", aspectRatio: "1" }}
    >
      <img src={assets.url(a.id, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: theme.radius.sm }} />
    </button>
  );

  if (!open) {
    return (
      <Button ref={opener} size="sm" onClick={() => set({ open: true })} style={{ justifySelf: "start" }}>
        Show a handout
      </Button>
    );
  }

  const loadLibrary = async () => {
    setError(null);
    setStatus("Loading the library…");
    try {
      const res = await api.listAssets(roomId);
      setLibrary(res.assets.filter((a) => a.kind === "handout"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The library could not be loaded.");
    } finally {
      setStatus(null);
    }
  };

  const uploadImage = async (file: File) => {
    setStatus("Preparing the image…");
    try {
      checkImageFile(file);
      // A phone photo shrinks to a few hundred KB before it crosses the remote player's link (design 11.1).
      const blob = await prepareImageUpload(file, HANDOUT_MAX_SIDE);
      if (blob.size > HANDOUT_MAX_BYTES) throw new Error("That image is larger than 10 MB, even after shrinking it.");
      setStatus("Uploading…");
      const row = await api.uploadAsset(roomId, "handout", blob, {
        onWaiting: (w) => setStatus(w ? "Waiting for the server…" : "Uploading…"),
      });
      setLibrary((list) => (list && !list.some((a) => a.id === row.id) ? [row, ...list] : list));
      const now = draftStore.getState();
      draftStore.setState(withPick(now, { kind: "image", asset: row }, titleFromFileName(file.name)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setStatus(null);
    }
  };

  // A starter picture is copied in as a handout image and picked as an upload is, titled with the work's name (docs/design-v1-starter-art.md 4).
  const pickStarter = (row: AssetRow, name: string) => {
    setStarter(false);
    setError(null);
    setLibrary((list) => (list && !list.some((a) => a.id === row.id) ? [row, ...list] : list));
    draftStore.setState(withPick(draftStore.getState(), { kind: "image", asset: row }, name));
  };

  // An image takes today's path, and a PDF opens in the upload's own block (4.1.3).
  const upload = (file: File) => {
    setError(null);
    if (!isPdfFile(file)) return void uploadImage(file);
    const refused = pdfPickRefusal(file, pdf.job);
    if (refused) return setError(refused);
    const held = pdf.start(file);
    if (held) setError(held);
  };

  const show = () => {
    const input = { id: actions.newId(), title, audience: audience === "all" ? ("all" as const) : chosen };
    const result =
      pick?.kind === "doc"
        ? picked
          ? showHandoutOp({ ...input, pages: picked.pages })
          : ({ ok: false, error: "That handout was deleted." } as const)
        : pick?.kind === "image"
          ? showHandoutOp({ ...input, assetId: pick.asset.id })
          : null;
    if (!result) return setError("Pick an image first.");
    if (!result.ok) return setError(result.error);
    actions.dispatch(result.op);
    draftStore.setState(EMPTY_DRAFT);
  };

  return (
    <div
      ref={form}
      role="group"
      aria-label="Show a handout"
      style={{
        display: "grid",
        // As the upload's block: a column narrower than a field's own width, so nothing runs past the form's edge at 246 px.
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(3),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.bg,
        minWidth: 0,
      }}
    >
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <strong style={{ fontSize: theme.font.body14 }}>Image or PDF</strong>
        {pick ? (
          <div style={{ display: "flex", alignItems: "center", gap: theme.space(3), flexWrap: "wrap" }}>
            <img
              src={assets.url(pick.kind === "doc" ? (picked?.pages[0]?.assetId ?? "") : pick.asset.id, "thumb")}
              alt=""
              width={72}
              height={72}
              style={{ objectFit: "cover", borderRadius: theme.radius.sm }}
            />
            {pick.kind === "doc" && picked ? (
              <>
                <span style={{ fontSize: theme.font.body14 }}>{pageCountText(picked.pages.length)}</span>
                <Button size="sm" onClick={(e) => props.onViewDoc(picked.id, e.currentTarget)}>
                  View
                </Button>
              </>
            ) : null}
            {pick.kind === "image" ? (
              // A picked image opens too, as a picked document does (the project owner, 2026-10-16).
              <Button size="sm" onClick={(e) => props.onViewImage(pick.asset, title.trim() || "Handout", e.currentTarget)}>
                View
              </Button>
            ) : null}
            <Button size="sm" onClick={() => set({ pick: null })}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
              <Button size="sm" onClick={() => void loadLibrary()} disabled={status !== null}>
                From the library
              </Button>
              <FileButton label="Upload a file" accept="image/*,application/pdf,.pdf" size="sm" disabled={status !== null} onFile={upload} />
              <PasteButton paste={paste} />
              <Button ref={starterButton} size="sm" onClick={() => setStarter(true)} disabled={status !== null}>
                From starter packs
              </Button>
            </div>
            <PasteStatus paste={paste} />
            {starter ? (
              <StarterDialog
                title="Starter handouts"
                uses={STARTER_HANDOUT_USES}
                kind="handout"
                hint="Openly licensed pictures to show players. Use copies one into this room's library with its credit."
                onPicked={(row, found) => pickStarter(row, found.work.name)}
                onClose={() => setStarter(false)}
                opener={starterButton}
              />
            ) : null}
            {library || docs.length > 0 ? (
              docs.length === 0 && loose?.length === 0 ? (
                <Help>No handout images yet. Upload one.</Help>
              ) : docs.length === 0 && looseApart.own.length === 0 ? null : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: theme.space(2) }}>
                  {docs.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      aria-label={`Use ${d.title}, ${pageCountText(d.pages.length)}`}
                      onClick={() => draftStore.setState(withPick(draftStore.getState(), { kind: "doc", docId: d.id }, d.title))}
                      style={{
                        position: "relative",
                        padding: 0,
                        border: `${theme.line.border}px solid ${theme.color.border}`,
                        borderRadius: theme.radius.sm,
                        background: "transparent",
                        cursor: "pointer",
                        aspectRatio: "1",
                        overflow: "hidden",
                      }}
                    >
                      <img src={assets.url(d.pages[0]?.assetId ?? "", "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: theme.radius.sm }} />
                      <span aria-hidden style={{ position: "absolute", left: theme.space(1), bottom: theme.space(1), display: "flex", pointerEvents: "none" }}>
                        <Tag dense>{pageCountText(d.pages.length)}</Tag>
                      </span>
                    </button>
                  ))}
                  {looseApart.own.map(imageTile)}
                </div>
              )
            ) : null}
            {looseApart.starter.length > 0 ? (
              <>
                <Help>From starter packs</Help>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: theme.space(2) }}>{looseApart.starter.map(imageTile)}</div>
              </>
            ) : null}
          </>
        )}
        {status ? <Loading text={status} delay={0} /> : null}
      </div>
      <Field label="Title" value={title} maxLength={TITLE_FIELD_MAX} onChange={(e) => draftStore.setState(withTypedTitle(draftStore.getState(), e.target.value))} placeholder="The old map" />
      <RadioGroup<"all" | "some">
        legend="Show to"
        value={audience}
        options={[
          { value: "all", label: "Everyone" },
          { value: "some", label: "Chosen players" },
        ]}
        onChange={(value) => set({ audience: value })}
      />
      {audience === "some" ? (
        players.length === 0 ? (
          <Help>No players have joined yet.</Help>
        ) : (
          <div role="group" aria-label="Players to show it to" style={{ display: "grid" }}>
            {players.map((p) => (
              <Checkbox
                key={p.id}
                label={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2) }}>
                    <RowDot color={p.color} size={12} />
                    {p.name}
                  </span>
                }
                checked={chosen.includes(p.id)}
                onChange={(on) => set({ chosen: on ? [...chosen, p.id] : chosen.filter((id) => id !== p.id) })}
              />
            ))}
          </div>
        )
      ) : null}
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
        <Button variant="primary" size="sm" icon="shown" onClick={show} disabled={!pick || status !== null}>
          Show
        </Button>
        {/* Cancel only closes the form and keeps its draft. A PDF upload goes on in its own block. */}
        <Button size="sm" onClick={() => set({ open: false })}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
