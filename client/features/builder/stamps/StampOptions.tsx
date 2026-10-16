import { useCallback, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Icon } from "../../../components/Icon.tsx";
import { useAssets, useRoomActions, useRoomView } from "../../../state/view.ts";
import { ConfirmButton, OptButton, PopoverSwatches, ValueChip, type Slot } from "../../measure/controls.tsx";
import { stampUrl } from "./draw.ts";
import { duplicateOf, sceneStamps, TINTS, toInput, topZ, type ChosenArt } from "./rules.ts";
import { StampPicker } from "./StampPicker.tsx";
import { useStampStore } from "./store.ts";

/**
 * The tint swatch for no tint: an empty ring, since the stamp then shows
 * its own colors. Swatches takes a color for every option, and this one
 * draws nothing.
 */
const NO_TINT = "transparent";

const TINT_OPTIONS = [{ color: NO_TINT, name: "None" }, ...TINTS.map((t) => ({ color: t.color, name: t.name }))];

/** The chooser's name, cut past this width so a long stamp name never crowds the row. */
const CHOOSER_NAME_MAX = 160;

/**
 * Stamp mode's slots in the builder's row (design 3.5,
 * docs/design-v1-tool-options.md 9.9): the stamp the next tap places and
 * Snap, and for the selected stamp its tint, Flip, Bring to front,
 * Duplicate, who sees it, Delete and Done, a task of their own that comes
 * after a 1 px line. Each button sends one op, so the row's Undo takes back
 * one change at a time. What does not fit waits behind ⋯ at every width,
 * and the map stays live while a tint is picked.
 *
 * `picker` is the stamp picker, a modal dialog drawn outside the row, since
 * the chooser may stand in ⋯. Focus comes back to the chooser where it is
 * drawn, else to ⋯.
 */
export function useStampSlots(input: { more(): HTMLElement | null }): { slots: Slot[]; picker: ReactNode; selected: boolean } {
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
  const chooser = useRef<HTMLButtonElement>(null);
  const more = input.more;
  // The chooser where it is drawn, else ⋯, whose popover held it.
  const opener = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return chooser.current?.isConnected ? chooser.current : more();
      },
    }),
    [more],
  );

  const selected = stamp && stamp.sceneId === sceneId ? stamp : null;
  const put = (s: NonNullable<typeof selected>) => actions.dispatch({ t: "build.stamps", sceneId: s.sceneId, put: [toInput(s)] });
  const others = selected ? sceneStamps(allStamps, selected.sceneId).filter((s) => s.id !== selected.id) : [];
  const onTop = selected ? others.every((s) => s.z < selected.z) : true;
  const thumb = chosen ? stampUrl(chosen.art, "key" in chosen.art ? assets : { url: (id) => assets.url(id, "thumb") }) : null;
  const thumbImg = thumb ? <img src={thumb} alt="" width={28} height={28} style={{ objectFit: "contain", display: "block" }} /> : null;
  const chooserTitle = chosen ? `Placing ${chosen.name}. Choose another stamp` : "Choose a stamp to place";
  const picker = pickerOpen ? <StampPicker chosen={chosen} onPick={pick} onMeasured={measured} onClose={close} opener={opener} /> : null;
  const task = selected !== null && bounds !== undefined;

  const slots: Slot[] = [
    {
      id: "chooser",
      priority: task ? 4 : 1,
      compact: true,
      control: (
        // Choosing a stamp is the first thing to do here, so it is the row's main action until one is chosen.
        <OptButton ref={chooser} label={chooserTitle} tone={chosen ? undefined : "primary"} short={thumbImg ?? <Icon name="plus" size="sm" />} onClick={() => store.setState({ pickerOpen: true })}>
          {thumbImg}
          <span style={{ display: "block", maxWidth: CHOOSER_NAME_MAX, overflow: "hidden", textOverflow: "ellipsis" }}>{chosen ? chosen.name : "Choose a stamp"}</span>
        </OptButton>
      ),
    },
    {
      id: "snap",
      priority: task ? 5 : 2,
      control: (
        <OptButton label="Turn in 15 degree steps and move in half cells" pressed={snap} onClick={() => store.setState({ snap: !snap })}>
          Snap
        </OptButton>
      ),
    },
  ];
  if (selected && bounds) {
    const tintName = TINT_OPTIONS.find((t) => t.color === (selected.tint ?? NO_TINT))?.name ?? "None";
    const part = "stamp";
    slots.push(
      {
        id: "tint",
        priority: 2,
        part,
        control: (
          <ValueChip label="Tint" kind="choice" value={selected.tint ?? NO_TINT} valueName={tintName} disk={selected.tint ?? NO_TINT} options={TINT_OPTIONS.map((t) => ({ key: t.color, words: t.name }))}>
            <PopoverSwatches label="Tint" value={selected.tint ?? NO_TINT} options={TINT_OPTIONS} onChange={(color) => put({ ...selected, tint: color === NO_TINT ? undefined : color })} />
          </ValueChip>
        ),
      },
      {
        id: "flip",
        priority: 3,
        part,
        control: (
          <OptButton label="Mirror it" pressed={!!selected.flip} onClick={() => put({ ...selected, flip: !selected.flip })}>
            Flip
          </OptButton>
        ),
      },
      {
        id: "front",
        priority: 5,
        part,
        control: (
          <OptButton disabled={onTop} onClick={() => put({ ...selected, z: topZ(others) })}>
            Bring to front
          </OptButton>
        ),
      },
      {
        id: "duplicate",
        priority: 4,
        part,
        control: (
          <OptButton
            onClick={() => {
              const id = actions.newId();
              actions.dispatch({ t: "build.stamps", sceneId: selected.sceneId, put: [duplicateOf(selected, id, topZ([...others, selected]), bounds)] });
              store.setState({ selectedId: id });
            }}
          >
            Duplicate
          </OptButton>
        ),
      },
      {
        id: "stampDmOnly",
        priority: 3,
        part,
        control: (
          <OptButton label="Hide it from players" pressed={selected.visibility === "dm"} onClick={() => put({ ...selected, visibility: selected.visibility === "dm" ? "all" : "dm" })}>
            DM only
          </OptButton>
        ),
      },
      {
        id: "delete",
        priority: 2,
        part,
        compact: true,
        control: (
          <ConfirmButton
            label="Delete"
            confirm="Tap again to delete"
            short="Delete?"
            title="Delete this stamp"
            onConfirm={() => {
              actions.dispatch({ t: "build.stamps", sceneId: selected.sceneId, remove: [selected.id] });
              store.setState({ selectedId: null });
            }}
          />
        ),
      },
      {
        id: "stampDone",
        priority: 1,
        part,
        control: (
          <OptButton label="Let go of this stamp" ends onClick={() => store.setState({ selectedId: null })}>
            Done
          </OptButton>
        ),
      },
    );
  }
  return { slots, picker, selected: task };
}
