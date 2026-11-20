import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { BuildChunk, RoomState, Scene } from "#shared/model.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { useTokenImage } from "../../canvas/useImage.ts";
import { mapWorldRect } from "../../lib/scene.ts";
import { boardTheme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useAssets, useRoomView } from "../../state/view.ts";
import { buildPaths, drawBuild, type BoardPaths } from "../builder/draw.ts";
import type { TexturedTerrain } from "../builder/geometry.ts";
import { loadTexture } from "../builder/textures.ts";
import type { ControllerProps } from "../layers.ts";
import { traceGrid } from "../mapexport/render.ts";
import { MAP_BACKGROUND } from "../scenes/create.ts";
import { byFarFloor, farChunks, farTokensIn, holeOutline, holesOn, tokenUrl, windowLoadSlot, windowPxPerCell, windowSlot, type HoleOutline, type HoleSpec } from "./openingView.ts";

const NO_LINKS: RoomState["floorLinks"] = {};
const NO_SCENES: RoomState["scenes"] = {};
const NO_CHUNKS: RoomState["buildChunks"] = {};
const NO_TOKENS: RoomState["tokens"] = {};

/**
 * The windows' work, mounted once outside both drawing trees
 * (features/layers.ts CONTROLLERS): each hole's crop of the floor below and
 * the pictures of the creatures under the holes, kept in `windowSlot` for
 * OpeningWindow, which only reads them.
 */
export function OpeningCrops(props: ControllerProps): ReactNode {
  const links = useRoomView((s) => s.view?.floorLinks ?? NO_LINKS);
  const scenes = useRoomView((s) => s.view?.scenes ?? NO_SCENES);
  const tokens = useRoomView((s) => s.view?.tokens ?? NO_TOKENS);
  const assets = useAssets();
  const holes = useMemo(() => holesOn({ floorLinks: links, scenes }, props.scene.id), [links, scenes, props.scene.id]);
  const byFloor = useMemo(() => byFarFloor(holes), [holes]);
  const grid = useMemo(() => sceneGrid(props.scene), [props.scene.gridShape]);
  const urls = useMemo(() => {
    const out = new Set<string>();
    for (const { far, holes: over } of byFloor) for (const hole of over) for (const t of farTokensIn({ scenes: { [far.id]: far }, tokens }, far.id, hole.link.rect)) {
      const url = tokenUrl(assets, t);
      if (url) out.add(url);
    }
    return [...out].sort();
  }, [byFloor, tokens, assets]);
  return (
    <>
      {byFloor.map((f) => (
        <FarCrops key={f.far.id} far={f.far} holes={f.holes} grid={grid} role={props.role} />
      ))}
      {urls.map((url) => (
        <TokenPicture key={url} url={url} />
      ))}
    </>
  );
}

/** One creature picture, loaded through the board's shared token image cache and kept for the windows while a hole shows it. */
function TokenPicture(props: { url: string }): null {
  const image = useTokenImage(props.url);
  const store = useScoped(windowSlot);
  useEffect(() => {
    if (!image) return;
    store.setState((s) => ({ images: new Map(s.images).set(props.url, image) }));
    return () => store.setState((s) => {
      const images = new Map(s.images);
      images.delete(props.url);
      return { images };
    });
  }, [image, props.url, store]);
  return null;
}

/**
 * The map and build of one far floor under each hole over it, baked into
 * one crop a hole. Its phone-size image is fetched and decoded once for
 * every hole over that floor, cropped, and closed (D-261119-098), so a
 * whole decode is held only while the crops are drawn. A failed image
 * leaves the crops with the floor's background and build, as a missing map
 * leaves the board. While it loads, the scene's loading notice names the
 * far floor.
 */
