import { useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import type { ImageRef } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { displayName, footprint } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { builderSlot } from "../builder/store.ts";
import { stampSlot } from "../builder/stamps/store.ts";
import { usePreview } from "../dm/previewContext.ts";
import { DEFAULT_CROP } from "./crop.ts";
import { CropEditor } from "./CropEditor.tsx";
import { ImagePicker } from "./ImagePicker.tsx";
import { severalImages } from "./paste.ts";
import { pasteSlot, type RoomPasteOffer } from "./pasteRouter.ts";
import { roomPasteRows, roomPasteSlot, type RoomPasteRowId } from "./roomPaste.ts";

type Offer = { file: File; images: number };

/**
 * The DM's room-level offer (docs/design-v1-paste.md 4): a Ctrl+V that no
 * entry took, with an image in it, asks what the picture is for before
 * anything uploads. A player has none, and neither has a "view as a
 * player" preview.
 */
export function RoomPasteHost() {
  const scope = useRoomScope();
  const preview = usePreview() !== null;
  const role = useRoomView((s) => s.you?.role);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [picture, setPicture] = useState<{ tokenId: string; file: File } | null>(null);
  useEffect(() => {
    if (preview || role !== "dm") return;
    const registry = scope.get(pasteSlot);
    const take: RoomPasteOffer = (file, images) => setOffer({ file, images });
    registry.room = take;
    return () => {
      if (registry.room === take) registry.room = null;
    };
  }, [scope, preview, role]);
  return (
    <>
      {offer ? (
        <UsePastedImage
          offer={offer}
          onClose={() => setOffer(null)}
          onToken={(tokenId) => {
            setOffer(null);
            setPicture({ tokenId, file: offer.file });
          }}
        />
      ) : null}
      {picture ? <TokenPicture tokenId={picture.tokenId} file={picture.file} onDone={() => setPicture(null)} /> : null}
    </>
  );
}

/**
 * "Use the pasted image": the picture, from a local object URL freed when
 * the sheet closes, its name and size, and a row for each use. A row hands
 * the file to its entry and opens it, and the entry takes it as if the DM
 * had pasted there.
 */
function UsePastedImage(props: { offer: Offer; onClose(): void; onToken(tokenId: string): void }) {
  const { file, images } = props.offer;
  const scope = useRoomScope();
  const ui = useRoomUi();
  const handoffs = useScoped(roomPasteSlot);
  const busy = useStore(handoffs, (s) => s.busy);
  const builderMode = useStore(scope.get(builderSlot).store, (s) => s.mode);
  const sceneCount = useRoomView((s) => Object.keys(s.view?.scenes ?? {}).length);
  const onScene = useRoomView((s) => s.sceneId !== null && s.view?.scenes[s.sceneId] !== undefined);
  const tool = useRoomView((s) => s.local.tool);
  const selected = useRoomView((s) => (s.local.selectedIds.length === 1 && s.local.selectedId ? s.view?.tokens[s.local.selectedId] : undefined));
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const helpId = useId();
  useEffect(() => {
    const made = URL.createObjectURL(file);
    setUrl(made);
    setSize(null);
    setFailed(false);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  const rows = roomPasteRows({
    role: "dm",
    sceneCount,
    token: selected ? displayName(selected) : null,
    onScene,
    stampMode: tool === "build" && builderMode === "stamp",
    busy,
  });

  const choose = (id: RoomPasteRowId) => {
    if (id === "token") {
      if (selected) props.onToken(selected.id);
      return;
    }
    handoffs.setState({ handoff: { to: id, file } });
    props.onClose();
    if (id === "scene") ui.openPanel("scenes");
    else if (id === "handout") ui.openPanel("dm");
    else {
      // As choosing Stamp mode does in the builder's row, with the stamp picker open on it.
      ui.setTool("build");
      scope.get(builderSlot).store.setState({ mode: "stamp", poly: [], rect: null, run: [], note: null });
      scope.get(stampSlot).store.setState({ pickerOpen: true });
    }
  };

  const several = severalImages(images);
  return (
    <Dialog title="Use the pasted image" onClose={props.onClose} width="sm" phone="sheet" backClose>
      <div style={{ display: "grid", gap: theme.space(3) }}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(3), minWidth: 0 }}>
          {url && !failed ? (
            <img
              src={url}
              alt="The pasted image"
              onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              style={{ flex: "none", width: 96, height: 96, objectFit: "contain", borderRadius: theme.radius.sm, background: theme.color.bg }}
            />
          ) : null}
          <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
            <strong style={{ fontSize: theme.font.body14, overflowWrap: "anywhere" }}>{file.name}</strong>
            {size ? (
              <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
                {size.width} × {size.height} px
              </span>
            ) : failed ? (
              <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>This browser cannot show the picture. It can still upload.</span>
            ) : (
              <Loading text="Loading the picture…" />
            )}
          </div>
        </div>
        {several ? <Help>{several}</Help> : null}
        <div role="group" aria-label="Use it for" style={{ display: "grid", gap: theme.space(3) }}>
          {rows.map((row) => (
            <div key={row.id} style={{ display: "grid", gap: theme.space(1) }}>
              <Button block disabled={row.disabled} aria-describedby={`${helpId}-${row.id}`} onClick={() => choose(row.id)}>
                {row.label}
              </Button>
              <Help id={`${helpId}-${row.id}`}>{row.help}</Help>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The selected token's picture from a paste: the image picker uploads it
 * as Choose an image does, the crop editor opens in the token's shape, and
 * the token panel's own image patch goes out.
 */
function TokenPicture(props: { tokenId: string; file: File; onDone(): void }) {
  const token = useRoomView((s) => s.view?.tokens[props.tokenId]);
  const actions = useRoomActions();
  const [crop, setCrop] = useState<string | null>(null);
  const gone = token === undefined;
  const { onDone } = props;
  useEffect(() => {
    if (gone) onDone();
  }, [gone, onDone]);
  if (!token) return null;
  const fp = footprint(token);
  const shape = token.kind === "object" ? "square" : "circle";
  const set = (image: ImageRef) => {
    actions.dispatch({ t: "token.update", tokenId: token.id, patch: { image } });
    onDone();
  };
  if (crop) return <CropEditor assetId={crop} initial={DEFAULT_CROP} shape={shape} aspect={fp.w / fp.h} onCancel={onDone} onSave={(c) => set({ assetId: crop, crop: c })} />;
  return <ImagePicker initialFile={props.file} current={token.image} hint={`The picture for ${displayName(token)}.`} onClose={onDone} onPick={(image) => setCrop(image.id)} onPickIcon={set} />;
}
