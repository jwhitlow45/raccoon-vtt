import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FloorLink } from "#shared/model.ts";
import { linkDir } from "#shared/rules/floorLinks.ts";
import { Button } from "../../components/Button.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { Switch } from "../../components/Switch.tsx";
import { useBackClose } from "../../lib/backClose.ts";
import type { Camera, Insets, Size } from "../../lib/camera.ts";
import { isCoarsePointer } from "../../lib/device.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { theme } from "../../lib/theme.ts";
import { paneDockFits, useAlertsLane, usePublishPaneLane } from "../../pages/fold.ts";
import { PaneDockRow, usePaneDock } from "../../pages/RoomDock.tsx";
import { useSheetSwipe } from "../../lib/sheetSwipe.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { requestPan } from "../encounter/pan.ts";
import { LINK_PANE_ATTR } from "../floors/ids.ts";
import { goToFloor, KIND_GROUP, KIND_NAMES, LOCKED_SWITCH, lockedHelp, notReachedLine, paneTitle, REMOVE_BOTH, removeWords } from "../floors/linkWords.ts";
import { ConfirmButton } from "../scenes/controls.tsx";
import { playersAt } from "../scenes/floorWords.ts";
import { trapScreenBox } from "../traps/paneBox.ts";
import { boxCenter, zoneBox } from "../traps/rules.ts";
import { paneEscape, panePlacement, sheetPanAnchor, SHEET_BELOW_PX } from "./labelEdit.ts";
import { labelPaneFrame, PANE_HEIGHT_UNMEASURED } from "./labelPaneFrame.ts";
import { linkPaneSlot } from "./store.ts";

const KINDS = (["stairs", "ladder"] as const).map((value) => ({ value, label: KIND_NAMES[value] }));

/**
 * An end's pane in Between floors (docs/design/design-v1-floors.md phase 2,
 * 7.2), for the DM: its kind, whether it is locked, where players stand with
 * the floor it leads to, Go to that floor, and Remove. It hangs beside the
 * squares on a wide screen and is a bottom sheet on a phone, as the label
 * pane is (labelEdit.ts panePlacement).
 *
 * Each choice is sent as it is made, to both ends, as one `floorLink.update`
 * and so one step to undo. The pane opens on Kind, and Escape closes it.
 */
export default function LinkPane(props: { link: FloorLink; camera: Camera; viewport: Size; insets: Insets; onClose(): void }) {
  const { link, camera } = props;
  const paneRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useBackClose(true, () => closeRef.current());
  const scene = useRoomView((s) => s.view?.scenes[link.sceneId]);
  const chunks = useRoomView((s) => s.view?.buildChunks);

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
      // The board takes no focus of its own, so closing lets go of the pane's control and leaves the keys to the room.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** The pane's height once laid out, which placing it and panning to its squares wait for. */
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const grid = sceneGrid({ gridShape: scene?.gridShape });
  const trapLike = { zone: { cells: [link.rect] }, sceneId: link.sceneId };
  const box = trapScreenBox(grid, trapLike, chunks ?? {}, camera);
  const sheet = props.viewport.width < SHEET_BELOW_PX;
  const dock = usePaneDock(sheet, paneDockFits({ viewport: props.viewport, insets: props.insets }), paneRef);
  const insets = dock.reserve > 0 ? { ...props.insets, top: props.insets.top + dock.reserve } : props.insets;
  const lane = useAlertsLane(props.viewport);
  const place = panePlacement({ viewport: props.viewport, insets, box, height: height ?? PANE_HEIGHT_UNMEASURED, lane });
  usePublishPaneLane(place.kind === "card" ? (place.lane ?? null) : null, () => closeRef.current());

  // A bottom sheet brings the squares it opened for into view above it, once per end.
  const scope = useRoomScope();
  const pannedFor = useRef<string | null>(null);
  useEffect(() => {
    if (place.kind !== "sheet" || height === null || pannedFor.current === link.id) return;
    pannedFor.current = link.id;
    const anchor = sheetPanAnchor({ viewport: props.viewport, insets, sheetHeight: height, box });
    const world = zoneBox(grid, trapLike, chunks ?? {});
    if (anchor && world) requestPan(scope, { sceneId: link.sceneId, ...boxCenter(world), anchor });
  });

  const swipe = useSheetSwipe(paneRef, { enabled: sheet, onClose: () => closeRef.current(), item: link.id, clip: "foot", riders: dock.riders });

  return (
    <>
      <div
        ref={paneRef}
        role="dialog"
        aria-label="Edit stairs"
        data-map-pane=""
        {...{ [LINK_PANE_ATTR]: link.id }}
        style={{ ...labelPaneFrame(place), overflowY: "auto", overscrollBehavior: "contain", color: theme.color.text }}
      >
        {/* Keyed by end, so an armed Remove never carries over to the next end tapped. */}
        <LinkEditor key={link.id} link={link} sheet={sheet} onClose={props.onClose} controls={swipe.controls} />
      </div>
      {dock.summary && place.kind === "sheet" ? <PaneDockRow ref={dock.row} pane={paneRef} bottom={place.bottom} summary={dock.summary} onClose={() => closeRef.current()} /> : null}
    </>
  );
}

