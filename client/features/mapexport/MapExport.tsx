import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { RoomState, Scene } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { useExpansionFocus } from "../../components/expansionFocus.ts";
import { buttonLook } from "../../components/looks.ts";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { api } from "../../lib/api.ts";
import { deviceMapVariant } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import { useAssets, useRoomStore, useRoomView } from "../../state/view.ts";
import { contentEmpty, exportContent, fromServer, hasBuildOn, playerViewContent, type ExportContent, type ExportView } from "./content.ts";
import { exportFileName } from "./fileName.ts";
import { ExportError, loadMapImage, renderMapPng } from "./render.ts";
import { prefersShare, shareFile } from "./save.ts";
import { DEFAULT_PX_PER_CELL, exportSize, exportWords, mapVariantFor, PX_PER_CELL_CHOICES } from "./size.ts";

/**
 * "Export as image" in the scene's settings: the map image and the build
 * as one PNG, for printing or for another VTT. It sits in the scene's
 * settings rather than the builder's option bar because it exports the
 * whole scene (an uploaded map with no build too), next to the scene's
 * size, grid and map image it depends on, and because the builder's bar
 * on a phone has no room for options.
 *
 * The image is made with the current build when "Make image" is tapped, and
 * a second tap saves it (save.ts says why). The player view of a scene
 * with fog on is the server's to give (docs/design-v1-map-discovery.md 4):
 * players hold the build only where they have seen it, as they last saw
 * it, and this device holds the whole build and no memory, so "Make image"
 * asks for it, busy until it comes. The grid is a checkbox, since
 * "Make image" reads it rather than it taking effect at once
 * (docs/design-v1-visual.md 3.7).
 */

type Made = { file: File; url: string; width: number; height: number; pxPerCell: number; share: boolean; notes: string[] };
type Status = { kind: "idle" } | { kind: "busy" } | { kind: "made"; made: Made } | { kind: "error"; message: string };

/** When the server cannot say what players get of the scene. */
export const PLAYER_VIEW_FAILED = "Could not get the players' view of this scene from the server. Check the connection, then try again.";
/** When the server says players hold nothing of a scene with no map image, so the image would be blank. */
export const PLAYERS_HOLD_NOTHING = "Players have seen none of this scene's build yet, so their view has nothing to export.";

const EMPTY_CHUNKS: RoomState["buildChunks"] = {};
const EMPTY_LABELS: RoomState["labels"] = {};
const EMPTY_STAMPS: RoomState["stamps"] = {};

