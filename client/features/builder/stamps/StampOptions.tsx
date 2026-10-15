import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Stamp } from "#shared/model.ts";
import { Swatches } from "../../../components/Swatches.tsx";
import { theme } from "../../../lib/theme.ts";
import { useLayoutSize } from "../../device/layout.ts";
import { useAssets, useRoomActions, useRoomView } from "../../../state/view.ts";
import { ConfirmButton, OptButton, OptionsDivider } from "../../measure/controls.tsx";
import { stampUrl } from "./draw.ts";
import { duplicateOf, sceneStamps, TINTS, toInput, topZ, type ChosenArt } from "./rules.ts";
import { StampPicker } from "./StampPicker.tsx";
import { StampSheet } from "./StampSheet.tsx";
import { useStampStore } from "./store.ts";

/*
 * Below the wide layout the options bar spans the screen (pages/Room.tsx),
 * and a selected stamp's eight tints, None and five buttons wrapped it to
 * six rows over half a phone's map. There the tint and the less used
 * buttons move into small sheets, so the bar keeps to two rows.
 */
function useNarrowBar(): boolean {
  // The window in the chrome's own pixels, as the Room page lays out (features/device/layout.ts).
  return useLayoutSize().width < theme.layout.wideMinWidth;
}

/** Whether a stamp on this scene is selected on a narrow screen, where the builder's bar leaves out Clear build and the hint. */
export function useCompactStampBar(): boolean {
  const narrow = useNarrowBar();
  const selectedId = useStore(useStampStore(), (s) => s.selectedId);
  const here = useRoomView((s) => {
    const stamp = selectedId ? s.view?.stamps[selectedId] : undefined;
    return !!stamp && stamp.sceneId === s.sceneId;
  });
  return narrow && here;
}

/**
 * The tint swatch for no tint: an empty ring, since the stamp then shows
 * its own colors. Swatches takes a color for every option, and this one
 * draws nothing.
 */
const NO_TINT = "transparent";

const TINT_OPTIONS = [{ color: NO_TINT, name: "None" }, ...TINTS.map((t) => ({ color: t.color, name: t.name }))];

/**
 * Stamp mode's part of the builder's bar (design 3.5): the stamp the next
 * tap places, Snap, and for the selected stamp its tint, Flip, Bring to
 * front, Duplicate, who sees it, and Delete. Each button sends one op, so
 * the bar's Undo takes back one change at a time.
 */
