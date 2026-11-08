import { Button } from "../../components/Button.tsx";
import { Notice } from "../../components/Notice.tsx";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useIsDisplay, useRoomActions, useRoomView } from "../../state/view.ts";
import { usePreview } from "../dm/previewContext.ts";
import { floorRoot, FLOOR_ROOT_ATTR, FLOOR_ROOTS } from "./ids.ts";
import { backLabel, viewingLine } from "./words.ts";

/**
 * The Viewing notice (docs/design/design-v1-floors.md 7.3, 7.9): while a
 * player shows a floor other than the one their device follows, one line
 * says "Viewing Upper floor." with Back to Thorn in its row, among the
 * notices under the top bar. Back shows their creature's floor again, or
 * the start floor where they have no creature there. Focus goes to the
 * Floor button, the control that picks floors, since the notice leaves
 * with the switch. A DM picks every floor they see and a display follows
 * the party, so neither has one.
 */
export function ViewingNotice() {
  const role = useRoomView((s) => s.you?.role);
  const display = useIsDisplay();
  const preview = usePreview() !== null;
  const actions = useRoomActions();
  const shown = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId] : undefined));
  const follow = useRoomView((s) => s.floorFollow ?? null);
  const back = useRoomView((s) => {
    const to = s.floorFollow;
    if (!to) return null;
    const token = to.tokenId ? s.view?.tokens[to.tokenId] : undefined;
    if (token) return displayName(token);
    return to.sceneId ? (s.view?.scenes[to.sceneId]?.floor?.name ?? null) : null;
  });
  if (role !== "player" || display || preview || !shown?.floor || !follow || follow.sceneId === shown.id || back === null) return null;
  return (
    <div {...{ [FLOOR_ROOT_ATTR]: FLOOR_ROOTS.notice }} style={{ pointerEvents: "auto", width: "100%", maxWidth: theme.layout.notice, minWidth: 0 }}>
      {/* No live region of its own: the status already says "Showing Upper floor." as the switch comes (useFloorVoice). */}
      <Notice
        float
        action={
          <Button
            size="sm"
            onClick={() => {
              // The notice goes with the switch, so focus waits on the control that picks floors.
              document.querySelector<HTMLElement>(`[data-rvtt-topbar] ${floorRoot(FLOOR_ROOTS.button)}`)?.focus({ preventScroll: true });
              actions.showFloor(null);
            }}
          >
            {backLabel(back)}
          </Button>
        }
      >
        {/* The floor's name is the news, so a narrow screen wraps it under "Viewing" rather than cut it. */}
        <span style={{ display: "block", overflowWrap: "anywhere" }}>{viewingLine(shown.floor.name)}</span>
      </Notice>
    </div>
  );
}
