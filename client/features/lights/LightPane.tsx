import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Light } from "#shared/model.ts";
import { MAX_LIGHT_FT } from "#shared/model.ts";
import { MAX_NAME, type LightInput } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import { useSheetSwipe } from "../../lib/sheetSwipe.ts";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { paneDockFits, useAlertsLane, usePublishPaneLane } from "../../pages/fold.ts";
import { PaneDockRow, usePaneDock } from "../../pages/RoomDock.tsx";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { lightCaption, lightSlot } from "../builder/lightTap.ts";
import { paneEscape, panePlacement, sheetPanAnchor, SHEET_BELOW_PX } from "../builder/labelEdit.ts";
import { labelPaneFrame, PANE_HEIGHT_UNMEASURED } from "../builder/labelPaneFrame.ts";
import { PaneFooter } from "../builder/PaneFooter.tsx";
import { requestPan } from "../encounter/pan.ts";
import { ConfirmButton, OptButton } from "../measure/controls.tsx";
import { NumberInput } from "../scenes/controls.tsx";
import { PLACED_LIGHTS, presetOf } from "../vision/presets.ts";
import { lightScreenBox } from "./paneBox.ts";
import { cleanLabel, patched } from "./rules.ts";

/**
 * A light's pane in the builder's Light mode (docs/design-v1-maps-vision.md
 * section 4.3.1), for the DM: its radii, on or off, whether walls cast
 * shadows from it, its name, and Delete. It hangs beside the light on a
 * wide screen and is a bottom sheet on a phone, as a label's pane is
 * (builder/labelEdit.ts panePlacement).
 *
 * Each choice is one `build.lights` op as it is made, so the DM sees the
 * reach change at once and undo takes back one choice. The name is sent
 * when the field is left or Enter is pressed, not for every letter.
 */
export default function LightPane(props: { light: Light; camera: Camera; viewport: Size; insets: Insets; onClose(): void }) {
  const { light, camera } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useBackClose(true, () => closeRef.current());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editing = target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const escape = paneEscape({
        key: e.key,
        handled: e.defaultPrevented,
        dialogOpen: document.querySelector('[aria-modal="true"]') !== null,
        editingElsewhere: editing && !paneRef.current?.contains(target),
      });
      if (!escape) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const box = lightScreenBox(light, camera);
  // As a bottom sheet it folds the alerts column, so its header and Close stay in reach, and their summary row docks on its top edge in room kept free under the top bars, and a toast that shows meanwhile starts under its header (pages/RoomDock.tsx usePaneDock).
  // As a card it keeps left of the column's cards, or under the summary row it has the column show where the lane leaves it no room (labelEdit.ts panePlacement).
  const sheet = props.viewport.width < SHEET_BELOW_PX;
  const dock = usePaneDock(sheet, paneDockFits({ viewport: props.viewport, insets: props.insets }), paneRef);
  const insets = dock.reserve > 0 ? { ...props.insets, top: props.insets.top + dock.reserve } : props.insets;
  const lane = useAlertsLane(props.viewport);
  const place = panePlacement({ viewport: props.viewport, insets, box, height: height ?? PANE_HEIGHT_UNMEASURED, lane });
  usePublishPaneLane(place.kind === "card" ? (place.lane ?? null) : null, () => closeRef.current());

  // A bottom sheet brings its light into view above it, once per light, so a later pan away is the DM's to keep.
  const scope = useRoomScope();
  const pannedFor = useRef<string | null>(null);
  useEffect(() => {
    if (place.kind !== "sheet" || height === null || pannedFor.current === light.id) return;
    pannedFor.current = light.id;
    const anchor = sheetPanAnchor({ viewport: props.viewport, insets, sheetHeight: height, box });
    if (anchor) requestPan(scope, { sceneId: light.sceneId, x: light.x, y: light.y, anchor });
  });

  // As a bottom sheet it swipes down to close, as its close does. Each choice is sent as it is made and its name on blur, so the focus rule alone holds it (docs/design-v1-sheet-swipe.md 4.6).
  useSheetSwipe(paneRef, { enabled: sheet, onClose: () => closeRef.current(), item: light.id, clip: "foot", riders: dock.riders });

  return (
    <>
      <div ref={paneRef} role="dialog" aria-label="Edit light" data-map-pane="" style={{ ...labelPaneFrame(place), overflowY: "auto", overscrollBehavior: "contain", color: theme.color.text }}>
        {/* Keyed by light, so a half-typed name or an armed Delete never carries over to the next light tapped. */}
        <LightEditor key={light.id} light={light} onClose={props.onClose} sheet={sheet} />
      </div>
      {dock.summary && place.kind === "sheet" ? <PaneDockRow ref={dock.row} pane={paneRef} bottom={place.bottom} summary={dock.summary} onClose={() => closeRef.current()} /> : null}
    </>
  );
}