export function StampOptions() {
  const store = useStampStore();
  // Not the gesture's preview, which changes on every frame of a drag.
  const { chosen, selectedId, snap, pickerOpen } = useStore(
    store,
    useShallow((s) => ({ chosen: s.chosen, selectedId: s.selectedId, snap: s.snap, pickerOpen: s.pickerOpen })),
  );
  const sceneId = useRoomView((s) => s.sceneId);
  const bounds = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId]?.bounds : undefined));
  const stamp = useRoomView((s) => (selectedId ? s.view?.stamps[selectedId] : undefined));
  const allStamps = useRoomView((s) => s.view?.stamps);
  const actions = useRoomActions();
  const assets = useAssets();

  const pick = useCallback((next: ChosenArt) => store.setState({ chosen: next, pickerOpen: false }), [store]);
  const measured = useCallback(
    (next: ChosenArt) => {
      const now = store.getState().chosen;
      if (now && "assetId" in now.art && "assetId" in next.art && now.art.assetId === next.art.assetId) store.setState({ chosen: next });
    },
    [store],
  );
  const close = useCallback(() => store.setState({ pickerOpen: false }), [store]);

  const selected = stamp && stamp.sceneId === sceneId ? stamp : null;
  const compact = useCompactStampBar();
  const [sheet, setSheet] = useState<"tint" | "more" | null>(null);
  useEffect(() => {
    if (!compact) setSheet(null);
  }, [compact]);
  const put = (s: Stamp) => actions.dispatch({ t: "build.stamps", sceneId: s.sceneId, put: [toInput(s)] });
  const others = selected ? sceneStamps(allStamps, selected.sceneId).filter((s) => s.id !== selected.id) : [];
  const onTop = selected ? others.every((s) => s.z < selected.z) : true;
  const thumb = chosen ? stampUrl(chosen.art, "key" in chosen.art ? assets : { url: (id) => assets.url(id, "thumb") }) : null;
  const thumbImg = thumb ? <img src={thumb} alt="" width={28} height={28} style={{ objectFit: "contain", display: "block" }} /> : null;
  const chooserTitle = chosen ? `Placing ${chosen.name}. Choose another stamp` : "Choose a stamp to place";
  const openPicker = () => store.setState({ pickerOpen: true });
  // The button that chooses a stamp, compact or not. Focus comes back to it when the picker closes.
  const chooser = useRef<HTMLButtonElement>(null);
  const picker = pickerOpen ? <StampPicker chosen={chosen} onPick={pick} onMeasured={measured} onClose={close} opener={chooser} /> : null;

  const tints = selected ? (
    <Swatches label="Tint" value={selected.tint ?? NO_TINT} options={TINT_OPTIONS} onChange={(color) => put({ ...selected, tint: color === NO_TINT ? undefined : color })} />
  ) : null;
  const more = selected && bounds ? (
    <>
      <OptButton label="Mirror it" pressed={!!selected.flip} onClick={() => put({ ...selected, flip: !selected.flip })}>
        Flip
      </OptButton>
      <OptButton disabled={onTop} onClick={() => put({ ...selected, z: topZ(others) })}>
        Bring to front
      </OptButton>
      <OptButton
        onClick={() => {
          const id = actions.newId();
          actions.dispatch({ t: "build.stamps", sceneId: selected.sceneId, put: [duplicateOf(selected, id, topZ([...others, selected]), bounds)] });
          store.setState({ selectedId: id });
        }}
      >
        Duplicate
      </OptButton>
      <OptButton label="Hide it from players" pressed={selected.visibility === "dm"} onClick={() => put({ ...selected, visibility: selected.visibility === "dm" ? "all" : "dm" })}>
        DM only
      </OptButton>
    </>
  ) : null;
  const finish = selected ? (
    <>
      <ConfirmButton
        label="Delete"
        // The phone's bar has room for two rows only, and the longer words would push Done onto a third.
        confirm={compact ? "Delete?" : "Tap again to delete"}
        title="Delete this stamp"
        onConfirm={() => {
          actions.dispatch({ t: "build.stamps", sceneId: selected.sceneId, remove: [selected.id] });
          store.setState({ selectedId: null });
        }}
      />
      <OptButton label="Let go of this stamp" onClick={() => store.setState({ selectedId: null })}>
        Done
      </OptButton>
    </>
  ) : null;
  // Choosing a stamp is the first thing to do here, so it is the bar's main action until one is chosen.
  const chooserTone = chosen ? undefined : "primary";

  if (compact && selected) {
    const tintName = TINTS.find((t) => t.color === selected.tint)?.name ?? "None";
    return (
      <>
        <OptButton ref={chooser} icon={thumbImg ? undefined : "plus"} label={chooserTitle} tone={chooserTone} onClick={openPicker}>
          {thumbImg}
        </OptButton>
        <OptButton label="Turn in 15 degree steps and move in half cells" pressed={snap} onClick={() => store.setState({ snap: !snap })}>
          Snap
        </OptButton>
        <OptButton label={`Tint: ${tintName}`} onClick={() => setSheet("tint")}>
          <span
            aria-hidden
            style={{
              width: 14,
              height: 14,
              borderRadius: theme.radius.round,
              border: `${theme.line.border}px solid ${theme.color.border}`,
              background: selected.tint ?? "transparent",
            }}
          />
          Tint
        </OptButton>
        <OptButton label="Flip, bring to front, duplicate or hide from players" onClick={() => setSheet("more")}>
          More
        </OptButton>
        {finish}
        {sheet === "tint" ? (
          <StampSheet title="Tint" onClose={() => setSheet(null)}>
            {tints}
          </StampSheet>
        ) : null}
        {sheet === "more" ? (
          <StampSheet title="More" onClose={() => setSheet(null)}>
            {more}
          </StampSheet>
        ) : null}
        {picker}
      </>
    );
  }

  return (
    <>
      <OptButton ref={chooser} label={chooserTitle} tone={chooserTone} onClick={openPicker}>
        {thumbImg}
        {chosen ? chosen.name : "Choose a stamp"}
      </OptButton>
      <OptButton label="Turn in 15 degree steps and move in half cells" pressed={snap} onClick={() => store.setState({ snap: !snap })}>
        Snap
      </OptButton>
      {selected && bounds ? (
        <>
          <OptionsDivider />
          {tints}
          {more}
          {finish}
        </>
      ) : null}
      {picker}
    </>
  );
}