export function MapExport(props: { scene: Scene }) {
  const { scene } = props;
  const store = useRoomStore();
  const assets = useAssets();
  const [open, setOpen] = useState(false);
  const [pxPerCell, setPxPerCell] = useState<number>(DEFAULT_PX_PER_CELL);
  const [grid, setGrid] = useState(false);
  const [view, setView] = useState<ExportView>("player");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [shareFailed, setShareFailed] = useState(false);
  /** The share sheet is open. A second tap would be refused while it is, and read as a failure. */
  const [sharing, setSharing] = useState(false);
  /** Bumped by every new run and by unmounting, so a slow run that was overtaken drops its result. */
  const runRef = useRef(0);
  const urlRef = useRef<string | null>(null);
  // The options open at their first field, and Close gives focus back to the button that opened them.
  const opener = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDivElement>(null);
  useExpansionFocus(open, { inside: options, opener });

  const chunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const labels = useRoomView((s) => s.view?.labels ?? EMPTY_LABELS);
  const stamps = useRoomView((s) => s.view?.stamps ?? EMPTY_STAMPS);
  const hasBuild = useMemo(() => hasBuildOn(scene.id, chunks, labels, stamps), [scene.id, chunks, labels, stamps]);
  const size = exportSize(scene.bounds, pxPerCell);
  const words = exportWords(sceneGrid(scene), scene.bounds, size);

  const forget = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setShareFailed(false);
  };

  // A made image no longer matches once the options or the scene's size or name change.
  useEffect(() => {
    runRef.current++;
    forget();
    setStatus({ kind: "idle" });
  }, [pxPerCell, grid, view, scene.id, scene.name, scene.bounds.w, scene.bounds.h, scene.gridShape]);

  useEffect(
    () => () => {
      runRef.current++;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const make = async () => {
    const run = ++runRef.current;
    forget();
    setStatus({ kind: "busy" });
    const { view: room, roomId } = store.getState();
    if (!room) {
      setStatus({ kind: "error", message: "The room is not loaded yet." });
      return;
    }
    let content: ExportContent;
    let drawn: Scene = scene;
    if (fromServer(view, scene)) {
      try {
        const players = await api.getPlayerView(roomId, scene.id);
        if (run !== runRef.current) return;
        content = playerViewContent(players, room, scene.id);
        if (!scene.map && contentEmpty(content)) {
          setStatus({ kind: "error", message: PLAYERS_HOLD_NOTHING });
          return;
        }
        // Drawn by the automatic walls rule of players' copy, "off" with fog on: their chunks carry the automatic walls they hold (docs/design-v1-map-discovery.md 5.2).
        drawn = { ...scene, autoWalls: players.scene.autoWalls ?? "off" };
      } catch {
        if (run !== runRef.current) return;
        setStatus({ kind: "error", message: PLAYER_VIEW_FAILED });
        return;
      }
    } else content = exportContent({ scene, buildChunks: room.buildChunks, labels: room.labels, fogTiles: room.fogTiles, exploredTiles: room.exploredTiles, stamps: room.stamps, view });
    const notes: string[] = [];
    if (content.secretDoors > 0) notes.push(`${count(content.secretDoors, "secret door")} drawn as ${content.secretDoors === 1 ? "a wall" : "walls"}, as players see them.`);
    if (content.hiddenLabels > 0) notes.push(`${count(content.hiddenLabels, "label")} under the fog left out.`);
    if (content.hiddenStamps > 0) notes.push(`${count(content.hiddenStamps, "stamp")} players cannot see left out.`);

    let map: HTMLImageElement | null = null;
    const sceneMap = scene.map;
    if (sceneMap) {
      const device = deviceMapVariant();
      const first = mapVariantFor(sceneMap, size.pxPerCell, device);
      const variants = device === "mobile" ? ["mobile" as const] : first === "full" ? (["full", "mobile"] as const) : (["mobile", "full"] as const);
      map = await loadMapImage(variants.map((v) => assets.url(sceneMap.assetId, v)));
      if (run !== runRef.current) return;
      if (!map) notes.push("The map image could not be loaded, so the image has only the build.");
    }

    try {
      const blob = await renderMapPng({ scene: drawn, size, content, grid, map, assets });
      if (run !== runRef.current) return;
      const file = new File([blob], exportFileName(sceneGrid(scene), scene.name, scene.bounds, size.pxPerCell, view), { type: "image/png" });
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setStatus({
        kind: "made",
        made: { file, url, width: size.width, height: size.height, pxPerCell: size.pxPerCell, share: prefersShare(file), notes },
      });
    } catch (err) {
      if (run !== runRef.current) return;
      setStatus({ kind: "error", message: err instanceof ExportError ? err.message : "The image could not be made. Try a smaller scale." });
    }
  };

  const share = async (file: File) => {
    if (sharing) return;
    setSharing(true);
    setShareFailed(false);
    try {
      if ((await shareFile(file)) === "failed") setShareFailed(true);
    } finally {
      setSharing(false);
    }
  };

  if (!open) {
    return (
      <Section label="Export as image">
        <Row>
          <Button ref={opener} size="sm" onClick={() => setOpen(true)}>
            Export as image
          </Button>
        </Row>
        <Help>A PNG of the map image and the build, to print or use in another VTT. No tokens, drawings or fog.</Help>
      </Section>
    );
  }

  const busy = status.kind === "busy";
  // The player view of a scene with fog on is judged by what the server gives, which this device's build does not show (MD4-ASTRA-4).
  const empty = !scene.map && !hasBuild && !fromServer(view, scene);
  const made = status.kind === "made" ? status.made : null;
  return (
    <Section label="Export as image">
      {/* No box of its own, so the row stays an item of the section. */}
      <div ref={options} style={{ display: "contents" }}>
        <SettingRow
          name={`Pixels per ${words.cell}`}
          help={size.pxPerCell < size.requested ? undefined : words.sizeLine}
          wide
        >
          <Segmented<number>
            label={`Pixels per ${words.cell}`}
            value={pxPerCell}
            options={PX_PER_CELL_CHOICES.map((v) => ({ value: v, label: `${v} px`, title: `${v} pixels per ${words.cell}` }))}
            onChange={setPxPerCell}
          />
        </SettingRow>
      </div>
      {size.pxPerCell < size.requested ? (
        <Note>
          Lowered to {size.pxPerCell} px per {words.cell}, so the image stays within 16.7 million pixels, the most an iPhone can draw. It will be {size.width} × {size.height} px.
        </Note>
      ) : null}

      <SettingRow
        name="Who it is for"
        help={
          view === "player"
            ? "What players can see: secret doors not yet found are walls, and lock marks, DM-only stamps, and labels and stamps under the fog are left out."
            : "Everything: secret doors, lock marks, every label and every stamp. Keep it to yourself."
        }
        wide
      >
        <Segmented<ExportView>
          label="Who it is for"
          value={view}
          options={[
            { value: "player", label: "Player view" },
            { value: "dm", label: "DM view" },
          ]}
          onChange={setView}
        />
      </SettingRow>

      <Checkbox label={words.gridSwitch} help="Leave the grid off for another VTT. It draws its own grid over the image." checked={grid} onChange={setGrid} />

      <Row>
        <Button size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Close
        </Button>
        <Button size="sm" variant={made ? "secondary" : "primary"} busy={busy} disabled={empty} onClick={() => void make()}>
          {busy ? "Making the image…" : "Make image"}
        </Button>
      </Row>
      {empty ? <Help>Nothing to export yet. Add a map image or build some rooms first.</Help> : null}
      {status.kind === "error" ? (
        <div role="alert">
          <Note>{status.message}</Note>
        </div>
      ) : null}
      {made ? (
        <>
          <Help>
            Made {made.file.name}: {made.width} × {made.height} px at {made.pxPerCell} px per {words.cell}, {formatBytes(made.file.size)}.
          </Help>
          {made.notes.map((n) => (
            <Help key={n}>{n}</Help>
          ))}
          <Row>
            {made.share ? (
              <Button size="sm" variant="primary" disabled={sharing} onClick={() => void share(made.file)}>
                Save or share
              </Button>
            ) : null}
            <a href={made.url} download={made.file.name} style={linkButton(!made.share)}>
              Download
            </a>
          </Row>
          {shareFailed ? <Note>Sharing did not work here. Use Download instead.</Note> : null}
        </>
      ) : null}
    </Section>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The download link, dressed as a small button so it is a 44 px target too: the primary when it is the one way to save. */
function linkButton(primary: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: theme.touch,
    minWidth: theme.touch,
    padding: `0 ${theme.space(3)}px`,
    borderRadius: theme.radius.md,
    fontFamily: theme.font.body,
    fontSize: theme.font.body14,
    fontWeight: theme.weight.strong,
    textDecoration: "none",
    whiteSpace: "nowrap",
    ...buttonLook(primary ? "primary" : "secondary"),
  };
}

function Row(props: { children: ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>{props.children}</div>;
}
