import { useMemo } from "react";
import type { Token } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { ownsToken } from "../tokens/access.ts";
import { doorActions, doorsInReach } from "./doors.ts";

/**
 * "Open door" or "Close door" on a player's token action bar
 * (docs/design-v1-maps-vision.md 4.1), while a door the player can see is
 * within reach of the token by the server's own rule, so a door never has
 * to be hit exactly on a phone. It acts on the nearest such door.
 */
export function DoorButton(props: { token: Token }) {
  const { token } = props;
  const actions = useRoomActions();
  const view = useRoomView((s) => s.view);
  const you = useRoomView((s) => s.you);
  const mine = you?.role === "player" && view !== null && ownsToken(view, you.memberId, token);
  // Reach reads only the build, the scene, the room's distances and the fog, so another op elsewhere in the room asks nothing again.
  const chunks = view?.buildChunks;
  const scene = view?.scenes[token.sceneId];
  const settings = view?.meta.settings;
  // A player's fog tiles are the DM's fog and the party's explored ground, merged by the server.
  const fogTiles = view?.fogTiles;
  const door = useMemo(
    () => (mine && view ? (doorsInReach(view, token, scene?.fogEnabled === false ? null : view.fogTiles)[0] ?? null) : null),
    [mine, chunks, scene, settings, fogTiles, token],
  );
  if (!door || !view) return null;
  // The token whose bar opened the door is the one that opens it (docs/design-v1-traps.md 5.3).
  const [choice] = doorActions(token.sceneId, door, "player", token.id);
  if (!choice) return null;
  return (
    <Button size="sm" onClick={() => actions.dispatch(choice.op)}>
      {choice.label} door
    </Button>
  );
}
