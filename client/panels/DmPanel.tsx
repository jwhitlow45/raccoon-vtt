import { Empty } from "../components/Empty.tsx";
import { PlayerLinkSection } from "../features/dm/Access.tsx";
import { TableDisplaySection } from "../features/dm/TableDisplay.tsx";
import { ViewControls } from "../features/dm/ViewControls.tsx";
import { HandoutsSection } from "../features/handouts/HandoutsSection.tsx";
import type { PanelProps } from "../features/panels.ts";
import { useRoomView } from "../state/view.ts";

/**
 * The DM's table tools, used during play: the players' view, undo and
 * redo, handouts, and the player link for a latecomer. Every action here
 * opens something or acts on the side, so none is a primary button.
 */
export default function DmPanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  if (role !== "dm") return <Empty>Only the DM has these tools.</Empty>;
  return (
    <div style={{ display: "grid" }}>
      <ViewControls />
      <HandoutsSection />
      <PlayerLinkSection />
      <TableDisplaySection />
    </div>
  );
}
