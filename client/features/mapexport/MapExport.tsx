import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { RoomState, Scene } from "#shared/model.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { useExpansionFocus } from "../../components/expansionFocus.ts";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { useAssets, useRoomStore, useRoomView } from "../../state/view.ts";
import { fromServer, hasBuildOn, type ExportContent, type ExportView } from "./content.ts";
import { everyFloorFits, everyFloorHelp, everyFloorZip, floorEntries, floorName, makingText, reachedText, sharedBounds, tooMuchText, useExportFloors, type FloorsChoice } from "./everyFloor.ts";
import { everyFloorFileName, exportFileName } from "./fileName.ts";
import { MadeFile, Overtaken, Row, type Made } from "./made.tsx";
import { floorPicture, type Picture } from "./picture.ts";
import { ExportError } from "./render.ts";
import { prefersShare } from "./save.ts";
import { DEFAULT_PX_PER_CELL, exportSize, exportWords, PX_PER_CELL_CHOICES } from "./size.ts";
import { UvttExport } from "./UvttExport.tsx";
import { plural } from "./vttNotes.ts";

/**
 * Export, last in the scene's settings, never folded: the map image and the build
 * as one PNG, for printing or for another VTT. It sits in the scene's
 * settings rather than the builder's option bar because it exports the
 * whole scene (an uploaded map with no build too), next to the scene's
 * size, grid and map image it depends on, and because the builder's bar
 * on a phone has no room for options.
 *
 * The image is made with the current build when "Make image" is tapped, and
 * a second tap saves it (save.ts says why). The player view of a scene
 * with fog on is the server's to give (docs/design/design-v1-map-discovery.md 4):
 * players hold the build only where they have seen it, as they last saw
 * it, and this device holds the whole build and no memory, so "Make image"
 * asks for it, busy until it comes. The grid is a checkbox, since
 * "Make image" reads it rather than it taking effect at once
 * (docs/design/design-v1-visual.md 3.7).
 *
 * On a scene with floors, Floors picks This floor or Every floor
 * (docs/design/design-v1-floors.md phase 4, 9.3): Every floor makes each
 * floor's picture the same way, one after another, and saves them as one
 * zip (everyFloor.ts), the button naming the floor it is on.
 *
 * Export as VTT file sits beside it (UvttExport.tsx,
 * docs/design/design-v1-uvtt-export.md 3). Opening either shows its options in
 * place of the two buttons, so only one is open at a time.
 */

/** The section's label, short so it never echoes its button, "Export as image" (docs/design/design-v1-scenes-reorg.md 6). */
const EXPORT_LABEL = "Export";

type Status = { kind: "idle" } | { kind: "busy"; making?: string } | { kind: "made"; made: Made } | { kind: "error"; message: string };

const EMPTY_CHUNKS: RoomState["buildChunks"] = {};
const EMPTY_LABELS: RoomState["labels"] = {};
const EMPTY_STAMPS: RoomState["stamps"] = {};

export function MapExport(props: { scene: Scene }) {
  const [open, setOpen] = useState<"image" | "vtt" | null>(null);
  // The options open at their first field, and Close gives focus back to the button that opened them.
  const imageButton = useRef<HTMLButtonElement>(null);
  const vttButton = useRef<HTMLButtonElement>(null);
  const openedBy = useRef<"image" | "vtt">("image");
  const opener = useMemo<RefObject<HTMLButtonElement | null>>(
    () => ({
      get current() {
        return openedBy.current === "vtt" ? vttButton.current : imageButton.current;
      },
    }),
    [],
  );
  const inside = useRef<HTMLDivElement>(null);
  useExpansionFocus(open !== null, { inside, opener });
  const show = (which: "image" | "vtt") => {
    openedBy.current = which;
    setOpen(which);
  };

  if (open === "image") return <ImageExport scene={props.scene} inside={inside} onClose={() => setOpen(null)} />;
  if (open === "vtt") return <UvttExport scene={props.scene} inside={inside} onClose={() => setOpen(null)} />;
  return (
    <Section label={EXPORT_LABEL}>
      <Row>
        <Button ref={imageButton} size="sm" search="scenes.export" onClick={() => show("image")}>
          Export as image
        </Button>
        <Button ref={vttButton} size="sm" search="scenes.export-vtt" onClick={() => show("vtt")}>
          Export as VTT file
        </Button>
      </Row>
      <Help>A PNG of the map image and the build, to print or use in another VTT. No tokens, drawings or fog.</Help>
      <Help>A Universal VTT file of the map with its walls, doors and lights, for another VTT or another room here.</Help>
    </Section>
  );
}

