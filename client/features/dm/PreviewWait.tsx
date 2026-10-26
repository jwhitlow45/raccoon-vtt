import { Spinner, useDelayed } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { chromeZoom } from "../device/layout.ts";

/**
 * What the preview waits on, centered over the stage at the interface
 * size: "Loading what Ana sees…" after the shared delay, or that it could
 * not load. Both speak through one status, mounted from the start with no
 * words, so a screen reader hears each as it comes. The stage around it
 * keeps the window's own size. `zoom` is the interface size (useUiScale).
 */
export function PreviewWait(props: { name: string; failed: boolean; zoom: number }) {
  const { zoom } = props;
  const slow = useDelayed(!props.failed);
  return (
    <div data-preview-wait={props.failed ? "failed" : "loading"} style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", padding: theme.space(4), fontFamily: theme.font.body }}>
      <div
        role="status"
        style={{
          ...chromeZoom(zoom),
          maxWidth: 420,
          minWidth: 0,
          textAlign: "center",
          fontSize: theme.font.body14,
          lineHeight: theme.leading.body,
          color: props.failed ? theme.color.text : theme.color.textMuted,
          overflowWrap: "anywhere",
        }}
      >
        {props.failed ? (
          `Could not load what ${props.name} sees. Close and try again.`
        ) : slow ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2) }}>
            <Spinner size={18} />
            <span style={{ minWidth: 0 }}>{`Loading what ${props.name} sees…`}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
