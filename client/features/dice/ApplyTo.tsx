import { useMemo, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { LogEntry } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { useAskHpFill } from "../tokens/hpDraft.ts";
import { applyNow, fillEntry, NOTHING_YET, useApplyEnv } from "./apply.ts";
import { appliedWords, applyTargets, chipName, offersChips, rollChip, rollOrigin, type ApplyTarget } from "./targets.ts";

/**
 * The chips under one roll's result, its lines as the receipt holds them.
 * Nothing where the roll is no damage, where this viewer gets none
 * (targets.ts offersChips), or once nobody is left to name and nothing is
 * left to say.
 */
export function ApplyTo(props: { lines: readonly LogEntry[]; style?: CSSProperties }) {
  const you = useRoomView((s) => s.you);
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const selected = useRoomView((s) => s.local.selectedIds);
  const local = useRoomView((s) => s.local);
  const ui = useRoomUi();
  const env = useApplyEnv();
  const askFill = useAskHpFill();
  const chip = useMemo(() => rollChip(props.lines), [props.lines]);
  const state = useStore(env.applies, (s) => (chip ? (s.rolls[chip.lineId] ?? NOTHING_YET) : NOTHING_YET));
  const first = props.lines[0]?.data;
  const mine = first?.type === "dice" && you !== null && first.by === you.memberId;
  const offered = you !== null && view !== null && chip !== null && offersChips(you, mine, view.meta.settings.playersApplyDamage);
  const leave = useMemo(() => new Set(state.applied.map((a) => a.holder)), [state.applied]);
  const targets = useMemo(
    () => (offered && view && you ? applyTargets({ view, you, sceneId, origin: rollOrigin(props.lines), selected, leave }) : []),
    [offered, view, you, sceneId, props.lines, selected, leave],
  );
  if (!offered || !chip || !you) return null;
  const dm = you.role === "dm";
  const line = state.said ?? (state.applied.length > 0 ? appliedWords(state.applied.map((a) => a.name)) : "");
  if (targets.length === 0 && line === "") return null;
  const press = (to: ApplyTarget) => {
    if (!dm) return fillEntry(ui, local, askFill, chip, to);
    // A second tap while one waits is refused by the busy state, never sent.
    if (state.busy === null) void applyNow(env, chip, to);
  };
  return (
    <div data-apply-to="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1), ...props.style }}>
      {targets.length > 0 ? (
        // The group says its label, so its visible words are not said twice.
        <div role="group" aria-label="Apply to" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
          <span aria-hidden="true" style={{ fontSize: theme.font.small, color: theme.color.textMuted, marginRight: theme.space(1) }}>
            Apply to
          </span>
          {targets.map((to, i) => (
            <Button
              key={to.holder}
              size="sm"
              // The first is the likeliest target: the nearest enemy, or the first picked.
              variant={i === 0 ? "primary" : "secondary"}
              busy={state.busy === to.holder}
              aria-label={chipName(chip, to.name, dm)}
              onClick={() => press(to)}
              // Each grows to share the line it stands on, so a chip that wraps alone fills its line rather than stand by itself.
              style={{ flex: "1 1 auto", maxWidth: "100%", whiteSpace: "normal", textAlign: "center" }}
            >
              {to.name}
            </Button>
          ))}
        </div>
      ) : null}
      {line ? (
        <p aria-hidden="true" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: state.said ? theme.color.dangerText : theme.color.textMuted, overflowWrap: "anywhere" }}>
          {line}
        </p>
      ) : null}
      {/* Always mounted, so the line is said once as it changes, as an HP Apply's is. */}
      <span role="status" style={VISUALLY_HIDDEN}>
        {line}
      </span>
    </div>
  );
}
