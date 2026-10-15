import { useEffect } from "react";
import type { LayerProps } from "../layers.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useAssets, useRoomActions, useRoomStore } from "../../state/view.ts";
import { makeThumbnail, thumbsSlot } from "./thumbs.ts";

/**
 * Draws nothing. It sits in the canvas because the canvas is mounted for
 * the whole time a DM is in the room, whatever panel is open, and it
 * watches the store for the DM leaving a scene this device changed, to
 * draw that scene's thumbnail from the view that still holds it (thumbs.ts).
 * A failure is silent: the scene stays marked and is drawn the next time.
 */
export function ThumbnailLayer(props: LayerProps) {
  const store = useRoomStore();
  const actions = useRoomActions();
  const assets = useAssets();
  const scope = useRoomScope();
  const dm = props.role === "dm";
  useEffect(() => {
    if (!dm) return;
    const thumbs = scope.get(thumbsSlot);
    const deps = { store, actions, assets };
    const check = () => {
      const left = thumbs.watch.observe(store.getState());
      if (left) makeThumbnail(thumbs, deps, left.sceneId, left.room).catch(() => {});
    };
    check();
    return store.subscribe(check);
  }, [dm, store, actions, assets, scope]);
  return null;
}