function FarCrops(props: { far: Scene; holes: HoleSpec[]; grid: Grid; role: "dm" | "player" }): null {
  const { far, role } = props;
  const assets = useAssets();
  const load = useScoped(windowLoadSlot);
  const store = useScoped(windowSlot);
  const outlines = useMemo(() => props.holes.map((h) => ({ id: h.link.id, o: holeOutline(props.grid, h.link.rect) })), [props.holes, props.grid]);
  const allChunks = useRoomView((s) => s.view?.buildChunks ?? NO_CHUNKS);
  // The same list while the far floor's own chunks are, so a build on the floor shown draws no crop again.
  const chunks = useSameList(useMemo(() => farChunks({ buildChunks: allChunks }, far.id), [allChunks, far.id]));
  const map = far.map;
  const urls = map && mapWorldRect(map) ? [assets.url(map.assetId, "mobile"), assets.url(map.assetId, "full")] : [];
  const key = JSON.stringify([far.id, urls, far.background, far.bounds, far.grid, far.gridShape, far.autoWalls, outlines.map((x) => [x.id, x.o.x, x.o.y, x.o.w, x.o.h])]);
  useEffect(() => {
    let cancelled = false;
    let made: Map<string, HTMLCanvasElement> | null = null;
    const name = far.floor?.name ?? far.name;
    load.setState((s) => ({ loading: [...s.loading, name] }));
    const done = () => load.setState((s) => ({ loading: dropOne(s.loading, name) }));
    void (async () => {
      const paths = buildPaths(chunks as BuildChunk[], role, { autoWalls: far.autoWalls, bounds: far.bounds, gridShape: far.gridShape });
      const textures = await loadTextures(paths.floors.map(([t]) => t));
      const bitmap = await decodeFirst(urls);
      try {
        if (cancelled) return;
        made = new Map(outlines.map(({ id, o }) => [id, drawCrop(far, o, bitmap, paths, role, textures)]));
        const mine = made;
        store.setState((s) => ({ crops: new Map([...s.crops, ...mine]) }));
      } finally {
        bitmap?.close();
      }
    })().finally(done);
    return () => {
      cancelled = true;
      const mine = made;
      if (!mine) return;
      store.setState((s) => ({ crops: new Map([...s.crops].filter(([id, c]) => mine.get(id) !== c)) }));
      // iOS keeps a canvas's memory until it is resized, so a crop is let go once nothing draws it.
      requestAnimationFrame(() => mine.forEach((c) => void (c.width = 0)));
    };
    // `key` holds every input the crops read but the build, which `chunks` brings.
  }, [key, chunks, role]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** The list from the last render while it holds the same items in the same order. */
function useSameList<T>(list: readonly T[]): readonly T[] {
  const kept = useRef(list);
  const same = kept.current.length === list.length && kept.current.every((item, i) => item === list[i]);
  if (!same) kept.current = list;
  return kept.current;
}

function dropOne(list: readonly string[], name: string): string[] {
  const at = list.indexOf(name);
  return at < 0 ? [...list] : [...list.slice(0, at), ...list.slice(at + 1)];
}

/** The first of the image's copies that loads, decoded, or null where none does. */
async function decodeFirst(urls: readonly string[]): Promise<ImageBitmap | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) continue;
      return await createImageBitmap(await res.blob());
    } catch {
      // Try the next copy.
    }
  }
  return null;
}

async function loadTextures(terrains: readonly TexturedTerrain[]): Promise<Partial<Record<TexturedTerrain, HTMLImageElement>>> {
  const out: Partial<Record<TexturedTerrain, HTMLImageElement>> = {};
  await Promise.all(terrains.map((t) => loadTexture(t).then((img) => void (out[t] = img), () => {})));
  return out;
}

/** One hole's crop: the far floor's background, its map where it lies under the hole, its grid where shown, and its build, as its own board draws them. */
function drawCrop(far: Scene, o: HoleOutline, bitmap: ImageBitmap | null, paths: BoardPaths, role: "dm" | "player", textures: Partial<Record<TexturedTerrain, HTMLImageElement>>): HTMLCanvasElement {
  const px = windowPxPerCell({ w: Math.ceil(o.w), h: Math.ceil(o.h) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(o.w * px));
  canvas.height = Math.max(1, Math.round(o.h * px));
  const g = canvas.getContext("2d");
  if (!g) return canvas;
  g.scale(px, px);
  g.translate(-o.x, -o.y);
  g.fillStyle = far.background || MAP_BACKGROUND;
  g.fillRect(o.x, o.y, o.w, o.h);
  const rect = far.map ? mapWorldRect(far.map) : null;
  if (bitmap && rect) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    // Only the part under the hole is drawn, so the crop never holds more of the image than it shows.
    const kx = bitmap.width / rect.width;
    const ky = bitmap.height / rect.height;
    const x0 = Math.max(o.x, rect.x);
    const y0 = Math.max(o.y, rect.y);
    const x1 = Math.min(o.x + o.w, rect.x + rect.width);
    const y1 = Math.min(o.y + o.h, rect.y + rect.height);
    if (x1 > x0 && y1 > y0) g.drawImage(bitmap, (x0 - rect.x) * kx, (y0 - rect.y) * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0, y0, x1 - x0, y1 - y0);
  }
  if (far.grid?.show) {
    g.save();
    g.globalAlpha = Number.isFinite(far.grid.opacity) ? far.grid.opacity : 0.25;
    g.strokeStyle = far.grid.color || boardTheme.color.white;
    g.lineWidth = (far.grid.lineWidth > 0 ? far.grid.lineWidth : 1) / px;
    g.beginPath();
    traceGrid(far, px, g);
    g.stroke();
    g.restore();
  }
  drawBuild(g, paths, { role, scale: px, grid: { ...far.grid, show: false }, textures, labels: [] });
  return canvas;
}
