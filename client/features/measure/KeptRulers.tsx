import { useMemo } from "react";
import type { Drawing, RoomState } from "#shared/model.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { OptButton, ValueChip } from "./controls.tsx";
import { formatFeet, keptStops, measureStops } from "./ruler.ts";

/**
 * The kept rulers this member may remove (features section 4): their own,
 * and every one for the DM, the same rule as erasing drawings. A tap
 * removes one, and Remove all takes them in one undo step. They are listed
 * here rather than picked on the map, where a tap with the ruler tool
 * already starts a ruler or adds a waypoint.
 *
 * They sit behind a chip in the Ruler's row, "Kept rulers (2)", whose
 * setting popover holds one danger row per ruler (docs/design-v1-tool-options.md
 * 9.2), the eraser before its words as Clear has it, and at the left as
 * ⋯'s rows are (docs/design-v1-look-pass-2.md D17). The popover stays open
 * as rulers go, and closes with its chip when none is left.
 */

const EMPTY: RoomState["drawings"] = {};

export type KeptRuler = { id: string; text: string };

/** The kept rulers on this scene this member may remove, oldest first, each described as its button says it. */
export function useKeptRulers(role: "dm" | "player"): KeptRuler[] {
  const drawings = useRoomView((s) => s.view?.drawings ?? EMPTY);
  const sceneId = useRoomView((s) => s.sceneId);
  const youId = useRoomView((s) => s.you?.memberId ?? null);
  const members = useRoomView((s) => s.view?.members);
  const tokens = useRoomView((s) => s.view?.tokens);
  const settings = useRoomView((s) => s.view?.meta.settings);
  return useMemo(() => {
    if (!tokens || !settings) return [];
    const kept = Object.values(drawings)
      .filter((d): d is Drawing => !!d && d.kind === "ruler" && d.sceneId === sceneId && (role === "dm" || d.ownerId === youId))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const describe = (d: Drawing) => {
      const total = formatFeet(measureStops(keptStops(d), tokens, settings).totalFt);
      const owner = d.ownerId === youId ? null : (members?.[d.ownerId]?.name ?? "Someone");
      return [owner, total, d.visibility === "dm" ? "only DMs see it" : null].filter(Boolean).join(" · ");
    };
    return kept.map((d) => ({ id: d.id, text: describe(d) }));
  }, [drawings, sceneId, youId, members, tokens, settings, role]);
}

/** "Kept rulers (2)", or "Kept (2)" where the row is short, with room for two digits so a count never moves its neighbors. */
export function KeptRulersChip(props: { kept: readonly KeptRuler[] }) {
  const actions = useRoomActions();
  const { kept } = props;
  const count = kept.length;
  return (
    <ValueChip
      label="Kept rulers"
      kind="setting"
      plain
      value="count"
      options={[
        { key: "count", words: `Kept rulers (${count})` },
        { key: "widest", words: "Kept rulers (88)" },
      ]}
      short={`Kept (${count})`}
      title={`Kept rulers (${count})`}
    >
      <div role="group" aria-label="Kept rulers" style={{ display: "grid", gap: theme.space(1) }}>
        {kept.map((d) => (
          <OptButton key={d.id} tone="danger" icon="eraser" row label={`Remove the kept ruler: ${d.text}`} onClick={() => actions.dispatch({ t: "drawing.delete", drawingId: d.id })}>
            {d.text}
          </OptButton>
        ))}
        {count > 1 ? (
          <OptButton tone="danger" icon="eraser" row onClick={() => dispatchGesture(actions, kept.map((d) => ({ t: "drawing.delete" as const, drawingId: d.id })))}>
            Remove all
          </OptButton>
        ) : null}
      </div>
    </ValueChip>
  );
}
