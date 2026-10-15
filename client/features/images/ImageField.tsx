import { useState } from "react";
import { isAssetImage } from "#shared/imageRef.ts";
import type { ImageRef } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { DEFAULT_CROP, type Crop } from "./crop.ts";
import { CreditLine } from "./CreditLine.tsx";
import { CropEditor } from "./CropEditor.tsx";
import { ImagePreview } from "./IconDisk.tsx";
import { ImagePicker } from "./ImagePicker.tsx";
import { useAssetRow } from "./library.ts";

export type { ImageRef };

/**
 * A token's or character's image: a preview in its shape, and buttons to
 * choose a new one (then crop it), re-crop the current one, or remove it.
 * Shared by the token panel and the character cards. An openly licensed
 * image from Openverse shows its credit under it, with "Cropped." when the
 * crop shows less than the whole image (docs/design-v1-dm-tools.md 3.13).
 */
export function ImageField(props: {
  value: ImageRef | undefined;
  onChange(next: ImageRef | null): void;
  shape: "circle" | "square";
  aspect: number;
  canEdit: boolean;
  ring?: string;
  /** Shown when there is no image. */
  initials?: string;
}) {
  const [step, setStep] = useState<{ kind: "pick" } | { kind: "crop"; assetId: string; initial: Crop } | null>(null);
  // A shipped icon has no crop (docs/design-v1-dm-tools.md 3.12).
  const value = props.value && isAssetImage(props.value) ? props.value : undefined;
  const set = props.value !== undefined;
  const roomId = useRoomView((s) => s.roomId);
  const row = useAssetRow(roomId, value?.assetId);

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(3) }}>
        <ImagePreview image={props.value} shape={props.shape} aspect={props.aspect} width={64} ring={props.ring} initials={props.initials} />
        {props.canEdit ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
            <Button size="sm" onClick={() => setStep({ kind: "pick" })}>
              {set ? "Change image" : "Add image"}
            </Button>
            {value ? (
              <Button size="sm" onClick={() => setStep({ kind: "crop", assetId: value.assetId, initial: value.crop })}>
                Crop
              </Button>
            ) : null}
            {set ? (
              <Button size="sm" variant="danger" onClick={() => props.onChange(null)}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
        {step?.kind === "pick" ? (
          <ImagePicker
            current={props.value}
            onClose={() => setStep(null)}
            onPick={(image) => setStep({ kind: "crop", assetId: image.id, initial: DEFAULT_CROP })}
            onPickIcon={(icon) => {
              props.onChange(icon);
              setStep(null);
            }}
          />
        ) : null}
        {step?.kind === "crop" ? (
          <CropEditor
            assetId={step.assetId}
            initial={step.initial}
            shape={props.shape}
            aspect={props.aspect}
            onCancel={() => setStep(null)}
            onSave={(crop) => {
              props.onChange({ assetId: step.assetId, crop });
              setStep(null);
            }}
          />
        ) : null}
      </div>
      {value && row?.credit ? <CreditLine credit={row.credit} stored={row} crop={{ crop: value.crop, aspect: props.aspect }} /> : null}
    </div>
  );
}
