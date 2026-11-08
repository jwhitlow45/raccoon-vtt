import { useEffect, useId, useMemo, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { buttonLook } from "../../components/looks.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { openAt } from "../search/route.ts";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import { FLOOR_ROOT_ATTR, FLOOR_ROOTS, FLOOR_SEARCH } from "./ids.ts";
import { useHeldFloors } from "./useFloors.ts";
import { floorMarks, FLOORS_GROUP, FLOORS_SETTINGS } from "./words.ts";

/*
 * Floors (docs/design/design-v1-floors.md 7.2): the floors this device
 * holds, top first, as radio rows of 44 px with the floor shown checked, a
 * pop-up under the Floor button from 900 px up and a sheet on a phone. A
 * DM's row says whether players are there, reached it or not yet, with
 * the party members there by initials. A player's names the party's
 * creatures there that they see and "You are here" on their own creature's
 * floor. A DM's ends with Floors…, the settings group.
 */

/**
 * The rows. A pick shows that floor and closes the menu, by a tap, a
 * click or a key (Up, Down, Home, End), since the room closes an open
 * pop-up on every switch of the floor shown as on a switch of scenes
 * (pages/Room.tsx), and the sheet follows the pop-up. Enter and a tap on
 * the floor shown close it too, and Escape as every pop-up and sheet
 * does. `[` and `]` step through floors with nothing open. Focus opens on
 * the floor shown (12).
 */
export function FloorsMenuBody(props: { onDone(): void }) {
  const view = useRoomView((s) => s.view);
  const you = useRoomView((s) => s.you);
  const sceneId = useRoomView((s) => s.sceneId);
  // "You are here" on the floor of the creature the device follows, once it follows one.
  const followed = useRoomView((s) => (s.floorFollow?.tokenId ? s.floorFollow.sceneId : null));
  const held = useHeldFloors();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const group = useRef<HTMLDivElement>(null);
  const name = useId();
  useEffect(() => {
    group.current?.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
  }, []);
  const top = useMemo(() => [...held].reverse(), [held]);
  if (!view || !you) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      props.onDone();
      return;
    }
    if (e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const radios = [...(group.current?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [])];
    const to = e.key === "Home" ? radios[0] : radios[radios.length - 1];
    if (!to) return;
    if (!to.checked) actions.showFloor(to.value);
    props.onDone();
  };
  return (
    <div {...{ [FLOOR_ROOT_ATTR]: FLOOR_ROOTS.menu }} style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <div ref={group} role="radiogroup" aria-label={FLOORS_GROUP} onKeyDown={onKeyDown} style={{ display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
        {top.map((floor) => {
          const chosen = floor.id === sceneId;
          const marks = floorMarks(view, floor, you, followed);
          const own = floor.floor?.name ?? floor.name;
          return (
            <label key={floor.id} className="rvtt-choice" data-floor-row={floor.id} style={{ ...ROW, ...buttonLook("quiet", { pressed: chosen }) }}>
              <input type="radio" name={name} value={floor.id} checked={chosen} aria-label={[own, ...marks].join(", ")} onChange={() => actions.showFloor(floor.id)} onClick={props.onDone} style={RADIO_COVER} />
              <span aria-hidden style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
                <span>{own}</span>
                {marks.length > 0 ? <span style={MARKS}>{marks.join(" · ")}</span> : null}
              </span>
              {chosen ? <Icon name="check" size="sm" style={{ flex: "none" }} /> : null}
            </label>
          );
        })}
      </div>
      {you.role === "dm" ? (
        <Button
          size="sm"
          icon="settings"
          onClick={() => {
            props.onDone();
            openAt(scope, ui, { panel: "scenes", section: "floors", anchor: FLOOR_SEARCH.group });
          }}
          style={{ justifySelf: "start" }}
        >
          {FLOORS_SETTINGS}
        </Button>
      ) : null}
    </div>
  );
}

/** Floors as a bottom sheet, a centered card from 600 px up: the phone's Floor button opens it, and the Menu panel's Floor row where the bar folded the button away. */
export function FloorsSheetDialog(props: { opener?: RefObject<HTMLElement | null>; onClose(): void }) {
  return (
    <SheetDialog title={FLOORS_GROUP} opener={props.opener} onClose={props.onClose} width={theme.layout.dialog.sm}>
      <FloorsMenuBody onDone={props.onClose} />
    </SheetDialog>
  );
}

/** A row the whole of its 44 px, as the View menu's: a tap anywhere on it hits the radio. Its marks wrap under the name. */
const ROW: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  minHeight: theme.touch,
  padding: `${theme.space(1)}px ${theme.space(3)}px`,
  boxSizing: "border-box",
  borderRadius: theme.radius.md,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  lineHeight: theme.leading.tight,
  whiteSpace: "normal",
  overflowWrap: "break-word",
  cursor: "pointer",
};

const MARKS: CSSProperties = { fontSize: theme.font.small, fontWeight: theme.weight.regular, color: theme.color.textMuted, lineHeight: theme.leading.body };

const RADIO_COVER: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" };