function LightEditor(props: { light: Light; onClose(): void; sheet: boolean }) {
  const { light } = props;
  const actions = useRoomActions();
  const scope = useRoomScope();
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const put = (patch: Partial<Omit<LightInput, "id">>) => actions.dispatch({ t: "build.lights", sceneId: light.sceneId, put: [patched(light, patch)] });
  const [name, setName] = useState(light.label ?? "");
  useEffect(() => {
    setName(light.label ?? "");
  }, [light.label]);
  const saveName = () => {
    const label = cleanLabel(name);
    if (label !== light.label) put({ label });
    else setName(light.label ?? "");
  };
  // A light still named after its preset takes the next preset's name. A name the DM gave it stays.
  const presetNamed = !light.label || PLACED_LIGHTS.some((p) => p.name === light.label);
  const chosen = presetOf(light, PLACED_LIGHTS, light.label);

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <PaneHeader title={light.label || "Light"} onClose={props.onClose} grab={props.sheet} />
      <Help>{lightCaption({ ...light, label: undefined }, feetPerCell)}</Help>
      <div role="group" aria-label="Light sources" style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        {PLACED_LIGHTS.map((p) => (
          <OptButton
            key={p.name}
            label={`${p.name}: ${p.bright} ft bright, dim for ${p.dim} ft beyond`}
            pressed={chosen?.name === p.name}
            onClick={() => put({ bright: p.bright, dim: p.dim, ...(presetNamed ? { label: p.name } : {}) })}
          >
            {p.name}
          </OptButton>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <span style={{ color: theme.color.textMuted }}>Bright</span>
        <NumberInput label="Bright Light, feet" value={light.bright} min={0} max={MAX_LIGHT_FT} onChange={(bright) => put({ bright })} />
        <span style={{ color: theme.color.textMuted }}>ft, dim for</span>
        <NumberInput label="Dim Light beyond it, feet" value={light.dim} min={0} max={MAX_LIGHT_FT} onChange={(dim) => put({ dim })} />
        <span style={{ color: theme.color.textMuted }}>ft beyond</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <Segmented<"on" | "off">
          label="Light on or off"
          value={light.on ? "on" : "off"}
          onChange={(v) => put({ on: v === "on" })}
          options={[
            { value: "on", label: "Lit" },
            { value: "off", label: "Out" },
          ]}
        />
        <OptButton label="Walls block this light. Off, it shines through them." pressed={light.walls} onClick={() => put({ walls: !light.walls })}>
          Walls cast shadows
        </OptButton>
      </div>
      <div onBlur={saveName}>
        <Input
          type="text"
          aria-label="Name"
          placeholder="Name, such as Brazier"
          maxLength={MAX_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName();
          }}
          style={{ width: "100%" }}
        />
      </div>
      <PaneFooter>
        <ConfirmButton
          icon="delete"
          iconOnly
          label="Delete"
          confirm="Tap again to delete"
          title="Delete this light"
          onConfirm={() => {
            actions.dispatch({ t: "build.lights", sceneId: light.sceneId, remove: [light.id] });
            scope.get(lightSlot).setState({ lightId: null, dragTo: null });
            props.onClose();
          }}
        />
        <Button size="sm" variant="primary" onClick={props.onClose}>
          Done
        </Button>
      </PaneFooter>
    </div>
  );
}
