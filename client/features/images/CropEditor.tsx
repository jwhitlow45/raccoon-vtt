import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useAssets } from "../../state/view.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Help } from "../../components/Panel.tsx";
import { DEFAULT_CROP, cropTransform, normalizeCrop, panCrop, sliderToZoom, zoomCrop, zoomToSlider, type Crop, type ImageSize } from "./crop.ts";

/**
 * The token crop editor (design section 11.4): the image behind a circle
 * (a square for objects) in the token's own proportions. Drag to pan, pinch
 * or use the slider to zoom, and the mouse wheel zooms too. It saves only
 * `{cx, cy, zoom}`, which the canvas applies with the same math, so a
 * crop change is a tiny op and no image is made on the server.
 */

const sizeCache = new Map<string, ImageSize>();

/**
 * The image's natural size, read once per URL, or `failed` when it will not
 * load, so the crop editor can say so instead of loading forever. A failure
 * is not cached: the next open tries again.
 */
export function useImageLoad(url: string | null): { size: ImageSize | null; failed: boolean } {
  const [size, setSize] = useState<{ url: string; size: ImageSize | null } | null>(() => {
    const cached = url ? sizeCache.get(url) : undefined;
    return url && cached ? { url, size: cached } : null;
  });
  useEffect(() => {
    if (!url || sizeCache.has(url)) return;
    let live = true;
    const img = new Image();
    img.src = url;
    img.decode().then(
      () => {
        const s = { width: img.naturalWidth, height: img.naturalHeight };
        if (s.width > 0 && s.height > 0) sizeCache.set(url, s);
        if (live) setSize({ url, size: s });
      },
      () => {
        if (live) setSize({ url, size: null });
      },
    );
    return () => {
      live = false;
    };
  }, [url]);
  if (!url) return { size: null, failed: false };
  if (size?.url === url) return { size: size.size, failed: size.size === null };
  return { size: sizeCache.get(url) ?? null, failed: false };
}

export function useImageSize(url: string | null): ImageSize | null {
  return useImageLoad(url).size;
}

/**
 * A preview's ring, such as a token's disposition around its portrait. An
 * outline rather than a shadow: it follows the rounded edge the same way,
 * and a shadow is kept for things that float (theme.shadow).
 */
export function ringStyle(ring: string | undefined): CSSProperties {
  return ring ? { outline: `${theme.line.stripe}px solid ${ring}`, outlineOffset: 0 } : {};
}

/** The image cropped into its shape, for previews in panels. */
export function CroppedImage(props: { assetId: string; crop: Crop | undefined; shape: "circle" | "square"; aspect: number; width: number; ring?: string }) {
  const assets = useAssets();
  const url = assets.url(props.assetId, "full");
  const image = useImageSize(url);
  const height = props.width / props.aspect;
  const t = image ? cropTransform(image, props.crop ?? DEFAULT_CROP, props.aspect, props.width) : null;
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        flex: "none",
        width: props.width,
        height,
        borderRadius: props.shape === "circle" ? theme.radius.round : theme.radius.sm,
        overflow: "hidden",
        background: theme.color.surfaceRaised,
        ...ringStyle(props.ring),
      }}
    >
      {t ? (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{ position: "absolute", left: t.left, top: t.top, width: t.width, height: t.height, maxWidth: "none" }}
        />
      ) : null}
    </span>
  );
}

