import { useMemo } from "react";
import { encode } from "uqr";
import { theme } from "../lib/theme.ts";

/**
 * A QR code drawn as SVG from uqr's module matrix. Building the path in
 * React keeps it within the strict CSP: no innerHTML, no data: URL. Dark
 * modules on a white quiet zone, because phone cameras read that far more
 * reliably than an inverted code on a dark theme.
 */
export function QrCode(props: { value: string; size?: number; label: string }) {
  const { path, modules } = useMemo(() => {
    const qr = encode(props.value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, modules: qr.size };
  }, [props.value]);
  const size = props.size ?? 200;
  return (
    <svg
      role="img"
      aria-label={props.label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      style={{ display: "block", borderRadius: theme.radius.sm }}
    >
      <rect width={modules} height={modules} fill={theme.color.white} />
      <path d={path} fill={theme.color.stage} />
    </svg>
  );
}
