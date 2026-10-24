import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { actorOf, characterIdOf } from "../combat/logic.ts";

type Legendary = { actionsMax: number; actionsUsed: number; resistMax: number; resistUsed: number };

/**
 * The DM's legendary counts used, set by hand (docs/design-v1-token-sections.md
 * 3.1): "Legendary Actions used" and "Legendary Resistances used today",
 * each a line of words over its pips. They stand under the creature's uses
 * list, in its tracker row's Uses group and its Combat section alike, as
 * the one control for the counts used. Nothing for a creature with no
 * legendary counts.
 */
export function LegendaryPips(props: { target: ActorTarget }) {
  const actions = useRoomActions();
  const legendary = useRoomView((s) => (s.view ? actorOf(s.view, props.target)?.legendary : undefined));
  const characterId = useRoomView((s) => (s.view ? characterIdOf(s.view, props.target) : undefined));
  if (!legendary || (legendary.actionsMax <= 0 && legendary.resistMax <= 0)) return null;
  const set = (next: Legendary) => {
    actions.dispatch(legendaryPatch(props.target, characterId, next));
  };
  return (
    <>
      {legendary.actionsMax > 0 ? <Pips label="Legendary Actions used" max={legendary.actionsMax} used={legendary.actionsUsed} onChange={(actionsUsed) => set({ ...legendary, actionsUsed })} /> : null}
      {legendary.resistMax > 0 ? <Pips label="Legendary Resistances used today" max={legendary.resistMax} used={legendary.resistUsed} onChange={(resistUsed) => set({ ...legendary, resistUsed })} /> : null}
    </>
  );
}

/** The counts' write: on the character a token plays, where its actor lives, else on the token itself. */
function legendaryPatch(target: ActorTarget, characterId: string | undefined, legendary: Legendary): ClientOp {
  if (characterId !== undefined) return { t: "character.update", characterId, patch: { actor: { legendary } } };
  if ("tokenId" in target) return { t: "token.update", tokenId: target.tokenId, patch: { actor: { legendary } } };
  return { t: "character.update", characterId: target.characterId, patch: { actor: { legendary } } };
}

/**
 * Tap a pip to mark that many used. Tapping the last used pip gives one
 * back. The pips wrap under their words with fixed 44 px targets, so a
 * count of 10 stays inside a phone's row (D-261024-40): one row of pips
 * that never wrapped ran six past the tracker's room at 320 px. Each pip is
 * round, focus ring and all, so a lone pip on the last row reads as one of
 * the set.
 */
export function Pips(props: { label: string; max: number; used: number; onChange(used: number): void }) {
  return (
    <div data-pips="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>
        {props.label}: {props.used} of {props.max}
      </span>
      <div role="group" aria-label={props.label} style={{ display: "flex", flexWrap: "wrap" }}>
        {Array.from({ length: props.max }, (_, i) => {
          const filled = i < props.used;
          return (
            <button
              key={i}
              type="button"
              aria-label={`${i + 1} used`}
              aria-pressed={filled}
              onClick={() => props.onChange(props.used === i + 1 ? i : i + 1)}
              style={{
                flex: "none",
                width: theme.touch,
                height: theme.touch,
                padding: 0,
                display: "grid",
                placeItems: "center",
                background: "transparent",
                border: "none",
                borderRadius: theme.radius.round,
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: theme.radius.round,
                  border: `${theme.line.strong}px solid ${theme.color.accent}`,
                  background: filled ? theme.color.accent : "transparent",
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
