import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Light, RoomState, Scene } from "#shared/model.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { sceneChunks } from "#shared/rules/walls.ts";
import { Button } from "../../components/Button.tsx";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { useAssets, useRoomStore, useRoomView } from "../../state/view.ts";
import { checkImport } from "../uvtt/client.ts";
import { uvttFile } from "../uvtt/encode.ts";
import type { ExportCheck } from "../uvtt/steps.ts";
import { uvttGeometry, type UvttHead } from "../uvtt/write.ts";
import { fromServer, hasBuildOn, type ExportView } from "./content.ts";
import { everyFloorFits, everyFloorZip, floorName, makingText, reachedText, sharedBounds, tooMuchText, useExportFloors, type FloorsChoice } from "./everyFloor.ts";
import { vttFileName, vttZipNames } from "./fileName.ts";
import { MadeFile, Overtaken, Row, type Made } from "./made.tsx";
import { floorPicture } from "./picture.ts";
import { ExportError } from "./render.ts";
import { prefersShare } from "./save.ts";
import { DEFAULT_PX_PER_CELL, exportSize, exportWords, MAX_EXPORT_PIXELS, PX_PER_CELL_CHOICES, VTT_LIMITS } from "./size.ts";
import { everyFloorVttHelp, HEX_LINE, lossLine, versionHelp, VTT_FAILED, vttNotes, type FloorFile } from "./vttNotes.ts";

/**
 * Export as VTT file (docs/design/design-v1-uvtt-export.md): a scene, or
 * every floor of one, as a Universal VTT file with its map image, walls,
 * doors, windows and lights, for another VTT or another room here. DM
 * only, on this device, from what the DM already holds: nothing is sent.
 *
 * The image is Export as image's picture with the grid off, always drawn
 * as players see the map (picture.ts). The player view's walls come from
 * the same chunks its picture is drawn from, so a file labeled for
 * players holds nothing they cannot see, and no light. The made file goes
 * through this app's own import check on a worker, whose answer becomes a
 * note: the file is made either way, since other VTTs read it as written.
 */

type Status = { kind: "idle" } | { kind: "busy"; making?: string } | { kind: "made"; made: Made; short: boolean } | { kind: "error"; message: string };

const EXPORT_LABEL = "Export";
const EMPTY_CHUNKS: RoomState["buildChunks"] = {};
const EMPTY_LABELS: RoomState["labels"] = {};
const EMPTY_STAMPS: RoomState["stamps"] = {};

/** One floor's file and what its notes read. */
type FloorMade = FloorFile & { blob: Blob };

