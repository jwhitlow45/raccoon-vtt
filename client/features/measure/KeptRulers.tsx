import { useMemo } from "react";
import { Icon } from "../../components/Icon.tsx";
import type { Drawing, RoomState } from "#shared/model.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { OptButton, OptionsRow } from "./controls.tsx";
import { formatFeet, keptStops, measureStops } from "./ruler.ts";

/**
 * The kept rulers this member may remove (features section 4): their own,
 * and every one for the DM, the same rule as erasing drawings. A tap
 * removes one, and Remove all takes them in one undo step. They are listed
 * here rather than picked on the map, where a tap with the ruler tool
 * already starts a ruler or adds a waypoint.
 */

const EMPTY: RoomState["drawings"] = {};

export function KeptRulers(props: { role: "dm" | "player" }) {
  const drawings = useRoomView((s) => s.view?.drawings ?? EMPTY);
  const sceneId = useRoomView((s) => s.sceneId);
  const youId = useRoomView((s) => s.you?.memberId ?? null);
  const members = useRoomView((s) => s.view?.members);
  const tokens = useRoomView((s) => s.view?.tokens);
  const settings = useRoomView((s) => s.view?.meta.settings);
  const actions = useRoomActions();
  const kept = useMemo(
    () =>
      Object.values(drawings)
        .filter((d): d is Drawing => !!d && d.kind === "ruler" && d.sceneId === sceneId && (props.role === "dm" || d.ownerId === youId))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    [drawings, sceneId, youId, props.role],
  );
  if (kept.length === 0 || !tokens || !settings) return null;

  const describe = (d: Drawing) => {
    const total = formatFeet(measureStops(keptStops(d), tokens, settings).totalFt);
    const owner = d.ownerId === youId ? null : (members?.[d.ownerId]?.name ?? "Someone");
    return [owner, total, d.visibility === "dm" ? "only DMs see it" : null].filter(Boolean).join(" · ");
  };
  return (
    <OptionsRow label="Kept rulers">
      {kept.map((d) => {
        const text = describe(d);
        return (
          <OptButton key={d.id} tone="danger" label={`Remove the kept ruler: ${text}`} onClick={() => actions.dispatch({ t: "drawing.delete", drawingId: d.id })}>
            {text}
            <Icon name="close" size="sm" />
          </OptButton>
        );
      })}
      {kept.length > 1 ? (
        <OptButton tone="danger" onClick={() => dispatchGesture(actions, kept.map((d) => ({ t: "drawing.delete" as const, drawingId: d.id })))}>
          Remove all
        </OptButton>
      ) : null}
    </OptionsRow>
  );
}
