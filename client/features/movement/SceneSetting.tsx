import type { Scene } from "#shared/model.ts";
import { Switch } from "../../components/Switch.tsx";
import { useRoomActions } from "../../state/view.ts";

/**
 * The scene setting "Walls and ledges block players' moves"
 * (`blockMovement`, docs/design-v1-maps-vision.md 4.1): on for scenes made
 * from wave 4 on, off for older ones until the DM turns it on, so nothing
 * changes mid-campaign without the DM choosing it. The DM's own moves are
 * never blocked. A Switch named by the setting, since it applies at once
 * (docs/design-v1-visual.md 3.7). It leads the settings page's Walls and
 * movement group (docs/design-v1-map-discovery.md 8.4), which holds it.
 */
export function BlockMovementSetting(props: { scene: Scene }) {
  const actions = useRoomActions();
  const on = props.scene.blockMovement === true;
  return (
    <Switch
      label="Walls and ledges block players' moves"
      help={
        on
          ? "A player's drag stops at walls, closed doors and ledges. Raised ground is reached by its stairs. Your own moves are never stopped."
          : "Players' tokens move through walls and ledges. Your own moves are never stopped."
      }
      checked={on}
      onChange={(blockMovement) => actions.dispatch({ t: "scene.update", sceneId: props.scene.id, patch: { blockMovement } })}
    />
  );
}
