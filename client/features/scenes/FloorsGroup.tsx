import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { RoomState, Scene } from "#shared/model.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { Button } from "../../components/Button.tsx";
import { Group, Help } from "../../components/Panel.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { FLOOR_ROOT_ATTR, FLOOR_ROOTS } from "../floors/ids.ts";
import { FloorPage } from "./FloorPage.tsx";
import { addRefusal, FLOOR_MARKS, floorRowLabel, floorsSummary, floorsTopFirst, ON_SCREEN, playersAt } from "./floorWords.ts";
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
 */
export function FloorsGroup(props: { scene: Scene; fold: { open: boolean; onToggle(): void }; ask?: number }) {
  const { scene } = props;
  const actions = useRoomActions();
  // The scenes alone, since the group stays mounted while folded and every op elsewhere in the room would draw it again.
  const scenes = useRoomView((s) => s.view?.scenes);
  const shownId = useRoomView((s) => s.sceneId);
  const [page, setPage] = useState<{ id: string; selectName: boolean } | null>(null);
  const [adding, setAdding] = useState<Side | null>(null);
  // The search's route to a control on a floor's page (scenes/search.ts) asks for the floor on screen's page, which the control lives on.
  const ask = props.ask ?? 0;
  const onFloor = scene.floor !== undefined;
  useEffect(() => {
    if (ask > 0 && onFloor) setPage({ id: scene.id, selectName: false });
  }, [ask, onFloor, scene.id]);
  if (!scenes) return null;
  const floors = floorsOf({ scenes }, scene.id);
  const mainName = scene.name;
  const refusal = addRefusal(floors.length, mainName);
  const pageFloor = page ? scenes[page.id] : undefined;

  const add = (side: Side) => {
    if (adding !== null || refusal !== null) return;
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
            <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
              <Button size="sm" icon="arrowUp" search="scenes.floors.add-above" busy={adding === "above"} disabled={refusal !== null || adding === "below"} onClick={() => add("above")}>
                Add a floor above
              </Button>
              <Button size="sm" icon="arrowDown" search="scenes.floors.add-below" busy={adding === "below"} disabled={refusal !== null || adding === "above"} onClick={() => add("below")}>
                Add a floor below
              </Button>
            </div>
            {refusal !== null ? <Help>{refusal}</Help> : null}
          </>
        )}
      </Group>
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
