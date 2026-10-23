import type { ReactNode } from "react";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useFrameLane } from "../../pages/fold.ts";
import type { PanePlacement } from "./labelEdit.ts";
import { labelPaneFrame } from "./labelPaneFrame.ts";

/*
 * A map pane host's frames (a label's, pin's, light's or trap's), while
 * the pane's code downloads and after it failed to. Each takes the box the
 * pane will take, and as a card keeps out of the fight's alerts as the pane
 * does, publishing its place (pages/fold.ts useFrameLane). Otherwise, where
 * the lane leaves no room beside it, the column's full cards would cover
 * the frame and its retry. `close` is the host's own close, which the
 * column's summary row runs, as it runs the pane's.
 */

export function PaneLoadingFrame(props: { text: string; place: PanePlacement; close(): void }) {
  useFrameLane(props.place, props.close);
  // Even padding: the pane's slight top padding is for its header, which a loading notice does not have.
  return <Loading text={props.text} style={{ ...labelPaneFrame(props.place), padding: theme.space(3) }} />;
}

export function PaneFailedFrame(props: { place: PanePlacement; close(): void; children: ReactNode }) {
  useFrameLane(props.place, props.close);
  return <div style={{ ...labelPaneFrame(props.place), padding: theme.space(3), color: theme.color.text }}>{props.children}</div>;
}