export function CropEditor(props: {
  assetId: string;
  initial: Crop | undefined;
  shape: "circle" | "square";
  /** Footprint width over height, 1 for every standard size. */
  aspect: number;
  onSave(crop: Crop): void;
  onCancel(): void;
}) {
  const assets = useAssets();
  const url = assets.url(props.assetId, "full");
  const { size: image, failed } = useImageLoad(url);
  const [crop, setCrop] = useState<Crop>(props.initial ?? DEFAULT_CROP);
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const boxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(260);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const aspect = props.aspect;

  // The preview fills the dialog's width up to 320 px.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(160, Math.min(320, Math.floor(entry.contentRect.width))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (image) setCrop((c) => normalizeCrop(image, c, aspect));
  }, [image, aspect]);

  const height = width / aspect;
  const t = image ? cropTransform(image, crop, aspect, width) : null;

  // The pointer in the preview's own pixels, the ones `width` is in. Its
  // rectangle is drawn pixels, which the dialog's zoom for the interface
  // size multiplies (features/device/layout.ts), so a pan would otherwise
  // move the crop 1.3 times the finger at 130%.
  const local = (e: ReactPointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const k = r.width > 0 && el.offsetWidth > 0 ? el.offsetWidth / r.width : 1;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    pinch.current = null;
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !image) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const pts = [...pointers.current.values()];
    if (pts.length === 1) {
      setCrop((c) => panCrop(image, c, aspect, p.x - prev.x, p.y - prev.y, width));
    } else if (pts.length === 2) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const focus = { u: (a.x + b.x) / 2 / width, v: (a.y + b.y) / 2 / height };
      const base = (pinch.current ??= { distance, zoom: cropRef.current.zoom });
      const zoom = (base.zoom * distance) / Math.max(1, base.distance);
      setCrop((c) => zoomCrop(image, c, aspect, zoom, focus));
    }
  };

  // React's wheel listener is passive, so the dialog would scroll under the
  // zoom. A native listener can claim the wheel.
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !image) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const focus = { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height };
      setCrop((c) => zoomCrop(image, c, aspect, c.zoom * Math.exp(-e.deltaY * 0.002), focus));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [image, aspect]);

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    pinch.current = null;
  };

  return (
    <Dialog
      title="Crop the image"
      onClose={props.onCancel}
      width="md"
      phone="fill"
      footer={
        <>
          <Button variant="quiet" disabled={!image} onClick={() => image && setCrop(normalizeCrop(image, DEFAULT_CROP, aspect))}>
            Reset
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={props.onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!image} onClick={() => image && props.onSave(normalizeCrop(image, crop, aspect))}>
            Save
          </Button>
        </>
      }
    >
      <div ref={boxRef} style={{ display: "grid", justifyItems: "center", gap: theme.space(4) }}>
        <div
          ref={previewRef}
          role="img"
          aria-label="Crop preview. Drag to move the image, pinch to zoom."
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          style={{
            position: "relative",
            width,
            height,
            borderRadius: props.shape === "circle" ? theme.radius.round : theme.radius.sm,
            overflow: "hidden",
            background: theme.color.bg,
            ...ringStyle(theme.color.accent),
            touchAction: "none",
            cursor: "grab",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        >
          {t ? (
            <img
              src={url}
              alt=""
              draggable={false}
              style={{ position: "absolute", left: t.left, top: t.top, width: t.width, height: t.height, maxWidth: "none", pointerEvents: "none" }}
            />
          ) : failed ? (
            <span role="alert" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: theme.space(6), textAlign: "center", color: theme.color.warning, fontSize: theme.font.body14 }}>
              The image did not load. Check your connection, then open the crop again.
            </span>
          ) : (
            <Loading text="Loading the image…" style={{ position: "absolute", inset: 0, justifyContent: "center" }} />
          )}
        </div>
        <label style={{ display: "grid", gap: theme.space(1), width: "100%", maxWidth: 320, fontSize: theme.font.body14 }}>
          Zoom {crop.zoom.toFixed(1)}x
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={zoomToSlider(crop.zoom)}
            disabled={!image}
            onChange={(e) => image && setCrop((c) => zoomCrop(image, c, aspect, sliderToZoom(Number(e.target.value))))}
            style={{ width: "100%", minHeight: theme.touch, accentColor: theme.color.accent }}
          />
        </label>
        <Help style={{ textAlign: "center" }}>Drag to move the image. Pinch or use the slider to zoom.</Help>
      </div>
    </Dialog>
  );
}
