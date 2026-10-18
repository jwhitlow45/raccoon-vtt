import { useState, type CSSProperties, type ReactNode } from "react";
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
 * The pair beside a compact preview, "Change image" and "Add another
 * image", with 8 px sides instead of 12, so the preview, its 8 px gap and
 * the pair fit the side panel's 327 px on one line at 14 px text.
 */
export const PAIR_BUTTON: CSSProperties = { paddingLeft: theme.space(2), paddingRight: theme.space(2) };

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
  /** The preview's width. The token panel's row is compact (docs/design-v1-token-panel.md 3.6). */
  previewSize?: number;
  /**
   * More in the button column: `beside` pairs with "Change image" on its
   * line, and `below` follows Crop and Remove, such as a token's other
   * images. The column then sits beside the preview wherever the preview,
   * the gap and the pair fit on one line, and under it at full width
   * elsewhere, where the pair shares a line if the width holds it.
   */
  extra?: { beside?: ReactNode; below?: ReactNode };
}) {
  const [step, setStep] = useState<{ kind: "pick" } | { kind: "crop"; assetId: string; initial: Crop } | null>(null);
  // A shipped icon has no crop (docs/design-v1-dm-tools.md 3.12).
  const value = props.value && isAssetImage(props.value) ? props.value : undefined;
  const set = props.value !== undefined;
  const roomId = useRoomView((s) => s.roomId);
  const row = useAssetRow(roomId, value?.assetId);

  const change = (
    // Words alone, so the pair still fits beside the picture in the side panel and on a 390 px phone (docs/design-v1-icons.md 4.1).
    <Button size="sm" onClick={() => setStep({ kind: "pick" })} style={props.extra ? PAIR_BUTTON : undefined}>
      {set ? "Change image" : "Add image"}
    </Button>
  );
  const fix = (
    <>
      {value ? (
        <Button size="sm" icon="crop" onClick={() => setStep({ kind: "crop", assetId: value.assetId, initial: value.crop })}>
          Crop
        </Button>
      ) : null}
      {set ? (
        <Button size="sm" variant="danger" icon="delete" onClick={() => props.onChange(null)}>
          Remove
        </Button>
      ) : null}
    </>
  );
  const buttons = { display: "flex", flexWrap: "wrap", gap: theme.space(1) } as const;
  const preview = <ImagePreview image={props.value} shape={props.shape} aspect={props.aspect} width={props.previewSize ?? 64} ring={props.ring} initials={props.initials} />;

  return (
    // One column no wider than its box, so the button column, sized to the pair, can still shrink and wrap.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <div style={{ display: "flex", alignItems: props.extra ? "flex-start" : "center", flexWrap: props.extra ? "wrap" : undefined, gap: props.extra ? theme.space(2) : theme.space(3) }}>
        {preview}
        {props.canEdit && props.extra ? (
          /*
           * The column's width is the pair's: rows that may run longer (the
           * other images) take no width of their own (`width: 0` with a full
           * minimum), so the column wraps under the preview exactly where the
           * preview, the gap and the pair no longer fit on one line.
           */
          <div style={{ flex: "1 1 auto", width: "max-content", minWidth: 0, display: "grid", gap: theme.space(1) }}>
            <div data-image-pair="" style={buttons}>
              {change}
              {props.extra.beside}
            </div>
            {value || set ? <div style={{ ...buttons, width: 0, minWidth: "100%" }}>{fix}</div> : null}
            {props.extra.below ? <div style={{ width: 0, minWidth: "100%" }}>{props.extra.below}</div> : null}
          </div>
        ) : props.canEdit ? (
          <div style={buttons}>
            {change}
            {fix}
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
