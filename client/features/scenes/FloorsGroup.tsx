import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { RoomState, Scene } from "#shared/model.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { Button } from "../../components/Button.tsx";
import { Group, Help, Note } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { Tag } from "../../components/Tag.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { GenerateDialog } from "../dungeon/GenerateDialog.tsx";
import { FLOOR_ROOT_ATTR, FLOOR_ROOTS } from "../floors/ids.ts";
import { ImportDialog } from "../uvtt/ImportDialog.tsx";
import { EXTENSIONS, fileSizeProblem, thisDevice, type Device } from "../uvtt/limits.ts";
import { newSceneIntent, newScenePreset } from "./create.ts";
import { FloorPage } from "./FloorPage.tsx";
import { floorAddRefusal } from "./floorSource.ts";
import { fileHexReason, floorHexNote, FLOOR_MAP_HELP, FLOOR_MAP_NAME, FLOOR_MAP_OPTIONS, FLOOR_MARKS, floorRowLabel, floorsSummary, floorsTopFirst, ON_SCREEN, playersAt, type FloorMap } from "./floorWords.ts";
import { SCENE_GROUP_ICONS, SCENE_GROUP_LABELS } from "./settingsFolds.ts";

type Side = "above" | "below";

/**
 * The Floors group of a scene's settings (docs/design/design-v1-floors.md
 * 7.1), first after This scene: the scene's floors top first with where the
 * players stand with each, Add a floor above and below the floor on screen,
 * and a floor's own page in place of the list. An add is one `scene.create`
 * and shows the new floor at once, opening its page on the name. A scene
 * with one floor shows no list, only the two adds. It stays mounted while
 * folded, as the other groups do, so a page left open is still there. It
 * is not remounted by a switch of floor, so the page an add opens survives
 * the switch to the new floor.
 *
 * Map (docs/design/design-v1-floors.md phase 3, 3.5) picks what the adds
 * make: a blank floor at once, a floor from a Universal VTT file through
 * the import dialog, or a generated dungeon through Generate a dungeon,
 * each aimed at a floor above or below the floor on screen. A file or a
 * dungeon brings square walls, so both are off on a hex scene.
 */
