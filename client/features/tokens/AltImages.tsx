import { useId, useState, type ReactNode } from "react";
import type { ImageRef, Token } from "#shared/model.ts";
import type { TokenPatch } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Help } from "../../components/Panel.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { DEFAULT_CROP, type Crop } from "../images/crop.ts";
import { CropEditor } from "../images/CropEditor.tsx";
import { ImagePreview } from "../images/IconDisk.tsx";
import { PAIR_BUTTON } from "../images/ImageField.tsx";
import { ImagePicker } from "../images/ImagePicker.tsx";
import { addPatch, canAdd, removePatch, swapPatch } from "./altImages.ts";
import { Note, SmallButton } from "./ui.tsx";
import { isAssetImage } from "#shared/imageRef.ts";

/** What "Add another image" is for: its tooltip, its description and the line its picker shows. */
export const ALT_IMAGE_PURPOSE = "Another image this token can wear, for Wild Shape or a disguise. A tap on it here or in the token's bar puts it on.";

/**
 * A token's other images in its panel (features section 5), in the image
 * row's button column (docs/design-v1-token-panel.md 3.6): "Add another
 * image" beside "Change image" (`beside`), and under Crop and Remove the
 * images themselves, a tap on one to wear it, and "Remove one" (`below`).
 * Shown to whoever may change the token's image, the DM and its owners,
 * who are also the only ones who receive the list.
 *
 * What "Add another image" is for is said in three places, so nothing
 * depends on hover: its tooltip, its accessible description, and a
 * visible line in the picker it opens.
 */
export function useAltImages(props: {
  token: Pick<Token, "image" | "altImages">;
  shape: "circle" | "square";
  aspect: number;
  ring: string;
  onPatch(patch: TokenPatch): void;
}): { beside: ReactNode; below: ReactNode } {
  const { token, shape, aspect } = props;
  const [step, setStep] = useState<{ kind: "pick" } | { kind: "crop"; assetId: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const purposeId = useId();
  const alts = token.altImages ?? [];
  const send = (patch: TokenPatch | null) => {
    if (patch) props.onPatch(patch);
  };

  const beside = (
    <>
      {removing ? null : canAdd(token) ? (
        <Button size="sm" title={ALT_IMAGE_PURPOSE} aria-describedby={purposeId} onClick={() => setStep({ kind: "pick" })} style={PAIR_BUTTON}>
          Add another image
        </Button>
      ) : (
        <Note>That is as many as a token keeps. Remove one to add another.</Note>
      )}
      <span id={purposeId} style={VISUALLY_HIDDEN}>
        {ALT_IMAGE_PURPOSE}
      </span>
      {step?.kind === "pick" ? (
        <ImagePicker
          hint={ALT_IMAGE_PURPOSE}
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
    </>
  );

  const below =
    alts.length === 0 ? null : (
      <div role="group" aria-label="Other images" style={{ display: "grid", gap: theme.space(1) }}>
        <div style={{ fontSize: theme.font.body14 }}>Other images</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
          {alts.map((image, i) => (
            <ImageButton
              key={`${imageKey(image)}:${i}`}
              image={image}
              shape={shape}
              aspect={aspect}
              ring={removing ? theme.color.danger : props.ring}
              size={36}
              label={removing ? `Remove image ${i + 1}` : `Wear image ${i + 1}`}
              onClick={() => {
                if (removing) {
                  send(removePatch(token, i));
                  if (alts.length === 1) setRemoving(false);
                } else send(swapPatch(token, i));
              }}
            />
          ))}
          {/* Armed while a tap on an image removes it, like a button waiting for its second tap. */}
          <SmallButton tone="danger" pressed={removing} armed={removing} onClick={() => setRemoving((r) => !r)}>
            {removing ? "Done" : "Remove one"}
          </SmallButton>
        </div>
        <Help>{removing ? "Tap an image to remove it." : "Tap one to wear it."}</Help>
      </div>
    );

  return { beside, below };
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
