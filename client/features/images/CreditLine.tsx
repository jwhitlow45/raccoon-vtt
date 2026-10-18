import type { CSSProperties } from "react";
import type { AssetCredit } from "#shared/protocol.ts";
import { theme } from "../../lib/theme.ts";
import { creditParts } from "./credit.ts";

/**
 * An openly licensed image's credit (docs/design-v1-dm-tools.md 3.13): the
 * work linked to its page, the license linked to its text, the credit line
 * a starter pick's author asks for, and what the app changed. Shown to
 * everyone who may see the image.
 */
export function CreditLine(props: {
  credit: AssetCredit;
  stored: { width: number; height: number };
  crop?: { crop: { cx: number; cy: number; zoom: number }; aspect: number };
  style?: CSSProperties;
}) {
  const parts = creditParts(props.credit, props.stored, props.crop);
  return (
    <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, overflowWrap: "anywhere", ...props.style }}>
      <a href={parts.workUrl} target="_blank" rel="noopener noreferrer" style={{ color: theme.color.accent }}>
        {parts.work}
      </a>
      ,{" "}
      {parts.licenseUrl ? (
        <a href={parts.licenseUrl} target="_blank" rel="noopener noreferrer" style={{ color: theme.color.accent }}>
          {parts.license}
        </a>
      ) : (
        parts.license
      )}
      . {parts.asked ? `${parts.asked} ` : null}
      {parts.changes}
    </p>
  );
}
