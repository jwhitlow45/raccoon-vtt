import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Dialog } from "../../../components/Dialog.tsx";
import { Empty } from "../../../components/Empty.tsx";
import { ErrorText, Input } from "../../../components/Field.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { choiceLook } from "../../../components/looks.ts";
import { Help, SectionLabel } from "../../../components/Panel.tsx";
import { api } from "../../../lib/api.ts";
import { theme } from "../../../lib/theme.ts";
import { useAssets, useRoomView } from "../../../state/view.ts";
import { STAMP_TILE_FLOOR } from "./draw.ts";
import { libraryFootprint, matchStamps, shippedChoice, starterChoice, type ChosenArt } from "./rules.ts";
import { imageAssetId } from "#shared/imageRef.ts";
import { imageErrorMessage } from "../../images/errors.ts";
import { PasteButton, PasteStatus, usePasteTarget, type PasteHandle } from "../../images/PasteImage.tsx";
import { useHandoff } from "../../images/roomPaste.ts";
import { PickError, uploadTokenImage } from "../../images/upload.ts";
import { StarterBrowser } from "../../starter/StarterBrowser.tsx";

/** The search field's share of the header: room for a word or two, with the title kept whole down to a 390 px phone. */
const SEARCH_BASIS = 240;

/**
 * The stamp picker (design 3.5): a search box and a grid of 56 px tiles,
 * each with its name, for the shipped art, then the room's own token images
 * under "This room's images". Picking one sets what the next tap places.
 * Its Starter tab offers the starter packs' props by pack and category
 * (docs/design-v1-starter-art.md 4), which a stamp names by key as the
 * shipped ones do, so a pick copies nothing and asks the server nothing.
 *
 * It is the one Dialog shell (docs/design-v1-visual.md 2.3), a bottom
 * sheet on a phone, so the room behind is inert, Escape and Android's Back
 * close it, and focus goes back to the button that chooses a stamp, also
 * when a tap on the map opened it. The search sits in the header, so it
 * stays in reach while the tiles scroll under it.
 *
 * A pasted image joins the room's images as a token image does, and
 * becomes what the next tap places, at its own shape (docs/design-v1-paste.md
 * 1.2).
 */
export function StampPicker(props: {
  chosen: ChosenArt | null;
  onPick(chosen: ChosenArt): void;
  /** A room image's shape, once read from the picture, for a pick the list had no size for. */
  onMeasured(chosen: ChosenArt): void;
  onClose(): void;
  opener: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"stamps" | "starter">("stamps");
  const shipped = useMemo(() => matchStamps(query), [query]);
  const { onPick } = props;
  const roomId = useRoomView((s) => s.roomId);
  const [upload, setUpload] = useState<PastedUpload>({ busy: false, waiting: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const takePasted = async (file: File) => {
    // The room's images are where it lands, so their tab shows its progress.
    setTab("stamps");
    const abort = new AbortController();
    abortRef.current = abort;
    setUpload({ busy: true, waiting: false, error: null });
    try {
      const asset = await uploadTokenImage(roomId, file, { signal: abort.signal, onWaiting: (waiting) => setUpload((u) => ({ ...u, waiting })) });
      setUpload({ busy: false, waiting: false, error: null });
      onPick({ art: { assetId: asset.id }, ...libraryFootprint(asset.width, asset.height), name: "Room image" });
    } catch (err) {
      if (!abort.signal.aborted) setUpload({ busy: false, waiting: false, error: err instanceof PickError ? err.message : imageErrorMessage(err) });
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  };
  const body = useRef<HTMLDivElement>(null);
  // The whole dialog, so an image pasted with focus in the header's search box lands here too.
  const whole = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return body.current?.closest("dialog") ?? body.current;
      },
    }),
    [],
  );
  const paste = usePasteTarget(whole, { accepts: "image", takes: "open", disabled: upload.busy, onFile: (f) => void takePasted(f) });
  // The room's "Use the pasted image" opens the picker on its picture (docs/design-v1-paste.md 4).
  useHandoff("stamp", !upload.busy, (file) => void takePasted(file));

  const chosenKey = props.chosen && "key" in props.chosen.art ? props.chosen.art.key : null;
  const chosenAsset = props.chosen && "assetId" in props.chosen.art ? props.chosen.art.assetId : null;

  return (
    <Dialog
      title="Stamps"
      onClose={props.onClose}
      width="md"
      phone="sheet"
      backClose
      opener={props.opener}
      headerActions={
        // The Starter tab searches its packs in a field of its own, as the image picker's does.
        tab === "stamps" ? (
          <Input type="search" aria-label="Search stamps" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: `0 1 ${SEARCH_BASIS}px`, width: 0 }} />
        ) : undefined
      }
    >
      <div ref={body}>
        <div role="tablist" aria-label="Which stamps" style={{ display: "flex", gap: theme.space(1), marginBottom: theme.space(3) }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: "1 0 auto",
                minHeight: theme.touch,
                padding: `0 ${theme.space(3)}px`,
                borderRadius: theme.radius.md,
                fontFamily: theme.font.body,
                fontSize: theme.font.body14,
                fontWeight: theme.weight.strong,
                cursor: "pointer",
                ...choiceLook(tab === t.id),
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === "stamps" ? (
            <>
              {shipped.length === 0 ? <Empty>No stamp is called that.</Empty> : null}
              <ul style={gridStyle}>
                {shipped.map((s) => (
                  <li key={s.key}>
                    <Tile name={s.name} src={`/stamps/${s.key}.webp`} chosen={chosenKey === s.key} onPick={() => onPick(shippedChoice(s))} />
                  </li>
                ))}
              </ul>
              <RoomImages chosen={chosenAsset} onPick={onPick} onMeasured={props.onMeasured} paste={paste} upload={upload} />
            </>
          ) : (
            <StarterBrowser
              uses={STARTER_STAMP_USES}
              hint="Openly licensed props from the starter packs. Use sets what the next tap places."
              floor={STAMP_TILE_FLOOR}
              onUse={(found) => {
                const choice = starterChoice(found.work);
                if (choice) onPick(choice);
              }}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}

const TABS = [
  { id: "stamps", label: "Stamps" },
  { id: "starter", label: "Starter" },
] as const;

const STARTER_STAMP_USES = ["stamp"] as const;

/** A pasted image on its way to becoming a stamp. */
type PastedUpload = { busy: boolean; waiting: boolean; error: string | null };

const gridStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))",
  gap: theme.space(2),
} as const;