/** Export as image's options, open in place of the two buttons. */
function ImageExport(props: { scene: Scene; inside: RefObject<HTMLDivElement | null>; onClose(): void }) {
  const { scene } = props;
  const store = useRoomStore();
  const assets = useAssets();
  const [pxPerCell, setPxPerCell] = useState<number>(DEFAULT_PX_PER_CELL);
  const [grid, setGrid] = useState(false);
  const [view, setView] = useState<ExportView>("player");
  const [floorsChoice, setFloorsChoice] = useState<FloorsChoice>("this");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  /** Bumped by every new run and by unmounting, so a slow run that was overtaken drops its result. */
  const runRef = useRef(0);
  const urlRef = useRef<string | null>(null);

  const chunks = useRoomView((s) => s.floorView?.buildChunks ?? EMPTY_CHUNKS);
  const labels = useRoomView((s) => s.floorView?.labels ?? EMPTY_LABELS);
  const stamps = useRoomView((s) => s.floorView?.stamps ?? EMPTY_STAMPS);
  const hasBuild = useMemo(() => hasBuildOn(scene.id, chunks, labels, stamps), [scene.id, chunks, labels, stamps]);
  const size = exportSize(scene.bounds, pxPerCell);
  const words = exportWords(sceneGrid(scene), scene.bounds, size);
  const every = useExportFloors(scene, view, true);
  /** The floors Every floor makes, or null for this floor's picture alone. */
  const everyFloor = every && floorsChoice === "every" ? every : null;
  const fits = everyFloor ? everyFloorFits(everyFloor.floors, size.requested) : true;

  const forget = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  // A made image no longer matches once the options or the scene's size or name change.
  useEffect(() => {
    runRef.current++;
    forget();
    setStatus({ kind: "idle" });
  }, [pxPerCell, grid, view, scene.id, scene.name, scene.bounds.w, scene.bounds.h, scene.gridShape, floorsChoice, everyFloor?.key]);

  useEffect(
    () => () => {
      runRef.current++;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  /** One floor's picture (picture.ts). Null once the run was overtaken. */
  const picture = async (floor: Scene, run: number, alone: boolean): Promise<Picture | null> => {
    const { view: room, roomId } = store.getState();
    if (!room) throw new ExportError("The room is not loaded yet.");
    return floorPicture({ floor, purpose: "image", view, pxPerCell, grid, alone, room, roomId, assets, stale: () => run !== runRef.current });
  };

  const make = async () => {
    const run = ++runRef.current;
    forget();
    setStatus({ kind: "busy" });
    try {
      let file: File;
      let pictures: (Picture & { name?: string })[];
      if (everyFloor) {
        const entries = floorEntries(everyFloor.floors);
        const made = await everyFloorZip({
          entries,
          picture: async (floor) => {
            const one = await picture(floor, run, false);
            if (!one) throw new Overtaken();
            return { ...one, name: floorName(floor) };
          },
          onFloor: (at, entry) => {
            if (run === runRef.current) setStatus({ kind: "busy", making: makingText(floorName(entry.floor), at, entries.length) });
          },
          stale: () => run !== runRef.current,
        });
        if (!made) return;
        pictures = made.pictures;
        file = new File([made.zip], everyFloorFileName(sceneGrid(scene), scene.name, sharedBounds(everyFloor.floors), size.requested, view), { type: "application/zip" });
      } else {
        const one = await picture(scene, run, true);
        if (!one) return;
        pictures = [one];
        file = new File([one.blob], exportFileName(sceneGrid(scene), scene.name, scene.bounds, size.pxPerCell, view, scene.floor?.name), { type: "image/png" });
      }
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setStatus({
        kind: "made",
        made: { file, url, width: size.width, height: size.height, pxPerCell: everyFloor ? size.requested : size.pxPerCell, share: prefersShare(file), notes: notesOf(pictures), ...(everyFloor ? { floors: pictures.length } : {}) },
      });
    } catch (err) {
      if (run !== runRef.current || err instanceof Overtaken) return;
      setStatus({ kind: "error", message: err instanceof ExportError ? err.message : "The image could not be made. Try a smaller scale." });
    }
  };

  const busy = status.kind === "busy";
  // The player view of a scene with fog on is judged by what the server gives, which this device's build does not show (MD4-ASTRA-4).
  const empty = everyFloor
    ? everyFloor.floors.length === 0 || (!everyFloor.anything && !everyFloor.floors.some((f) => fromServer(view, f)))
    : !scene.map && !hasBuild && !fromServer(view, scene);
  const reached = everyFloor && view === "player" ? reachedText(scene.name, everyFloor.floors.length, everyFloor.total) : null;
  const made = status.kind === "made" ? status.made : null;
  const shared = everyFloor ? sharedBounds(everyFloor.floors) : null;
  const sizeLine = everyFloor ? (shared && fits ? exportWords(sceneGrid(scene), shared, exportSize(shared, size.requested)).sizeLine : undefined) : size.pxPerCell < size.requested ? undefined : words.sizeLine;
  return (
    <Section label={EXPORT_LABEL}>
      {/* No box of its own, so the row stays an item of the section. */}
      <div ref={props.inside} style={{ display: "contents" }}>
        <SettingRow
          name={`Pixels per ${words.cell}`}
          help={sizeLine}
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
      {/* Export draws the still, as every reader of the map's pixels does (docs/design/design-v1-animated-maps.md 9.3). */}
      {scene.map?.video ? <Help>An animated map exports its still image.</Help> : null}
      {!everyFloor && size.pxPerCell < size.requested ? (
        <Note>
          Lowered to {size.pxPerCell} px per {words.cell}, so the image stays within 16.7 million pixels, the most an iPhone can draw. It will be {size.width} × {size.height} px.
        </Note>
      ) : null}
      {everyFloor && !fits ? <Note>{tooMuchText(words.cell)}</Note> : null}

      {every ? (
        <SettingRow name="Floors" help={everyFloor ? everyFloorHelp(scene.name, every.total) : undefined} wide>
          <Segmented<FloorsChoice>
            label="Floors"
            value={floorsChoice}
            options={[
              { value: "this", label: "This floor" },
              { value: "every", label: "Every floor" },
            ]}
            onChange={setFloorsChoice}
          />
        </SettingRow>
      ) : null}

      <SettingRow
        name="Version"
        help={
          view === "player"
            ? "What players can see: secret doors not yet found are walls, and lock marks, DM-only stamps, and labels and stamps under the fog are left out."
            : "Everything: secret doors, lock marks, every label and every stamp. Keep it to yourself."
        }
        wide
      >
        <Segmented<ExportView>
          label="Version"
          value={view}
          options={[
            { value: "player", label: "Player view" },
            { value: "dm", label: "DM view" },
          ]}
          onChange={setView}
        />
      </SettingRow>

      {reached ? <Help>{reached}</Help> : null}

      <Checkbox label={words.gridSwitch} help="Leave the grid off for another VTT. It draws its own grid over the image." checked={grid} onChange={setGrid} />

      <Row>
        <Button size="sm" disabled={busy} onClick={props.onClose}>
          Close
        </Button>
        <Button size="sm" variant={made ? "secondary" : "primary"} busy={busy} disabled={empty || !fits} onClick={() => void make()}>
          {busy ? (status.making ?? (everyFloor ? "Making the file…" : "Making the image…")) : everyFloor ? "Make the file" : "Make image"}
        </Button>
      </Row>
      {/* No floor reached says so in its own line above. */}
      {empty && !(everyFloor && everyFloor.floors.length === 0) ? <Help>Nothing to export yet. Add a map image or build some rooms first.</Help> : null}
      {status.kind === "error" ? (
        <div role="alert">
          <Note>{status.message}</Note>
        </div>
      ) : null}
      {made ? <MadeFile key={made.url} made={made} cell={words.cell} /> : null}
    </Section>
  );
}

/**
 * What the made file left out or drew otherwise, counted over its
 * pictures. A missing map names its floor where the file holds several.
 */
function notesOf(pictures: readonly (Picture & { name?: string })[]): string[] {
  const sum = (of: (c: ExportContent) => number) => pictures.reduce((n, p) => n + of(p.content), 0);
  const notes: string[] = [];
  const secretDoors = sum((c) => c.secretDoors);
  const hiddenLabels = sum((c) => c.hiddenLabels);
  const hiddenStamps = sum((c) => c.hiddenStamps);
  if (secretDoors > 0) notes.push(`${plural(secretDoors, "secret door")} drawn as ${secretDoors === 1 ? "a wall" : "walls"}, as players see them.`);
  if (hiddenLabels > 0) notes.push(`${plural(hiddenLabels, "label")} under the fog left out.`);
  if (hiddenStamps > 0) notes.push(`${plural(hiddenStamps, "stamp")} players cannot see left out.`);
  for (const p of pictures) {
    if (!p.mapMissing) continue;
    notes.push(p.name === undefined ? "The map image could not be loaded, so the image has only the build." : `${p.name}'s map image could not be loaded, so its picture has only the build.`);
  }
  return notes;
}
