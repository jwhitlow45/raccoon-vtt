import { useEffect, useMemo, useState } from "react";
import type { Handout, Member } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { ErrorText, Field } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Row, RowDot, RowList } from "../../components/Row.tsx";
import { api, ApiError, type AssetRow } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomActions, useRoomView } from "../../state/view.ts";
import { FileButton, RadioGroup } from "../dm/controls.tsx";
import { honorsImageOrientation } from "../images/orientation.ts";
import { checkImageFile, prepareImageUpload } from "../images/upload.ts";
import { HANDOUT_MAX_BYTES, HANDOUT_MAX_SIDE } from "./downscale.ts";
import { audienceText, showHandoutOp, titleFromFileName } from "./handouts.ts";

/** A handout's thumbnail in its row: a picture, so larger than a row's 32 px disk, still inside a 56 px two-line row. */
const THUMB_PX = 44;

/**
 * The DM's handouts (features section 16): what is showing now, with a way
 * to close each one for everyone, and a form to show a new one from the
 * room's library or a fresh upload.
 */
export function HandoutsSection() {
  const handouts = useRoomView((s) => s.view?.handouts);
  const members = useRoomView((s) => s.view?.members);
  const actions = useRoomActions();
  const assets = useAssets();
  const showing = useMemo(
    () => Object.values(handouts ?? {}).filter((h): h is Handout => h !== undefined).sort((a, b) => (a.shownAt < b.shownAt ? 1 : -1)),
    [handouts],
  );
  return (
    <Section label="Handouts">
      {showing.length === 0 ? <Help>No handout is showing.</Help> : <Help>Showing now. Players can close their own copy.</Help>}
      {showing.length > 0 ? (
        <RowList label="Handouts showing">
          {showing.map((h) => (
            <Row
              key={h.id}
              leading={
                <img
                  src={assets.url(h.assetId, "thumb")}
                  alt=""
                  width={THUMB_PX}
                  height={THUMB_PX}
                  style={{ display: "block", objectFit: "cover", borderRadius: theme.radius.sm, background: theme.color.bg }}
                />
              }
              title={h.title}
              detail={`To ${audienceText(h.to, members ?? {})}`}
              trailing={
                <Button variant="danger" size="sm" onClick={() => actions.dispatch({ t: "handout.close", handoutId: h.id })}>
                  Close
                </Button>
              }
            />
          ))}
        </RowList>
      ) : null}
      <ShowHandout members={members ?? {}} />
    </Section>
  );
}

function ShowHandout(props: { members: Record<string, Member | undefined> }) {
  const roomId = useRoomView((s) => s.roomId);
  const actions = useRoomActions();
  const assets = useAssets();
  const [open, setOpen] = useState(false);
  const [asset, setAsset] = useState<AssetRow | null>(null);
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState<"all" | "some">("all");
  const [chosen, setChosen] = useState<string[]>([]);
  const [library, setLibrary] = useState<AssetRow[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Start the orientation check now, so it has finished by the first upload.
  useEffect(() => void honorsImageOrientation(), []);
  const players = Object.values(props.members)
    .filter((m): m is Member => m !== undefined && m.kind === "player")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)} style={{ justifySelf: "start" }}>
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

  const upload = async (file: File) => {
    setError(null);
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
      setAsset(row);
      setLibrary((list) => (list && !list.some((a) => a.id === row.id) ? [row, ...list] : list));
      if (!title.trim()) setTitle(titleFromFileName(file.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload failed.");
    } finally {
      setStatus(null);
    }
  };

  const show = () => {
    if (!asset) return setError("Pick an image first.");
    const result = showHandoutOp({ id: actions.newId(), assetId: asset.id, title, audience: audience === "all" ? "all" : chosen });
    if (!result.ok) return setError(result.error);
    actions.dispatch(result.op);
    setAsset(null);
    setTitle("");
    setChosen([]);
    setAudience("all");
    setOpen(false);
  };

  return (
    <div
      style={{
        display: "grid",
        gap: theme.space(3),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.bg,
      }}
    >
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <strong style={{ fontSize: theme.font.body14 }}>Image</strong>
        {asset ? (
          <div style={{ display: "flex", alignItems: "center", gap: theme.space(3) }}>
            <img src={assets.url(asset.id, "thumb")} alt="" width={72} height={72} style={{ objectFit: "cover", borderRadius: theme.radius.sm }} />
            <Button size="sm" onClick={() => setAsset(null)}>
              Change
            </Button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
              <Button size="sm" onClick={() => void loadLibrary()} disabled={status !== null}>
                From the library
              </Button>
              <FileButton label="Upload an image" accept="image/*" size="sm" disabled={status !== null} onFile={(file) => void upload(file)} />
            </div>
            {library ? (
              library.length === 0 ? (
                <Help>No handout images yet. Upload one.</Help>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: theme.space(2) }}>
                  {library.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      aria-label="Use this image"
                      onClick={() => setAsset(a)}
                      style={{ padding: 0, border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.sm, background: "transparent", cursor: "pointer", aspectRatio: "1" }}
                    >
                      <img src={assets.url(a.id, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: theme.radius.sm }} />
                    </button>
                  ))}
                </div>
              )
            ) : null}
          </>
        )}
        {status ? <Loading text={status} delay={0} /> : null}
      </div>
      <Field label="Title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="The old map" />
      <RadioGroup<"all" | "some">
        legend="Show to"
        value={audience}
        options={[
          { value: "all", label: "Everyone" },
          { value: "some", label: "Chosen players" },
        ]}
        onChange={setAudience}
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
                onChange={(on) => setChosen((list) => (on ? [...list, p.id] : list.filter((id) => id !== p.id)))}
              />
            ))}
          </div>
        )
      ) : null}
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
        <Button variant="primary" size="sm" onClick={show} disabled={!asset || status !== null}>
          Show
        </Button>
        <Button size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