/** A stamp to pick: raised at rest, the chosen look once it is what the next tap places. */
function Tile(props: { name: string; src: string; chosen: boolean; onPick(): void }) {
  return (
    <button
      type="button"
      onClick={props.onPick}
      aria-pressed={props.chosen}
      title={props.name}
      style={{
        width: "100%",
        minHeight: theme.touch,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: theme.space(1),
        padding: theme.space(1),
        borderRadius: theme.radius.md,
        fontFamily: theme.font.body,
        cursor: "pointer",
        ...choiceLook(props.chosen),
      }}
    >
      <img
        src={props.src}
        alt=""
        loading="lazy"
        width={56}
        height={56}
        style={{ width: 56, height: 56, objectFit: "contain", display: "block", background: STAMP_TILE_FLOOR, borderRadius: theme.radius.sm }}
      />
      <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.tight, textAlign: "center", overflowWrap: "anywhere" }}>{props.name}</span>
    </button>
  );
}

/**
 * The room's token images, as the token image picker lists them: the
 * server's list, plus every image already on a token or character in view,
 * which still shows when the list cannot load. Each stamps one cell across
 * on its long side, keeping its shape, so its size is read from the list,
 * or from the image itself when the list does not have it.
 */
function RoomImages(props: { chosen: string | null; onPick(chosen: ChosenArt): void; onMeasured(chosen: ChosenArt): void; paste: PasteHandle; upload: PastedUpload }) {
  const roomId = useRoomView((s) => s.roomId);
  const assets = useAssets();
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const [listed, setListed] = useState<Map<string, { width: number; height: number }> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.listAssets(roomId).then(
      (r) => live && setListed(new Map(r.assets.filter((a) => a.kind === "token").map((a) => [a.id, { width: a.width, height: a.height }]))),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [roomId]);

  const ids = useMemo(() => {
    const seen = new Set<string>(listed?.keys() ?? []);
    for (const t of Object.values(tokens ?? {})) {
      const id = imageAssetId(t?.image);
      if (id !== undefined) seen.add(id);
    }
    for (const c of Object.values(characters ?? {})) {
      const id = imageAssetId(c?.defaultImage);
      if (id !== undefined) seen.add(id);
    }
    return [...seen];
  }, [listed, tokens, characters]);

  const pick = (assetId: string) => {
    const size = listed?.get(assetId);
    if (size) {
      props.onPick({ art: { assetId }, ...libraryFootprint(size.width, size.height), name: "Room image" });
      return;
    }
    // Not in the list: its shape comes from the picture, a moment later.
    props.onPick({ art: { assetId }, w: 1, h: 1, name: "Room image" });
    const img = new Image();
    img.src = assets.url(assetId, "thumb");
    const { onMeasured } = props;
    void img.decode().then(
      () => onMeasured({ art: { assetId }, ...libraryFootprint(img.naturalWidth, img.naturalHeight), name: "Room image" }),
      () => undefined,
    );
  };

  return (
    <section aria-label="This room's images" style={{ display: "grid", gap: theme.space(2), marginTop: theme.space(4) }}>
      <SectionLabel>This room's images</SectionLabel>
      <div style={{ display: "flex" }}>
        <PasteButton paste={props.paste} />
      </div>
      <PasteStatus paste={props.paste} />
      <Loading text={props.upload.waiting ? "Waiting for the server…" : "Uploading…"} active={props.upload.busy} />
      <ErrorText>{props.upload.error}</ErrorText>
      <Loading text="Loading this room's images…" active={listed === null && !failed} />
      {failed ? <Help>The room's library did not load. Images already on the map are below.</Help> : null}
      {ids.length === 0 && (listed !== null || failed) ? <Empty>No token images yet. Add one in the Library panel or on a token.</Empty> : null}
      <ul style={gridStyle}>
        {ids.map((id) => (
          <li key={id}>
            <Tile name="Room image" src={assets.url(id, "thumb")} chosen={props.chosen === id} onPick={() => pick(id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