function LinkEditor(props: { link: FloorLink; sheet: boolean; onClose(): void; controls: Parameters<typeof PaneHeader>[0]["controls"] }) {
  const { link } = props;
  const actions = useRoomActions();
  const scope = useRoomScope();
  const kindRef = useRef<HTMLDivElement>(null);
  const far = useRoomView((s) => s.view?.scenes[link.to]);
  const dir = useRoomView((s) => (s.view ? linkDir(s.view, link) : null)) ?? "up";
  const at = useRoomView((s) => (s.view && far ? playersAt(s.view, far) : null));
  const farName = far?.floor?.name ?? far?.name ?? "the other floor";

  // The pane opens on Kind. A phone would throw its keyboard up over the map for a text field, but a choice takes none, so only a mouse's focus is moved, to keep a touch from a ring.
  useEffect(() => {
    if (isCoarsePointer()) return;
    kindRef.current?.querySelector<HTMLInputElement>("input:checked, input")?.focus();
  }, []);

  const update = (patch: { kind?: FloorLink["kind"]; locked?: boolean }) => actions.dispatch({ t: "floorLink.update", linkId: link.id, patch });
  const goTo = () => {
    actions.showFloor(link.to);
    // The other end, on the floor now shown, is the one whose pane stays open.
    scope.get(linkPaneSlot).setState({ linkId: link.pair });
  };
  const remove = () => {
    actions.dispatch({ t: "floorLink.delete", linkId: link.id });
    props.onClose();
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <PaneHeader title={<span role="heading" aria-level={2}>{paneTitle(dir, link.kind, farName)}</span>} closeLabel="Close" onClose={props.onClose} grab={props.sheet} controls={props.controls} />
      <div ref={kindRef} style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <span style={{ flex: 1, color: theme.color.textMuted }}>{KIND_GROUP}</span>
        <Segmented<FloorLink["kind"]> label={KIND_GROUP} value={link.kind} options={KINDS} onChange={(kind) => update({ kind })} />
      </div>
      <Switch label={LOCKED_SWITCH} help={lockedHelp(link.kind)} checked={link.locked === true} onChange={(locked) => update({ locked })} />
      {at === "not" ? <Help>{notReachedLine(farName, dir, link.kind)}</Help> : null}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: theme.space(2), marginTop: theme.space(1) }}>
        <ConfirmButton label={removeWords(link.kind)} confirm={REMOVE_BOTH} onConfirm={remove} wrap />
        <Button size="sm" variant="primary" onClick={goTo}>
          {goToFloor(farName)}
        </Button>
      </div>
    </div>
  );
}