export function FloorsGroup(props: { scene: Scene; fold: { open: boolean; onToggle(): void }; ask?: number }) {
  const { scene } = props;
  const actions = useRoomActions();
  // The scenes alone, since the group stays mounted while folded and every op elsewhere in the room would draw it again.
  const scenes = useRoomView((s) => s.view?.scenes);
  const floorLinks = useRoomView((s) => s.view?.floorLinks);
  const reasonId = useId();
  const shownId = useRoomView((s) => s.sceneId);
  const [page, setPage] = useState<{ id: string; selectName: boolean } | null>(null);
  const [adding, setAdding] = useState<Side | null>(null);
  const [map, setMap] = useState<FloorMap>("blank");
  /** The file picked for a floor, and the add that asked for it. */
  const [picked, setPicked] = useState<{ file: File; device: Device; side: Side } | null>(null);
  const [tooBig, setTooBig] = useState<string | null>(null);
  /** The add whose Generate a dungeon is open. */
  const [generating, setGenerating] = useState<Side | null>(null);
  /** Which add clicked the file input, read when its pick comes back. */
  const picking = useRef<Side>("above");
  const fileInput = useRef<HTMLInputElement>(null);
  const aboveButton = useRef<HTMLButtonElement>(null);
  const belowButton = useRef<HTMLButtonElement>(null);
  const hexId = useId();
  const newScenePlayers = useRoomView((s) => s.view?.meta.settings.newScenePlayers);
  const roomId = useRoomView((s) => s.roomId);
  // The search's route to a control on a floor's page (scenes/search.ts) asks for the floor on screen's page, which the control lives on.
  const ask = props.ask ?? 0;
  const onFloor = scene.floor !== undefined;
  useEffect(() => {
    if (ask > 0 && onFloor) setPage({ id: scene.id, selectName: false });
  }, [ask, onFloor, scene.id]);
  // Blank whenever the group opens, so an add never makes a file or a dungeon floor the DM picked long ago.
  const groupOpen = props.fold.open;
  useEffect(() => {
    if (groupOpen) setMap("blank");
  }, [groupOpen]);
  if (!scenes) return null;
  const floors = floorsOf({ scenes }, scene.id);
  const mainName = scene.name;
  const pageFloor = page ? scenes[page.id] : undefined;
  // A full scene, a full room and stairs an add would come between each turn both adds off, with the reasons under the buttons.
  const linkView = { scenes, ...(floorLinks ? { floorLinks } : {}) };
  const above = floorAddRefusal(linkView, { beside: scene.id, side: "above" });
  const below = floorAddRefusal(linkView, { beside: scene.id, side: "below" });
  const reasons = [...new Set([above, below].filter((r): r is string => r !== null))];
  // A file's walls and a generated dungeon lie on squares (D-261110-075).
  const hex = isHex(sceneGrid(scene));
  const pick: FloorMap = hex ? "blank" : map;
  const hexReasons = hex ? `${fileHexReason(mainName)} ${floorHexNote(mainName)}` : null;

  const add = (side: Side) => {
    if (adding !== null || (side === "above" ? above : below) !== null) return;
    setTooBig(null);
    if (pick === "file") {
      picking.current = side;
      fileInput.current?.click();
      return;
    }
    if (pick === "dungeon") {
      setGenerating(side);
      return;
    }
    const id = actions.newId();
    setAdding(side);
    const n = actions.dispatch(
      { t: "scene.create", scene: { id, name: scene.name, bounds: scene.bounds }, floor: { beside: scene.id, side } },
      {
        onAnswer: (answer) => {
          setAdding(null);
          // A refused or lost add leaves no floor to look at, so the page it opened closes.
          if (answer !== "taken" && answer !== "unknown") setPage((p) => (p?.id === id ? null : p));
        },
      },
    );
    if (n === null) {
      setAdding(null);
      return;
    }
    actions.showFloor(id);
    setPage({ id, selectName: true });
  };

  return (
    <div {...{ [FLOOR_ROOT_ATTR]: FLOOR_ROOTS.group }}>
      <Group
        label={SCENE_GROUP_LABELS.floors}
        icon={SCENE_GROUP_ICONS.floors}
        {...props.fold}
        keep
        wholeSummary
        summary={floorsSummary(floors, shownId)}
        search="scenes.floors"
      >
        {pageFloor ? (
          <FloorPage key={pageFloor.id} floor={pageFloor} selectName={page?.selectName === true} onBack={() => setPage(null)} />
        ) : (
          <>
            {floors.length > 1 ? (
              <FloorRows sceneId={scene.id} shownId={shownId} onOpen={(id) => setPage({ id, selectName: false })} />
            ) : (
              <Help>{mainName} has one floor. Add one above or below to build a tower, a cellar or a roof.</Help>
            )}
            <SettingRow name={FLOOR_MAP_NAME} search="scenes.floors.map" wide>
              {(ids) => (
                <div style={{ display: "grid", gap: theme.space(1), minWidth: 0, width: "100%" }}>
                  <Segmented<FloorMap>
                    labelledBy={ids.nameId}
                    value={pick}
                    even
                    wrap
                    description={FLOOR_MAP_HELP[pick]}
                    {...(hexReasons ? { describedBy: hexId } : null)}
                    options={FLOOR_MAP_OPTIONS.map((o) => ({ ...o, disabled: hex && o.value !== "blank" }))}
                    onChange={(next) => {
                      setMap(next);
                      setTooBig(null);
                    }}
                  />
                  {hexReasons ? <Help id={hexId}>{hexReasons}</Help> : null}
                </div>
              )}
            </SettingRow>
            <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
              <Button ref={aboveButton} size="sm" icon="arrowUp" search="scenes.floors.add-above" busy={adding === "above"} disabled={above !== null || adding === "below"} aria-describedby={above !== null ? reasonId : undefined} onClick={() => add("above")}>
                Add a floor above
              </Button>
              <Button ref={belowButton} size="sm" icon="arrowDown" search="scenes.floors.add-below" busy={adding === "below"} disabled={below !== null || adding === "above"} aria-describedby={below !== null ? reasonId : undefined} onClick={() => add("below")}>
                Add a floor below
              </Button>
            </div>
            {reasons.length > 0 ? <Help id={reasonId}>{reasons.join(" ")}</Help> : null}
            {tooBig ? (
              <div role="alert">
                <Note>{tooBig}</Note>
              </div>
            ) : null}
            {/* The adds stay buttons whatever the pick, so a file pick clicks this input rather than wrapping them in its label (D-261110-117). */}
            <input
              ref={fileInput}
              type="file"
              data-floor-file=""
              tabIndex={-1}
              aria-hidden
              accept={thisDevice() === "computer" ? EXTENSIONS.join(",") : undefined}
              style={VISUALLY_HIDDEN}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const device = thisDevice();
                // A phone checks the size before reading a byte: a file too big for its memory could end the tab.
                const problem = fileSizeProblem(file.size, device);
                setTooBig(problem);
                if (!problem) setPicked({ file, device, side: picking.current });
              }}
            />
          </>
        )}
      </Group>
      {/* Outside the list, so a floor's page opened by an add leaves the dialog that made it in place. */}
      {picked ? (
        <ImportDialog
          file={picked.file}
          device={picked.device}
          target={{ kind: "floor", beside: scene.id, side: picked.side }}
          onClose={() => setPicked(null)}
          onFloor={(id) => setPage({ id, selectName: true })}
        />
      ) : null}
      {generating && roomId ? (
        <GenerateDialog
          roomId={roomId}
          name={mainName}
          form={scene.bounds}
          intent={newSceneIntent(newScenePreset(newScenePlayers, "builder"), undefined)}
          opener={generating === "above" ? aboveButton : belowButton}
          floor={{ beside: scene.id, side: generating }}
          onClose={() => setGenerating(null)}
          onMade={(id) => {
            setGenerating(null);
            setPage({ id, selectName: true });
          }}
        />
      ) : null}
    </div>
  );
}

