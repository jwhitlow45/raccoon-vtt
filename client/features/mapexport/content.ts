import type { BuildChunk, FogTile, Label, RoomState, Scene, Stamp } from "#shared/model.ts";
import { projectChunkForPlayer, stampCells } from "#shared/project.ts";
import { decodeTile, encodeTile, isRangeFullyFogged, labelCells } from "#shared/rules/fog.ts";
import { drawOrder } from "../builder/stamps/rules.ts";

/**
 * What an exported map holds for each view. Pure, so the rules are tested
 * against the server's projection without a canvas.
 *
 * - The player view holds exactly what a player's client receives for the
 *   scene (design 7.3 and 13.4), drawn without the fog: an undiscovered
 *   secret door, on an edge or free, is the wall players see there, under
 *   the scene's automatic walls rule, a locked door is closed, and
 *   a label fully under enabled fog is left out, so a "Trap" in the dark
 *   stays secret. The fog is the one players get: the DM's layer and the
 *   party's explored layer merged (playerFog below). Lock marks and the "S" on
 *   secret doors are DM-only marks, which the drawing leaves out for the
 *   player role. Players already receive the whole map image and build, so
 *   nothing in this file reveals more than devtools would.
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
 * Whether a scene has anything of the build to export: floor, edges,
 * heights, stairs or labels. Heights and stairs draw on their own, over the
 * background (docs/design-v1-maps-vision.md 4.2), so a blank mat with only
 * those has something to export.
 */
export function hasBuildOn(sceneId: string, chunks: RoomState["buildChunks"], labels: RoomState["labels"]): boolean {
  const some = (c: BuildChunk | undefined) =>
    !!c && c.sceneId === sceneId && (Object.keys(c.cells).length > 0 || Object.keys(c.edges).length > 0 || c.heights !== undefined || c.up !== undefined);
  return Object.values(chunks).some(some) || Object.values(labels).some((l: Label | undefined) => l?.sceneId === sceneId);
}
