import type { CSSProperties, ReactNode } from "react";
import type { ImageRef } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { CroppedImage, ringStyle } from "./CropEditor.tsx";
import { glyphColor, glyphSide, iconUrl, useIconGlyph } from "./icons.ts";

/**
 * A shipped icon in HTML (docs/design-v1-dm-tools.md 3.12): a disk of its
 * color with the glyph on it, white or near-black by contrast. The glyph is
 * the icon file as a CSS mask over a box of the glyph's color, as
 * EffectIcon.tsx draws condition icons, and it shows once the file has
 * loaded. Until then, and for a key with no file or a file this device
 * cannot fetch while offline, the disk shows `fallback`: initials on a
 * token's portrait, the icon's name on a picker tile.
 */
export function IconDisk(props: {
  icon: string;
  color: string;
  width: number;
  height?: number;
  shape: "circle" | "square";
  ring?: string;
  fallback?: ReactNode;
  style?: CSSProperties;
}) {
  const height = props.height ?? props.width;
  const glyph = useIconGlyph(props.icon);
  const url = iconUrl(props.icon);
  const ink = glyphColor(props.color);
  const side = glyphSide(props.width, height, props.shape);
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        display: "inline-grid",
        placeItems: "center",
        flex: "none",
        width: props.width,
        height,
        borderRadius: props.shape === "circle" ? theme.radius.round : theme.radius.sm,
        overflow: "hidden",
        background: props.color,
        ...ringStyle(props.ring),
        color: ink,
        ...props.style,
      }}
    >
      {glyph.status === "ready" && url ? <Glyph url={url} side={side} color={ink} /> : props.fallback}
    </span>
  );
}

/** The icon's shape as a mask over a box of `color`. */
export function Glyph(props: { url: string; side: number; color: string }) {
  const mask = `url(${props.url})`;
  return (
    <span
      style={{
        display: "block",
        width: props.side,
        height: props.side,
        background: props.color,
        WebkitMaskImage: mask,
        maskImage: mask,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

/**
 * Any image a token, a portrait or a monster wears, in HTML: an upload
 * cropped into its shape, an icon on its disk, or the initials on a plain
 * disk when there is none. Every panel's preview goes through it, so an
 * icon never shows as a missing upload.
 */
export function ImagePreview(props: {
  image: ImageRef | null | undefined;
  shape: "circle" | "square";
  aspect: number;
  width: number;
  ring?: string;
  initials?: string;
}) {
  const { image, width, shape } = props;
  const height = width / props.aspect;
  const initials = (
    <span style={{ fontWeight: theme.weight.bold, fontSize: Math.max(9, Math.round(Math.min(width, height) * 0.32)), lineHeight: 1 }}>{props.initials ?? ""}</span>
  );
  if (image && "assetId" in image) {
    return <CroppedImage assetId={image.assetId} crop={image.crop} shape={shape} aspect={props.aspect} width={width} ring={props.ring} />;
  }
  if (image) return <IconDisk icon={image.icon} color={image.color} width={width} height={height} shape={shape} ring={props.ring} fallback={initials} />;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-grid",
        placeItems: "center",
        flex: "none",
        width,
        height,
        borderRadius: shape === "circle" ? theme.radius.round : theme.radius.sm,
        background: theme.color.surfaceRaised,
        ...ringStyle(props.ring),
        color: theme.color.text,
      }}
    >
      {initials}
    </span>
  );
}
