import { useEffect, useLayoutEffect, type RefObject } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { Popover, usePopover, type Rect } from "../../../components/Popover.tsx";
import { addsWords, useTooltip } from "../../../components/Tooltip.tsx";
import { theme } from "../../../lib/theme.ts";
import { useKeyHint, withKey } from "../../../state/shortcuts.ts";
import { useRoomView } from "../../../state/view.ts";
import { uiScale } from "../../device/settings.ts";
import { SheetDialog } from "../../tokens/SheetDialog.tsx";
import { useDeviceVolume, useServerRoomSoundState, useSoundHere } from "../engine/store.ts";
import { POPOVER_BODY_PX } from "../mini/NowChip.tsx";
import { speakerName, VOLUME, volumeNote } from "../panel/words.ts";
import { DeviceSound, volumeIcon } from "./DeviceSound.tsx";

/*
 * The top bar's speaker (docs/design/design-v1-volume.md 3): this device's
 * volume in reach for the DM and players, right of the room's Now playing.
 * Its icon is the device's state, muted, low or loud. It opens Volume, the
 * controls of DeviceSound, as a popover under it from 900 px up, and as a
 * card or a sheet below through the room's chip dialogs, which the DM
 * menu's and the You menu's Volume open too once the speaker has left the
 * bar (pages/topBarFit.ts volumeFold). The bar places it and folds it.
 */

/** The level as the menus' Volume row notes it, "80%" or "Muted", while the speaker is off the bar. */
export function useVolumeNote(): string {
  return volumeNote(useDeviceVolume());
}

function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

/**
 * What the controls show that moves their height: the status line and
 * whether Music and Background are hidden. A change places the popover
 * again, as Now playing's player does for its body.
 */
function useControlsShape(): string {
  const { here } = useSoundHere();
  const server = useServerRoomSoundState();
  const dmOnly = useRoomView((s) => s.view?.meta.settings.soundDmOnly === true);
  return `${here}:${server === "off"}:${dmOnly}`;
}

/**
 * The speaker: a 44 px icon button in the bar's own IconButton shape
 * (pages/RoomChrome.tsx), in the text color, muted text while muted. Its
 * tooltip names U, the key that mutes and unmutes here (state/shortcuts.ts). From
 * 900 px up (`popover`) it anchors a dialog popover, below it hands
 * itself to `openDialog` as the card's or sheet's return focus. `onOpen`
 * hears the popover, so the bar stands over the notices while it is open.
 */
export function Speaker(props: { popover: boolean; dialogOpen: boolean; onOpen?(open: boolean): void; openDialog(from: HTMLElement | null): void }) {
  const volume = useDeviceVolume();
  const pop = usePopover({ kind: "dialog" });
  const keys = useKeyHint("mute");
  const name = speakerName(volume);
  // The name carries the level for a reader, and the tooltip the key, said only where it adds to the name (as the bar's IconButton does).
  const tipText = withKey(VOLUME, keys);
  const tip = useTooltip(tipText, { describes: addsWords(tipText, name) });
  const shape = useControlsShape();
  const { onOpen } = props;
  // In a layout effect, so the bar stands over the notices in the commit that shows the popover (VA3-NOTICE-FLAKE).
  useLayoutEffect(() => onOpen?.(pop.open), [pop.open, onOpen]);
  useLayoutEffect(() => () => onOpen?.(false), [onOpen]);
  // Under 900 px it opens a card or a sheet instead, so a turn of the window closes the popover.
  const { open: popOpen, close: popClose } = pop;
  useEffect(() => {
    if (!props.popover && popOpen) popClose("state");
  }, [props.popover, popOpen, popClose]);
  const icon = volumeIcon(volume);
  const opens = props.popover ? pop.anchorProps : { "aria-haspopup": "dialog" as const, "aria-expanded": props.dialogOpen, onClick: (e: { currentTarget: HTMLElement }) => props.openDialog(e.currentTarget) };
  return (
    <span style={{ flex: "none", display: "flex" }}>
      <button
        type="button"
        data-volume-button=""
        data-volume-icon={icon}
        aria-label={name}
        aria-keyshortcuts={keys?.aria}
        {...tip.anchor()}
        {...opens}
        style={{
          flex: "none",
          display: "grid",
          placeItems: "center",
          width: theme.touch,
          height: theme.touch,
          padding: 0,
          border: `${theme.line.border}px solid transparent`,
          borderRadius: theme.radius.md,
          background: "transparent",
          color: volume.muted ? theme.color.textMuted : theme.color.text,
          cursor: "pointer",
        }}
      >
        <Icon name={icon} />
      </button>
      {tip.tip}
      {props.popover ? (
        <Popover handle={pop} side="below" flip bound={viewportBound} title={VOLUME} contentKey={shape}>
          <div style={{ width: POPOVER_BODY_PX, maxWidth: "100%", minWidth: 0 }}>
            <DeviceSound line />
          </div>
        </Popover>
      ) : null}
    </span>
  );
}

/**
 * Volume as a card from 600 px and a sheet below, drawn by the room's chip
 * dialogs (pages/ChipMenus.tsx ChipDialogs): opened by the speaker under
 * 900 px and by the DM menu's or the You menu's Volume once the speaker
 * has left the bar. Focus goes back to what opened it.
 */
export function VolumeDialog(props: { opener: RefObject<HTMLElement | null>; onClose(): void }) {
  return (
    <SheetDialog title={VOLUME} opener={props.opener} onClose={props.onClose} width={theme.layout.dialog.sm}>
      <DeviceSound line />
    </SheetDialog>
  );
}
