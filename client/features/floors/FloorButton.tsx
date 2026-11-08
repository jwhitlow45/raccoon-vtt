import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Popover, usePopover, type Rect } from "../../components/Popover.tsx";
import { addsWords, useTooltip } from "../../components/Tooltip.tsx";
import { useLayoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { theme } from "../../lib/theme.ts";
import { useKeyHint } from "../../state/shortcuts.ts";
import { FLOOR_NAME_MAX_PX } from "./bar.ts";
import { FLOOR_ROOT_ATTR, FLOOR_ROOTS } from "./ids.ts";
import { FloorsMenuBody, FloorsSheetDialog } from "./FloorsMenu.tsx";
import { useShownFloor } from "./useFloors.ts";
import { FLOORS_GROUP, floorButtonLabel, floorTip } from "./words.ts";

/*
 * The top bar's Floor (docs/design/design-v1-floors.md 7.2, 18.6): just
 * before View, after Find my token on a player's bar, while this device
 * holds more than one floor of its scene. It shows the `floors` icon and
 * the floor's name where the bar has room (`form` "name"), else the icon
 * alone, and a phone always the icon. Its name stays "Floor: Upper floor.
 * Show another floor" in every form. It opens Floors, a pop-up from 900 px
 * up and a sheet below. Where the bar gives way further it folds with View
 * into the Menu panel (pages/topBarFit.ts viewFold, panels/MenuPanel.tsx).
 */


function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

/** This device's two keys (`[` and `]` by default) where it has a keyboard, the tooltip "Show another floor ([ and ])", and the `aria-keyshortcuts`. */
export function useFloorKeys(): { keys: { below: string; above: string } | null; tip: string; aria: string | undefined } {
  const below = useKeyHint("floorBelow");
  const above = useKeyHint("floorAbove");
  const keys = below && above ? { below: below.text, above: above.text } : null;
  return { keys, tip: floorTip(keys), aria: below && above ? `${below.aria} ${above.aria}` : undefined };
}

export function FloorButton(props: { form: "name" | "icon"; onOpen?(open: boolean): void }) {
  const floor = useShownFloor();
  const wide = useLayoutSize().width >= theme.layout.wideMinWidth;
  if (!floor) return null;
  const name = floor.floor?.name ?? floor.name;
  return wide ? <FloorPopover name={name} form={props.form} onOpen={props.onOpen} /> : <FloorSheet name={name} />;
}

function FloorPopover(props: { name: string; form: "name" | "icon"; onOpen?(open: boolean): void }) {
  const handle = usePopover({ kind: "dialog" });
  const { onOpen } = props;
  const open = handle.open;
  // In a layout effect, so the top bar stands over the notices in the commit that shows the pop-up, as View's does.
  useLayoutEffect(() => {
    onOpen?.(open);
  }, [open, onOpen]);
  useLayoutEffect(() => () => onOpen?.(false), [onOpen]);
  const { onClick, ...anchor } = handle.anchorProps;
  return (
    <>
      <FloorFace name={props.name} form={props.form} onClick={onClick} anchor={anchor} />
      <Popover handle={handle} side="below" bound={viewportBound} title={FLOORS_GROUP}>
        <FloorsMenuBody onDone={() => handle.close("pick")} />
      </Popover>
    </>
  );
}

function FloorSheet(props: { name: string }) {
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <FloorFace
        name={props.name}
        form="icon"
        onClick={() => setOpen(true)}
        anchor={{
          ref: (el) => void (opener.current = el),
          "aria-haspopup": "dialog",
          "aria-expanded": open,
        }}
      />
      {open ? <FloorsSheetDialog opener={opener} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Anchor = { ref?(el: HTMLElement | null): void; "aria-haspopup"?: "dialog" | "menu" | boolean; "aria-expanded"?: boolean; "aria-controls"?: string; onKeyDown?(e: KeyboardEvent): void };

function FloorFace(props: { name: string; form: "name" | "icon"; onClick(e: { detail: number }): void; anchor: Anchor }) {
  const label = floorButtonLabel(props.name);
  const keys = useFloorKeys();
  const tooltip = useTooltip(keys.tip, { describes: addsWords(keys.tip, label) });
  const withName = props.form === "name";
  return (
    <span style={{ flex: "none", display: "flex" }}>
      <button
        type="button"
        aria-label={label}
        aria-keyshortcuts={keys.aria}
        {...{ [FLOOR_ROOT_ATTR]: FLOOR_ROOTS.button }}
        {...props.anchor}
        {...tooltip.anchor()}
        onClick={props.onClick}
        style={withName ? NAMED : SQUARE}
      >
        <Icon name="floors" />
        {withName ? (
          <span aria-hidden data-floor-name="" style={{ minWidth: 0, maxWidth: FLOOR_NAME_MAX_PX, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {props.name}
          </span>
        ) : null}
      </button>
      {tooltip.tip}
    </span>
  );
}

const BASE: CSSProperties = {
  flex: "none",
  height: theme.touch,
  border: `${theme.line.border}px solid transparent`,
  borderRadius: theme.radius.md,
  background: "transparent",
  color: theme.color.text,
  cursor: "pointer",
};

/** The icon alone, 44 px square as the bar's other buttons. */
const SQUARE: CSSProperties = { ...BASE, display: "grid", placeItems: "center", width: theme.touch, padding: 0 };

/** The icon and the floor's name, as wide as the name, up to FLOOR_NAME_MAX_PX of it. */
const NAMED: CSSProperties = {
  ...BASE,
  display: "flex",
  alignItems: "center",
  gap: theme.space(1.5),
  padding: `0 ${theme.space(2)}px`,
  fontFamily: theme.font.body,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
};
