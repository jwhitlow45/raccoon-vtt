import type { RoomState } from "#shared/model.ts";
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
  // Only the DM's view holds every character's owners, so a player's never asks.
  const party = useRoomView((s) => s.you?.role === "dm" && hasParty(s.view));
  if (!dm || !party) return null;
  return (
    // A header row's padding (components/HeaderRow.tsx): none above or below, so the folded bar is one 44 px line.
    <div style={{ padding: `0 ${theme.space(2)}px`, borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
      <Bar dock short={props.short} />
    </div>
  );
}

/**
 * Whether a player owns a character, so the bar has a party to show
 * (rolls/logic.ts partyCharacters). Counting every character left an empty
 * strip with a rule for a room whose characters no player owns yet, since
 * the bar draws nothing then. A player's copy of another player's character
 * has no owners (shared/project.ts), which counts as none.
 */
export function hasParty(view: Pick<RoomState, "members" | "characters"> | null | undefined): boolean {
  if (!view) return false;
  return Object.values(view.characters).some((c) => c !== undefined && (c.ownerIds ?? []).some((id) => view.members[id]?.kind === "player"));
}