export function UvttExport(props: { scene: Scene; inside: RefObject<HTMLDivElement | null>; onClose(): void }) {
  const { scene } = props;
  const store = useRoomStore();
  const assets = useAssets();
  const [pxPerCell, setPxPerCell] = useState<number>(DEFAULT_PX_PER_CELL);
  const [view, setView] = useState<ExportView>("player");
  const [floorsChoice, setFloorsChoice] = useState<FloorsChoice>("this");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  /** Bumped by every new run and by unmounting, so a slow run that was overtaken drops its result. */
  const runRef = useRef(0);
  const urlRef = useRef<string | null>(null);

  const chunks = useRoomView((s) => s.floorView?.buildChunks ?? EMPTY_CHUNKS);
  const labels = useRoomView((s) => s.floorView?.labels ?? EMPTY_LABELS);
  const stamps = useRoomView((s) => s.floorView?.stamps ?? EMPTY_STAMPS);
  const allChunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const hasBuild = useMemo(() => hasBuildOn(scene.id, chunks, labels, stamps), [scene.id, chunks, labels, stamps]);
  const size = exportSize(scene.bounds, pxPerCell, VTT_LIMITS);
  const words = exportWords(sceneGrid(scene), scene.bounds, size);
  const every = useExportFloors(scene, view, true);
  const everyFloor = every && floorsChoice === "every" ? every : null;
  const fits = everyFloor ? everyFloorFits(everyFloor.floors, size.requested, VTT_LIMITS) : true;
  const floors = everyFloor ? everyFloor.floors : scene;
  // Whether a wall or door in the DM's build is short enough that the import may close it up (write.ts SHORT_LATTICE), for the loss line before a file is made.
  const short = useMemo(
    () => (Array.isArray(floors) ? floors : [floors]).some((f) => uvttGeometry({ scene: f, chunks: sceneChunks(allChunks, f.id), rule: f.autoWalls ?? "all", lights: [], feetPerCell, pxPerCell: 1 }, "dm").counts.short),
    [allChunks, feetPerCell, floors],
  );

  const forget = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  // A made file no longer matches once the options or the scene's size or name change.
  useEffect(() => {
    runRef.current++;
    forget();
    setStatus({ kind: "idle" });
  }, [pxPerCell, view, scene.id, scene.name, scene.bounds.w, scene.bounds.h, scene.gridShape, floorsChoice, everyFloor?.key]);

  useEffect(
    () => () => {
      runRef.current++;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  /** One floor's file, or null once the run was overtaken. */
  const floorFile = async (floor: Scene, run: number, alone: boolean, name?: string): Promise<FloorMade | null> => {
    const { view: room, roomId } = store.getState();
    if (!room) throw new ExportError("The room is not loaded yet.");
    const stale = () => run !== runRef.current;
    const picture = await floorPicture({ floor, purpose: "file", view, pxPerCell, limits: VTT_LIMITS, grid: false, alone, room, roomId, assets, stale });
    if (!picture) return null;
    const floorSize = exportSize(floor.bounds, pxPerCell, VTT_LIMITS);
    // The player view's walls come from the chunks its picture is drawn from, never the DM's (section 5).
    const head: UvttHead =
      view === "player"
        ? uvttGeometry({ scene: floor, chunks: picture.content.chunks, rule: picture.rule, lights: [], feetPerCell, pxPerCell: floorSize.pxPerCell }, "player")
        : uvttGeometry({ scene: floor, chunks: sceneChunks(room.buildChunks, floor.id), rule: floor.autoWalls ?? "all", lights: lightsOn(room.lights, floor.id), feetPerCell, pxPerCell: floorSize.pxPerCell }, "dm");
    let check: ExportCheck | null;
    try {
      check = await checkImport(head, feetPerCell);
    } catch {
      // A check that cannot run says nothing: the file is still the file.
      check = null;
    }
    if (stale()) return null;
    const blob = await uvttFile(head, picture.blob);
    if (stale()) return null;
    return { name, content: picture.content, counts: head.counts, bytes: blob.size, check, mapMissing: picture.mapMissing, blob };
  };

  const make = async () => {
    const run = ++runRef.current;
    forget();
    setStatus({ kind: "busy" });
    try {
      let file: File;
      let files: FloorMade[];
      if (everyFloor) {
        const names = vttZipNames(scene.name, view, everyFloor.floors.map(floorName));
        const entries = everyFloor.floors.map((floor, i) => ({ floor, name: names.entries[i]! }));
        const made = await everyFloorZip({
          entries,
          picture: async (floor) => {
            const one = await floorFile(floor, run, false, floorName(floor));
            if (!one) throw new Overtaken();
            return one;
          },
          onFloor: (at, entry) => {
            if (run === runRef.current) setStatus({ kind: "busy", making: makingText(floorName(entry.floor), at, entries.length) });
          },
          stale: () => run !== runRef.current,
        });
        if (!made) return;
        files = made.pictures;
        file = new File([made.zip], names.zip, { type: "application/zip" });
      } else {
        const one = await floorFile(scene, run, true);
        if (!one) return;
        files = [one];
        file = new File([one.blob], vttFileName(scene.name, view, scene.floor?.name), { type: "application/json" });
      }
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setStatus({
        kind: "made",
        made: {
          file,
          url,
          width: size.width,
          height: size.height,
          pxPerCell: everyFloor ? size.requested : size.pxPerCell,
          share: prefersShare(file),
          notes: vttNotes(files, view),
          ...(everyFloor ? { floors: files.length } : {}),
        },
        short: files.some((f) => f.counts.short),
      });
    } catch (err) {
      if (run !== runRef.current || err instanceof Overtaken) return;
      setStatus({ kind: "error", message: err instanceof ExportError ? err.message : VTT_FAILED });
    }
  };

  const busy = status.kind === "busy";
  const empty = everyFloor
    ? everyFloor.floors.length === 0 || (!everyFloor.anything && !everyFloor.floors.some((f) => fromServer(view, f)))
    : !scene.map && !hasBuild && !fromServer(view, scene);
  const reached = everyFloor && view === "player" ? reachedText(scene.name, everyFloor.floors.length, everyFloor.total) : null;
  const made = status.kind === "made" ? status.made : null;
  const shared = everyFloor ? sharedBounds(everyFloor.floors) : null;
  const lowered = !everyFloor && size.pxPerCell < size.requested;
  const sizeLine = everyFloor ? (shared && fits ? exportWords(sceneGrid(scene), shared, exportSize(shared, size.requested, VTT_LIMITS)).sizeLine : undefined) : lowered ? undefined : words.sizeLine;
  const loss = lossLine({ otherFloors: every !== null && !everyFloor, short: short || (status.kind === "made" && status.short) });
  return (
    <Section label={EXPORT_LABEL}>
      {/* No box of its own, so the row stays an item of the section. */}
      <div ref={props.inside} style={{ display: "contents" }}>
        <SettingRow name={`Pixels per ${words.cell}`} help={sizeLine} wide>
          <Segmented<number>
            label={`Pixels per ${words.cell}`}
            value={pxPerCell}
            options={PX_PER_CELL_CHOICES.map((v) => ({ value: v, label: `${v} px`, title: `${v} pixels per ${words.cell}` }))}
            onChange={setPxPerCell}
          />
        </SettingRow>
      </div>
      {scene.map?.video ? <Help>An animated map exports its still image.</Help> : null}
      {lowered ? <Note>{loweredText(scene.bounds, size, words.cell)}</Note> : null}
      {everyFloor && !fits ? <Note>{tooMuchText(words.cell)}</Note> : null}

      {every ? (
        <SettingRow name="Floors" help={everyFloor ? everyFloorVttHelp(scene.name, every.total) : undefined} wide>
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

      <SettingRow name="Version" help={versionHelp(view)} wide>
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
      <Help>{loss}</Help>
      {isHex(sceneGrid(scene)) ? <Help>{HEX_LINE}</Help> : null}

      <Row>
        <Button size="sm" disabled={busy} onClick={props.onClose}>
          Close
        </Button>
        <Button size="sm" variant={made ? "secondary" : "primary"} busy={busy} disabled={empty || !fits} onClick={() => void make()}>
          {busy ? (status.making ?? "Making the file…") : "Make the file"}
        </Button>
      </Row>
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

/** The floor's lights, which the DM view writes when they are on (write.ts leaves the others out and counts them). */
function lightsOn(lights: RoomState["lights"], sceneId: string): Light[] {
  return Object.values(lights).filter((l): l is Light => l !== undefined && l.sceneId === sceneId);
}

/** Why the scale went down: the side the import takes, or the pixels an iPhone draws. */
function loweredText(bounds: { w: number; h: number }, size: { pxPerCell: number; width: number; height: number }, cell: string): string {
  const bySide = Math.floor(VTT_LIMITS.maxSide / Math.max(bounds.w, bounds.h)) < Math.floor(Math.sqrt(MAX_EXPORT_PIXELS / (bounds.w * bounds.h)));
  const why = bySide ? "8,192 px a side, the most this app's import takes" : "16.7 million pixels, the most an iPhone can draw";
  return `Lowered to ${size.pxPerCell} px per ${cell}, so the image stays within ${why}. It will be ${size.width} × ${size.height} px.`;
}
