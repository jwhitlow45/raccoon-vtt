import { useMemo } from "react";
import type { RoomState, Scene } from "#shared/model.ts";
import { useIsoGround, useTreeShownView } from "./relief/context.ts";
import { FogView } from "./relief/fogView.ts";

const EMPTY_TILES: RoomState["fogTiles"] = {};
const NO_SCENE = { id: "", bounds: { w: 0, h: 0 } };

/**
 * This viewer's fog, sub-cell by sub-cell, for a part drawn above it: on
 * Top-down's overlay layer, or on Isometric's drag layer, which shows
 * through the fog as that overlay does (features/layers.ts). A player's
 * device holds the walls under the fog too, so whatever such a part draws
 * from them must show only on revealed sub-cells. In Isometric it is the
 * board's own (relief/IsoBoard.tsx), and in Top-down it is built the same
 * way from the tiles the fog image draws: the whole ground for the DM or
 * on a scene without fog (`FogView.all`). A panel with no scene yet reads
 * a fog for none.
 */
export function useViewerFog(layer: { scene: Pick<Scene, "id" | "bounds"> | undefined; role: "dm" | "player"; fog: boolean }): FogView {
  const iso = useIsoGround();
  const tiles = useTreeShownView((s) => s.view?.fogTiles ?? EMPTY_TILES);
  const own = layer.role === "player" && layer.fog ? tiles : null;
  const { id, bounds } = layer.scene ?? NO_SCENE;
  const { w, h } = bounds;
  const topDown = useMemo(() => new FogView(own, id, { w, h }), [own, id, w, h]);
  return iso ? iso.fog : topDown;
}
