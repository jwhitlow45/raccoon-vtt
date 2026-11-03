import { Empty } from "../components/Empty.tsx";
import { PlayerLinkSection } from "../features/dm/Access.tsx";
import { JoinRequestsSection } from "../features/dm/JoinRequests.tsx";
import { TableDisplaySection } from "../features/dm/TableDisplay.tsx";
import { ViewControls } from "../features/dm/ViewControls.tsx";
import { HandoutsSection } from "../features/handouts/HandoutsSection.tsx";
import type { PanelProps } from "../features/panels.ts";
import { useRoomView } from "../state/view.ts";

/**
 * The DM's table tools, used during play, most used first
 * (docs/design/design-v1-layout-hierarchy.md M4): join requests while any
 * waits (design-v1-join-requests.md 2.3), handouts, the players' screens,
 * the checks on what players see, then the player link for a latecomer and
 * the table display, set up once. Every action here opens something or
 * acts on the side, so none is a primary button.
 */
export default function DmPanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  if (role !== "dm") return <Empty>Only the DM has these tools.</Empty>;
  return (
    <div style={{ display: "grid" }}>
      {/* First while a request waits, since it is the one thing here a person is waiting on. */}
      <JoinRequestsSection />
      <HandoutsSection />
      <ViewControls />
      <PlayerLinkSection />
      <TableDisplaySection />
    </div>
  );
}
