import { useEffect, useId, useRef, useState } from "react";
import { LIMITS } from "#shared/limits.ts";
import type { Scene } from "#shared/model.ts";
import { FLOOR_HEIGHT } from "#shared/protocol.ts";
import { FLOOR_WORDS } from "#shared/rules/floors.ts";
import { Button } from "../../components/Button.tsx";
import { FieldRow, Input } from "../../components/Field.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { FLOOR_ROOT_ATTR, FLOOR_ROOTS } from "../floors/ids.ts";
import { ConfirmButton } from "./controls.tsx";
import { floorsTopFirst, GO_TO_FLOOR, heightOf, hideRefusal, orderAfterMove, PLAYERS_LINES, playersAt, removeRefusal, SHOW_HELP, stepHeight } from "./floorWords.ts";

/**
 * One floor's page inside the Floors group (docs/design/design-v1-floors.md
 * 7.1): its name, its height above the floor below, whether players have it,
 * where it stands in the stack, which floor the DM looks at, and Remove.
 * Opens on the name, selected after an add, so the DM types over "New floor".
 * What is off says why in a line under the buttons, since a disabled
 * button alone does not (nothing here needs hover).
 */
export function FloorPage(props: { floor: Scene; selectName: boolean; onBack(): void }) {
  const { floor } = props;
  const actions = useRoomActions();
  const view = useRoomView((s) => s.view);
  const shownId = useRoomView((s) => s.sceneId);
  const nameId = useId();
  const reasonId = useId();
  if (!view || !floor.floor) return null;
  const floors = floorsTopFirst(view, floor.id);
  const bottomFirst = floors.slice().reverse();
  const level = floor.floor.level;
  const at = playersAt(view, floor);
  const shown = shownId === floor.id;
  const hide = hideRefusal(view, floor);
  const remove = removeRefusal(view, floor);
  const open = at !== "not";
  const height = heightOf(floor);

  const order = (up: boolean) => {
    const next = orderAfterMove(bottomFirst, floor.id, up);
    if (next) actions.dispatch({ t: "floor.order", sceneId: floor.id, floors: next });
  };
  const setHeight = (direction: 1 | -1) => {
    const next = stepHeight(height, direction);
    if (next !== null) actions.dispatch({ t: "scene.update", sceneId: floor.id, patch: { floor: { height: next } } });
  };
  const removeFloor = () => {
    // The view moves off a floor that is about to go, to the one below it, else the one above.
    if (shown) {
      const neighbor = bottomFirst[level - 1] ?? bottomFirst[level + 1];
      if (neighbor) actions.showFloor(neighbor.id);
    }
    actions.dispatch({ t: "scene.delete", sceneId: floor.id });
    props.onBack();
  };

  return (
    <div {...{ [FLOOR_ROOT_ATTR]: FLOOR_ROOTS.page }} style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      {/* Back stands alone: Go to this floor, pressed, below says which floor is on screen, and a tag beside Back would set a 20 px pill against a 44 px button. */}
      <div style={{ justifySelf: "start" }}>
        <Button size="sm" icon="back" onClick={props.onBack}>
          Back to Floors
        </Button>
      </div>
      <FloorName key={floor.id} floor={floor} others={floors} select={props.selectName} inputId={nameId} />
      {level === 0 ? null : (
        <SettingRow name="Height above the floor below" help={`${FLOOR_HEIGHT.min} to ${FLOOR_HEIGHT.max} ft, in steps of ${FLOOR_HEIGHT.step}.`} search="scenes.floor.height">
          <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
            <Button size="sm" icon="minus" iconOnly="always" aria-label={`Lower ${floor.floor.name} by ${FLOOR_HEIGHT.step} feet`} disabled={stepHeight(height, -1) === null} onClick={() => setHeight(-1)} />
            <span aria-live="polite" style={{ minWidth: 48, textAlign: "center", fontVariantNumeric: "tabular-nums", fontSize: theme.font.input }}>
              {height} ft
            </span>
            <Button size="sm" icon="plus" iconOnly="always" aria-label={`Raise ${floor.floor.name} by ${FLOOR_HEIGHT.step} feet`} disabled={stepHeight(height, 1) === null} onClick={() => setHeight(1)} />
          </div>
        </SettingRow>
      )}
      <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0` }}>
        <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>Players</span>
        <span style={{ fontSize: theme.font.body14 }}>{PLAYERS_LINES[at]}</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), paddingTop: theme.space(1) }}>
          <Button size="sm" search="scenes.floor.players" disabled={open && hide !== null} aria-describedby={open && hide !== null ? reasonId : undefined} onClick={() => actions.dispatch({ t: "floor.open", sceneId: floor.id, open: !open })}>
            {open ? "Hide from players" : "Show to players"}
          </Button>
        </div>
        <Help id={open && hide !== null ? reasonId : undefined}>{open && hide !== null ? hide : SHOW_HELP}</Help>
      </div>
      {/* Go to this floor moves the DM's view, not the floor, so it has a row apart from the stack's two moves, where it never wraps alone under them. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button size="sm" icon="arrowUp" search="scenes.floor.order" disabled={level >= floors.length - 1} onClick={() => order(true)}>
          Move up
        </Button>
        <Button size="sm" icon="arrowDown" disabled={level === 0} onClick={() => order(false)}>
          Move down
        </Button>
      </div>
      <div style={{ justifySelf: "start" }}>
        <Button size="sm" search="scenes.floor.show" pressed={shown} onClick={() => actions.showFloor(floor.id)}>
          {GO_TO_FLOOR}
        </Button>
      </div>
      <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
        <div data-search="scenes.floor.remove">
          <ConfirmButton label="Remove floor" confirm="Tap again to remove" title={`Removes ${floor.floor.name} with everything on it`} disabled={remove !== null} onConfirm={removeFloor} />
        </div>
        {remove !== null ? <Note>{remove}</Note> : <Help>Removes {floor.floor.name} with everything on it. Undo brings it back.</Help>}
      </div>
    </div>
  );
}

/**
 * The floor's name, saved on Enter or blur like the scene's. A name another
 * floor of the scene has is refused here in the server's words, before it is sent.
 */
function FloorName(props: { floor: Scene; others: readonly Scene[]; select: boolean; inputId: string }) {
  const { floor } = props;
  const actions = useRoomActions();
  const name = floor.floor?.name ?? "";
  const [text, setText] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setText(name);
    saved.current = name;
  }, [name]);
  // A page opens on its name (design 12), after an add with the placeholder name selected.
  useEffect(() => {
    input.current?.focus({ preventScroll: false });
    if (props.select) input.current?.select();
  }, [props.select]);
  const save = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setText(name);
      setError(null);
      return;
    }
    if (trimmed === saved.current) {
      setError(null);
      return;
    }
    if (props.others.some((o) => o.id !== floor.id && o.floor?.name === trimmed)) {
      setError(FLOOR_WORDS.sameName(floor.name, trimmed));
      return;
    }
    setError(null);
    saved.current = trimmed;
    actions.dispatch({ t: "scene.update", sceneId: floor.id, patch: { floor: { name: trimmed } } });
  };
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <FieldRow label="Floor name" fill htmlFor={props.inputId} search="scenes.floor.name">
        <Input
          ref={input}
          id={props.inputId}
          value={text}
          maxLength={LIMITS.floorNameChars}
          error={error !== null}
          aria-describedby={error !== null ? `${props.inputId}-error` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          style={{ flex: 1, width: "100%" }}
        />
      </FieldRow>
      {error !== null ? (
        <p id={`${props.inputId}-error`} role="alert" style={{ margin: 0, fontSize: theme.font.small, color: theme.color.warning }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
