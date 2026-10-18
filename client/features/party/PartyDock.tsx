import { theme } from "../../lib/theme.ts";
import { quietLazy } from "../../lib/quietLazy.tsx";
import { useRoomView } from "../../state/view.ts";

const Bar = quietLazy(() => import("./PartyBar.tsx").then((m) => m.PartyBar), ["dm"], "The party bar");

/**
 * The party bar's place from 900 px up (docs/design-v1-dm-tools.md 3.4): the
 * top of the side panel, above the tabs, for the DM only. Players do not
 * receive other characters' AC and Passive Perception (features 15), so they
 * have none. The bar loads after the room opens and never for a player.
 * `short` is a short layout's side panel, where the bar starts folded
 * (PartyBar.tsx).
 */
export function PartyDock(props: { short?: boolean }) {
  const dm = useRoomView((s) => s.you?.role === "dm");
  const any = useRoomView((s) => Object.keys(s.view?.characters ?? {}).length > 0);
  if (!dm || !any) return null;
  return (
    // A header row's padding (components/HeaderRow.tsx): none above or below, so the folded bar is one 44 px line.
    <div style={{ padding: `0 ${theme.space(2)}px`, borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
      <Bar dock short={props.short} />
    </div>
  );
}
