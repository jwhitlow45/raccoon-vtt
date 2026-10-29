import { useLayoutEffect, useRef } from "react";
import { LoadFailed } from "../../components/LoadFailed.tsx";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { chromeZoom } from "../device/layout.ts";

/**
 * What the preview waits on, centered over the stage at the interface
 * size: "Loading what Ana sees…" after the shared delay, or that it could
 * not load, with Try again (docs/design-v1-design-pass.md 4.4). The wait
 * speaks through one status, mounted from the start with no words, so a
 * screen reader hears it as it comes. The failure is an alert beside that
 * status, never read inside it. The stage around them keeps the window's
 * own size. `zoom` is the interface size (useUiScale).
 *
 * Try again leaves as it is pressed, so the status takes focus from it:
 * it is mounted before the failure and after it, while the loading line
 * waits out its delay. Once the view lands the wait goes, and the dialog
 * takes focus back from the status, so focus stays inside the preview
 * rather than fall to the page.
 */
export function PreviewWait(props: { name: string; failed: boolean; zoom: number; onRetry(): void }) {
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = status.current;
    return () => {
      if (el && el === document.activeElement) el.closest("dialog")?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div data-preview-wait={props.failed ? "failed" : "loading"} style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: theme.space(4), fontFamily: theme.font.body }}>
      <div style={{ ...chromeZoom(props.zoom), display: "grid", justifyItems: "center", maxWidth: 420, minWidth: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
        <div ref={status} role="status" tabIndex={-1} style={{ minWidth: 0 }}>
          {props.failed ? null : <Loading live={false} text={`Loading what ${props.name} sees…`} />}
        </div>
        {props.failed ? (
          <LoadFailed centered retry={props.onRetry} focusTo={() => status.current}>
            {`Could not load what ${props.name} sees.`}
          </LoadFailed>
        ) : null}
      </div>
    </div>
  );
}
