import { theme } from "../../lib/theme.ts";
import { quietLazy } from "../../lib/quietLazy.tsx";
import { useRoomView } from "../../state/view.ts";

const Bar = quietLazy(() => import("./PartyBar.tsx").then((m) => m.PartyBar), ["dm"], "The party bar");

/**
 * The party bar's place from 900 px up (docs/design-v1-dm-tools.md 3.4): the
 * top of the side panel, above the tabs, for the DM only. Players do not
 * receive other characters' AC and Passive Perception (features 15), so they
 * have none. The bar loads after the room opens and never for a player.
 */
export function PartyDock() {
  const dm = useRoomView((s) => s.you?.role === "dm");
  const any = useRoomView((s) => Object.keys(s.view?.characters ?? {}).length > 0);
  if (!dm || !any) return null;
  return (
    <div style={{ padding: `${theme.space(1)}px ${theme.space(2)}px ${theme.space(2)}px`, borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
      <Bar dock />
    </div>
  );
}
