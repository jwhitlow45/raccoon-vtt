import type { PanelProps } from "../panels.ts";
import { PartyBar } from "./PartyBar.tsx";

/**
 * The party bar as a phone's panel (docs/design-v1-dm-tools.md 3.4), since
 * the DM's phone top bar is full. A tap on a member closes the sheet first,
 * so the token it frames is not under it.
 */
export default function PartyPanel(props: PanelProps) {
  return <PartyBar onLeave={props.close} />;
}
