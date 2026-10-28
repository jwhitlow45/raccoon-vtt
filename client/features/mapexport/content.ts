import { CHUNK_CELLS, type BuildChunk, type FogTile, type Label, type PlayerChunk, type RoomState, type Scene, type Stamp } from "#shared/model.ts";
import { projectChunkForPlayer, stampCells } from "#shared/project.ts";
import { decodeTile, encodeTile, isRangeFullyFogged, labelCells } from "#shared/rules/fog.ts";
import { drawOrder } from "../builder/stamps/rules.ts";

/**
 * What an exported map holds for each view. Pure, so the rules are tested
 * against the server's projection without a canvas.
 *
 * - The player view holds exactly what a player's client receives for the
 *   scene (design 7.3 and 13.4), drawn without the fog. With fog on that is
 *   the server's to say (playerViewContent): players hold the build only
 *   where they have seen it (docs/design-v1-map-discovery.md 5.1). With fog
 *   off they receive the whole build, worked out here: an undiscovered
 *   secret door, on an edge or free, is the wall players see there, under
 *   the scene's automatic walls rule, and a locked door is closed. The
 *   fog-off rules below for labels and stamps under fog read the one
 *   players get, the DM's layer and the party's explored layer merged
 *   (playerFog below). Lock marks and the "S" on secret doors are DM-only
 *   marks, which the drawing leaves out for the player role.
 * - The DM view holds everything, as the DM's board shows it.
 */

export type ExportView = "player" | "dm";

export type ExportContent = {
  /** The role the build is drawn for. Only "dm" draws lock marks and secret door marks. */
  role: "dm" | "player";
  chunks: BuildChunk[];
  labels: Label[];
  /** Undiscovered secret doors, which the player view draws as the walls players see. */
  secretDoors: number;
  /** Labels the player view leaves out because they are under the fog. */
  hiddenLabels: number;
  /** The scene's stamps, bottom first. The player view keeps those a player receives (docs/design-v1-maps-vision.md 3.5). */
  stamps: Stamp[];
  /** Stamps the player view leaves out: DM only, or fully under the fog by the labels' rule. */
  hiddenStamps: number;
};

/** Whether an export's build comes from the server: the player view of a scene with fog on, which this device cannot work out (playerViewContent). */
const knownCache = new Map<string, Uint8Array>();

/** A chunk's `known` as its bytes. */
function knownBytes(known: string): Uint8Array {
  let bytes = knownCache.get(known);
  if (!bytes) {
    bytes = Uint8Array.from(atob(known), (c) => c.charCodeAt(0));
    if (knownCache.size > 1024) knownCache.clear();
    knownCache.set(known, bytes);
  }
  return bytes;
}

export function fromServer(view: ExportView, scene: Pick<Scene, "fogEnabled">): boolean {
  return view === "player" && scene.fogEnabled === true;
}

/**
 * The player view of a scene with fog on (docs/design-v1-map-discovery.md
 * 4): the server's shared projection (lib/api.ts PlayerSceneView), as
 * every player and display gets the scene, never-seen ground empty and
 * explored ground as the party last saw it, drawn as it comes. The DM's
 * copy says what was left out: its labels and stamps on the scene that the
 * projection holds none of, and its secret doors not yet found on chunks
 * the projection holds, which players see as walls.
 */
export function playerViewContent(players: { buildChunks: Readonly<Record<string, BuildChunk | undefined>>; labels: Readonly<Record<string, Label | undefined>>; stamps: Readonly<Record<string, Stamp | undefined>> }, dm: Pick<RoomState, "buildChunks" | "labels" | "stamps">, sceneId: string): ExportContent {
  const onScene = <T extends { sceneId: string }>(all: Readonly<Record<string, T | undefined>>) => Object.values(all).filter((v): v is T => !!v && v.sceneId === sceneId);
  const chunks = onScene(players.buildChunks);
  const labels = onScene(players.labels);
  const stamps = onScene(players.stamps).sort(drawOrder);
  const held = new Map(chunks.map((c) => [`${c.cx},${c.cy}`, c]));
  const known = (x: number, y: number) => {
    const chunk = held.get(`${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`) as PlayerChunk | undefined;
    if (!chunk?.known) return false;
    const k = (y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS);
    return ((knownBytes(chunk.known)[k >> 3]! >> (k & 7)) & 1) === 1;
  };
  const hidden = (f: { kind: string; secret?: boolean; discovered?: boolean }) => f.kind === "door" && f.secret === true && !f.discovered;
  let secretDoors = 0;
  for (const chunk of onScene(dm.buildChunks)) {
    // An edge door counts where players hold a cell beside it, as the wall they see. A free one goes as cut pieces, so it counts where they hold any of its chunk.
    for (const [key, edge] of Object.entries(chunk.edges)) {
      if (!hidden(edge)) continue;
      const [xs, ys, side] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (known(x, y) || (side === "n" ? known(x, y - 1) : known(x - 1, y))) secretDoors++;
    }
    if (held.has(`${chunk.cx},${chunk.cy}`)) for (const wall of chunk.walls ?? []) if (hidden(wall.f)) secretDoors++;
  }
  const shownLabels = new Set(labels.map((l) => l.id));
  const shownStamps = new Set(stamps.map((s) => s.id));
  return {
    role: "player",
    chunks,
    labels,
    secretDoors,
    hiddenLabels: onScene(dm.labels).filter((l) => !shownLabels.has(l.id)).length,
    stamps,
    hiddenStamps: onScene(dm.stamps).filter((s) => !shownStamps.has(s.id)).length,
  };
}

