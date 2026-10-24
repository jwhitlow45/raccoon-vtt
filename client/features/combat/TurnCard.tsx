import { useId, type CSSProperties, type Ref } from "react";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { alertCard } from "../encounter/alertCard.ts";
import type { TurnCardModel } from "./alerts.ts";
import { CombatUses } from "./CombatUses.tsx";

/** The id a turn card has in the alerts column and the dock's summary. */
export function turnAlertId(model: TurnCardModel): string {
  return model.id;
}

/** "Adult Red Dragon's turn". */
export function turnTitle(model: Pick<TurnCardModel, "name">): string {
  return `${model.name}'s turn`;
}

/** "3 uses", the count after the title in the folded row's words, "Adult Red Dragon's turn: 3 uses" (4.2). */
export function turnUsesText(model: Pick<TurnCardModel, "count">): string {
  return `${model.count} ${model.count === 1 ? "use" : "uses"}`;
}

/** A fold's button over its words: the chevron, then the words, the trap card's look (features/traps/TrapCard.tsx), at a touch target's height. */
const FOLD: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: theme.touch,
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  padding: 0,
  background: "transparent",
  border: "none",
  color: theme.color.text,
  fontFamily: theme.font.body,
  textAlign: "left",
  cursor: "pointer",
};

/**
 * The turn card (docs/design-v1-combat-controls.md 4.2): from a creature's
 * turn start to its end, the turn's menu of its uses, for whoever answers
 * for it, with a block under each other creature of the turn this viewer
 * answers for. On its own turn a creature takes no legendary action, so
 * the card counts its pips and lists no button for them (13.1).
 *
 * `folded` is one 44 px row, "Adult Red Dragon's turn: 3 uses" with Show,
 * which FightAlerts picks under 600 px wide and wherever the card would not
 * stack above a docked bar. Show unfolds it on this device, and Collapse
 * folds it back where it was folded. Dismiss hides it here for this turn.
 */
export function TurnCard(props: { model: TurnCardModel; folded: boolean; foldable: boolean; cardRef?: Ref<HTMLElement>; onShow(on: boolean): void; onDismiss(): void }) {
  const { model } = props;
  const title = turnTitle(model);
  const usesId = useId();
  if (props.folded) {
    return (
      // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
      <section
        ref={props.cardRef}
        role="group"
        aria-label={title}
        tabIndex={-1}
        data-alert="turn"
        data-alert-id={turnAlertId(model)}
        data-turn-folded=""
        style={{ ...alertCard, display: "flex", alignItems: "center", gap: theme.space(2), minHeight: theme.touch, padding: `0 ${theme.space(3)}px` }}
      >
        {/* The fold's chevron leads its words, as the trap card's and every group's does (docs/design-v1-icons-2.md 4). Its name keeps "Show", which its words do not say, and the count its label would hide is its description. */}
        <button type="button" aria-expanded={false} aria-label={`Show ${title}`} aria-describedby={usesId} onClick={() => props.onShow(true)} style={FOLD}>
          <Icon name="chevronRight" size="sm" />
          <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.body14, fontWeight: theme.weight.strong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}: <span id={usesId}>{turnUsesText(model)}</span>
          </span>
        </button>
      </section>
    );
  }
  const several = model.blocks.length > 1 || model.blocks.some((b) => !b.participant.landing);
  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      ref={props.cardRef}
      role="group"
      aria-label={title}
      tabIndex={-1}
      data-alert="turn"
      data-alert-id={turnAlertId(model)}
      style={{ ...alertCard, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      {/* The buttons go under a name too long to share their line, rather than squeeze it to a word a line. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(1), minHeight: theme.touch, margin: `-${theme.space(1)}px -${theme.space(1)}px 0 0` }}>
        {props.foldable ? (
          // The fold's chevron leads the title, as the trap card's does. Its name keeps "Collapse", which its words contain.
          <button type="button" aria-expanded aria-label={`Collapse ${title}`} onClick={() => props.onShow(false)} style={{ ...FOLD, flex: "1 1 auto" }}>
            <Icon name="chevronDown" size="sm" />
            <span style={{ flex: 1, minWidth: 0, fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>{title}</span>
          </button>
        ) : (
          <span style={{ flex: "1 1 auto", minWidth: 0, fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>{title}</span>
        )}
        {/* Dismiss is the close every card and sheet draws (docs/design-v1-icons-2.md 4). */}
        <Button size="sm" variant="quiet" icon="close" iconOnly="always" aria-label={`Dismiss ${title}`} onClick={props.onDismiss} style={{ flex: "none", marginLeft: "auto" }} />
      </div>
      {model.blocks.map(({ participant, uses }) => (
        <div key={participant.holder} role={several ? "group" : undefined} aria-label={several ? participant.name : undefined} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
          {several ? <div style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>{participant.name}</div> : null}
          <CombatUses target={participant.target} form="card" uses={uses} loading={model.loading} failed={model.failed} ownTurn name={participant.name} />
        </div>
      ))}
    </section>
  );
}
