import { useStore } from "zustand";
import { Switch } from "../../components/Switch.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { partySightSlot, visionOn } from "./sightMode.ts";

/**
 * The DM's "Party sight" switch, beside "View as a player"
 * (docs/design-v1-maps-vision.md section 4.3.1). The DM's own map stays
 * fully lit to work on, and this veils what the party cannot see, so the
 * DM can check a torch's reach without leaving it. It shows on a scene with
 * party vision, since only those have sight to show.
 */
export function PartySightToggle() {
  const slot = useScoped(partySightSlot);
  const on = useStore(slot, (s) => s.on);
  const shown = useRoomView((s) => {
    const scene = s.sceneId ? s.view?.scenes[s.sceneId] : undefined;
    return scene !== undefined && visionOn(scene);
  });
  if (!shown) return null;
  return (
    <Switch
      label="Party sight"
      help="Veils what the party cannot see on this scene. Your map stays lit underneath."
      checked={on}
      onChange={(next) => slot.setState({ on: next })}
    />
  );
}
