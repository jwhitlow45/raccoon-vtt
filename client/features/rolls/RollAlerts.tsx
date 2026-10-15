import { quietLazy } from "../../lib/quietLazy.tsx";
import { useRoomView } from "../../state/view.ts";
import { PlayerRolls } from "./PlayerRolls.tsx";

/** The DM's sheet and live cards, loaded after the room opens and never for a player (lib/quietLazy.tsx). */
const DmDesk = quietLazy(() => import("./DmDesk.tsx").then((m) => m.DmDesk), ["dm"], "Roll requests");

/**
 * Request a roll in the fight alerts column (docs/design-v1-dm-tools.md
 * 3.3), which is always mounted, so a request reaches its players and the
 * DM's live cards outside a fight too. A player's part loads with the room,
 * since a failed load would leave them unable to answer.
 */
export function RollAlerts() {
  const role = useRoomView((s) => s.you?.role);
  if (role === "dm") return <DmDesk />;
  if (role === "player") return <PlayerRolls />;
  return null;
}
