import { useState } from "react";
import type { ImageRef, Token } from "#shared/model.ts";
import type { TokenPatch } from "#shared/protocol.ts";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { DEFAULT_CROP, type Crop } from "../images/crop.ts";
import { CropEditor } from "../images/CropEditor.tsx";
import { ImagePreview } from "../images/IconDisk.tsx";
import { ImagePicker } from "../images/ImagePicker.tsx";
import { addPatch, canAdd, removePatch, swapPatch } from "./altImages.ts";
import { Note, SmallButton } from "./ui.tsx";
import { isAssetImage } from "#shared/imageRef.ts";

/**
 * A token's other images in its panel (features section 5): tap one to
 * wear it, add one with the same picker and crop as the token's image, or
 * remove one. Shown to whoever may change the token's image, the DM and
 * its owners, who are also the only ones who receive the list.
 */
export function AltImagesField(props: {
  token: Pick<Token, "image" | "altImages">;
  shape: "circle" | "square";
  aspect: number;
  ring: string;
  onPatch(patch: TokenPatch): void;
}) {
  const { token, shape, aspect } = props;
  const [step, setStep] = useState<{ kind: "pick" } | { kind: "crop"; assetId: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const alts = token.altImages ?? [];
  const send = (patch: TokenPatch | null) => {
    if (patch) props.onPatch(patch);
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ display: "grid", gap: theme.space(0.5) }}>
        <div style={{ fontSize: theme.font.body14 }}>Other images</div>
        <Help>
          {alts.length === 0
            ? "For Wild Shape or a disguise. Add one, then a tap here or on the map's token bar puts it on."
            : removing
              ? "Tap an image to remove it."
              : "Tap one to wear it. The image it wore takes its place."}
        </Help>
      </div>
      {alts.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          {alts.map((image, i) => (
            <ImageButton
              key={`${imageKey(image)}:${i}`}
              image={image}
              shape={shape}
              aspect={aspect}
              ring={removing ? theme.color.danger : props.ring}
              label={removing ? `Remove image ${i + 1}` : `Wear image ${i + 1}`}
              onClick={() => {
                if (removing) {
                  send(removePatch(token, i));
                  if (alts.length === 1) setRemoving(false);
                } else send(swapPatch(token, i));
              }}
            />
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        {canAdd(token) && !removing ? <SmallButton onClick={() => setStep({ kind: "pick" })}>Add another image</SmallButton> : null}
        {alts.length > 0 ? (
          // Armed while a tap on an image removes it, like a button waiting for its second tap.
          <SmallButton tone="danger" pressed={removing} armed={removing} onClick={() => setRemoving((r) => !r)}>
            {removing ? "Done" : "Remove one"}
          </SmallButton>
        ) : null}
      </div>
      {!canAdd(token) && !removing ? <Note>That is as many as a token keeps. Remove one to add another.</Note> : null}
      {step?.kind === "pick" ? (
        <ImagePicker
          onClose={() => setStep(null)}
          onPick={(image) => setStep({ kind: "crop", assetId: image.id })}
          onPickIcon={(icon) => {
            send(addPatch(token, icon));
            setStep(null);
          }}
        />
      ) : null}
      {step?.kind === "crop" ? (
        <CropEditor
          assetId={step.assetId}
          initial={DEFAULT_CROP}
          shape={shape}
          aspect={aspect}
          onCancel={() => setStep(null)}
          onSave={(crop: Crop) => {
            send(addPatch(token, { assetId: step.assetId, crop }));
            setStep(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The token action bar's row of other images: one tap wears one. The bar
 * opens on the map, so a Wild Shape at the table never needs the panel.
 */
export function AltImagesRow(props: { token: Pick<Token, "image" | "altImages" | "kind">; aspect: number; onPatch(patch: TokenPatch): void }) {
  const alts = props.token.altImages ?? [];
  if (alts.length === 0) return null;
  const shape = props.token.kind === "object" ? "square" : "circle";
  return (
    <div role="group" aria-label="Swap image" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(1) }}>
      <span style={{ flex: "1 0 auto", color: theme.color.textMuted }}>Swap image</span>
      {alts.map((image, i) => (
        <ImageButton
          key={`${imageKey(image)}:${i}`}
          image={image}
          shape={shape}
          aspect={props.aspect}
          ring={theme.color.border}
          size={36}
          label={`Wear image ${i + 1}`}
          onClick={() => {
            const patch = swapPatch(props.token, i);
            if (patch) props.onPatch(patch);
          }}
        />
      ))}
    </div>
  );
}

function ImageButton(props: { image: ImageRef; shape: "circle" | "square"; aspect: number; ring: string; label: string; size?: number; onClick(): void }) {
  const size = props.size ?? 52;
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      style={{
        display: "grid",
        placeItems: "center",
        minWidth: theme.touch,
        minHeight: theme.touch,
        padding: theme.space(1),
        border: "none",
        borderRadius: theme.radius.sm,
        background: "transparent",
        cursor: "pointer",
      }}
    >
      <ImagePreview image={props.image} shape={props.shape} aspect={props.aspect} width={size} ring={props.ring} />
    </button>
  );
}

/** A list key for an image: its asset, or its icon. */
function imageKey(image: ImageRef): string {
  return isAssetImage(image) ? image.assetId : image.icon;
}