export function exportContent(
  input: Pick<RoomState, "buildChunks" | "labels" | "fogTiles" | "stamps"> &
    Partial<Pick<RoomState, "exploredTiles">> & { scene: Pick<Scene, "id" | "fogEnabled" | "autoWalls">; view: ExportView },
): ExportContent {
  const { scene, view } = input;
  const chunks = Object.values(input.buildChunks).filter((c): c is BuildChunk => !!c && c.sceneId === scene.id);
  const labels = Object.values(input.labels).filter((l): l is Label => !!l && l.sceneId === scene.id);
  const stamps = Object.values(input.stamps).filter((s): s is Stamp => !!s && s.sceneId === scene.id).sort(drawOrder);
  if (view === "dm") return { role: "dm", chunks, labels, secretDoors: 0, hiddenLabels: 0, stamps, hiddenStamps: 0 };

  // Free doors count as edge doors do: a hidden one is drawn as the wall players see (docs/design-v1-maps-vision.md 2.2).
  const hidden = (f: { kind: string; secret?: boolean; discovered?: boolean }) => f.kind === "door" && f.secret === true && !f.discovered;
  let secretDoors = 0;
  for (const chunk of chunks) {
    for (const edge of Object.values(chunk.edges)) if (hidden(edge)) secretDoors++;
    for (const wall of chunk.walls ?? []) if (hidden(wall.f)) secretDoors++;
  }
  const playerChunks = chunks.map((chunk) => projectChunkForPlayer(input.buildChunks, chunk, scene.autoWalls)).filter((c): c is BuildChunk => c !== null);

  // Fails closed like the client's gate (design 13.3): fog counts as on
  // unless the scene says off in so many words.
  const fogOn = scene.fogEnabled !== false;
  const fog = fogOn ? playerFog(input.fogTiles, input.exploredTiles, scene.id) : input.fogTiles;
  const shown = fogOn ? labels.filter((l) => !isRangeFullyFogged(fog, scene.id, labelCells(l))) : labels;
  const seen = stamps.filter((s) => s.visibility !== "dm" && !(fogOn && isRangeFullyFogged(fog, scene.id, stampCells(s))));
  return {
    role: "player",
    chunks: playerChunks,
    labels: shown,
    secretDoors,
    hiddenLabels: labels.length - shown.length,
    stamps: seen,
    hiddenStamps: stamps.length - seen.length,
  };
}

/**
 * The fog players get on a scene (docs/design-v1-maps-vision.md 4.3.3): the
 * DM's layer and the party's explored layer merged, a sub-cell revealed
 * where either reveals it, as the server's projection merges them. A DM's
 * view holds the two layers apart, so labels and stamps on ground only the
 * party explored, which players see, would otherwise be left out. A
 * player's view arrives merged, with no explored layer, and passes through.
 * An unreadable tile reveals nothing, as the fog gate reads it.
 */
export function playerFog(fogTiles: RoomState["fogTiles"], exploredTiles: RoomState["exploredTiles"] | undefined, sceneId: string): RoomState["fogTiles"] {
  let out: Record<string, FogTile> | null = null;
  for (const [key, explored] of Object.entries(exploredTiles ?? {})) {
    if (!explored || explored.sceneId !== sceneId) continue;
    out ??= { ...fogTiles };
    const dm = fogTiles[key];
    const a = dm ? decodeTile(dm.bits) : null;
    const b = decodeTile(explored.bits);
    if (!a || !b) {
      if (!a) out[key] = explored;
      continue;
    }
    const bits = new Uint8Array(a);
    for (let i = 0; i < bits.length; i++) bits[i] = bits[i]! | b[i]!;
    out[key] = { ...dm!, bits: encodeTile(bits) };
  }
  return out ?? fogTiles;
}

/**
 * Whether an export holds nothing of the build to draw: no floor, edge,
 * free wall, automatic wall, height, stair, difficult ground, label or
 * stamp. The player view's comes from the server, so the DM's own build
 * says nothing of it: players may remember ground the DM has since
 * cleared (MD4-ASTRA-4).
 */
export function contentEmpty(content: Pick<ExportContent, "chunks" | "labels" | "stamps">): boolean {
  return !content.chunks.some(chunkDraws) && content.labels.length === 0 && content.stamps.length === 0;
}

/**
 * Whether a chunk holds anything the drawing draws, the DM's or a player's
 * (whose `auto` marks automatic walls). Both emptiness tests read it, so
 * what counts cannot drift between them (LP23-OPUS-3).
 */
function chunkDraws(c: BuildChunk & { auto?: string }): boolean {
  return Object.keys(c.cells).length > 0 || Object.keys(c.edges).length > 0 || (c.walls?.length ?? 0) > 0 || c.auto !== undefined || c.heights !== undefined || c.up !== undefined || c.rough !== undefined;
}

/**
 * Whether a scene has anything of the build to export: floor, edges, free
 * walls, heights, stairs, difficult ground, labels or stamps, everything
 * the drawing draws. Heights and stairs draw on their own, over the
 * background (docs/design-v1-maps-vision.md 4.2), so a blank mat with only
 * those has something to export, and so does a mat with only stamps, which
 * is all a hex Battle mat can hold beside labels for now. Lights are not
 * drawn, so they do not count.
 */
export function hasBuildOn(sceneId: string, chunks: RoomState["buildChunks"], labels: RoomState["labels"], stamps: RoomState["stamps"]): boolean {
  const onScene = (item: { sceneId: string } | undefined) => item?.sceneId === sceneId;
  return Object.values(chunks).some((c) => c !== undefined && onScene(c) && chunkDraws(c)) || Object.values(labels).some(onScene) || Object.values(stamps).some(onScene);
}