/** What a floor row's mark reads (floorWords.ts playersAt), from the view. */
export function floorRowParts(view: RoomState | null): Pick<RoomState, "scenes" | "tokens" | "meta" | "characters" | "openFloors"> | null {
  if (view === null) return null;
  return { scenes: view.scenes, tokens: view.tokens, meta: view.meta, characters: view.characters, ...(view.openFloors !== undefined ? { openFloors: view.openFloors } : {}) };
}

/**
 * The scene's floors top first, with where the players stand with each.
 * It reads only what the marks read, part by part, so an op on anything
 * else draws no row again.
 */
function FloorRows(props: { sceneId: string; shownId: string | null; onOpen(id: string): void }) {
  const view = useRoomView(useShallow((s) => floorRowParts(s.view)));
  if (!view) return null;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {floorsTopFirst(view, props.sceneId).map((floor, i) => {
        const shown = floor.id === props.shownId;
        const mark = FLOOR_MARKS[playersAt(view, floor)];
        const name = floor.floor?.name ?? floor.name;
        return (
          <li key={floor.id} style={{ borderTop: i === 0 ? undefined : `${theme.line.border}px solid ${theme.color.border}` }}>
            <button
              type="button"
              aria-label={floorRowLabel(name, mark, shown)}
              onClick={() => props.onOpen(floor.id)}
              style={{
                width: "100%",
                minHeight: 56,
                display: "flex",
                alignItems: "center",
                gap: theme.space(2),
                padding: theme.space(1),
                border: `${theme.line.border}px solid ${shown ? theme.color.accent : "transparent"}`,
                borderRadius: theme.radius.md,
                background: shown ? theme.color.accentTint : "transparent",
                color: theme.color.text,
                fontFamily: theme.font.body,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight }}>{name}</span>
                <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.tight, color: theme.color.textMuted }}>{mark}</span>
              </span>
              {shown ? <Tag tone="muted">{ON_SCREEN}</Tag> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
