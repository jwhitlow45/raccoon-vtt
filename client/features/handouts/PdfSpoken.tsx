import { useCallback, useMemo, useState } from "react";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import type { PdfBuild } from "./download.ts";

/**
 * What a screen reader hears of a handout's PDF download: "Preparing the
 * PDF." as it starts and "The PDF is ready." once it is built, never each
 * page, as the upload's own line says only its start, its stops and its end
 * (docs/design-v1-pdf-handouts.md 4.1.4 and 6). The progress line beside it
 * is not live.
 */
export const PREPARING_PDF = "Preparing the PDF.";
export const PDF_READY = "The PDF is ready.";

/** The words said last, and how to say the next. Each saying is a new child, so the same words twice are heard twice. */
export function useSpoken(): { said: { text: string; n: number }; say(text: string): void } {
  const [said, setSaid] = useState({ text: "", n: 0 });
  const say = useCallback((text: string) => setSaid((s) => ({ text, n: s.n + 1 })), []);
  return useMemo(() => ({ said, say }), [said, say]);
}

/** The polite status line. A start whose build has ended without being ready, by Cancel or by moving on, is no longer said. */
export function PdfSpoken(props: { said: { text: string; n: number }; build: PdfBuild | null }) {
  const text = props.said.text === PREPARING_PDF && props.build?.t !== "building" ? "" : props.said.text;
  return (
    <div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
      <span key={props.said.n}>{text}</span>
    </div>
  );
}
