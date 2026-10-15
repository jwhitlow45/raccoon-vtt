import type { PartyGroup } from "#shared/model.ts";
import { DIFFICULTIES, type Difficulty } from "#shared/srd/xp-budget.ts";
import { Notice } from "../../components/Notice.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { DIFFICULTY_LABEL, difficultyOf, partyBudgets, partySize, xpText } from "./budget.ts";

const TONE: Record<Difficulty | "over", string> = {
  low: theme.color.success,
  moderate: theme.color.warning,
  high: theme.color.dangerText,
  over: theme.color.dangerText,
};

/**
 * The encounter against its party's 2024 XP budget (SRD 5.2.1, "Combat
 * Encounter Difficulty"): the Low, Moderate and High budgets, the monsters'
 * XP, and the lowest budget it stays within. `unknown` creatures have no
 * stat block at hand yet, and are said to be left out rather than counted
 * as nothing.
 */
export function BudgetView(props: { party: readonly PartyGroup[]; total: number; unknown: number; unknownWhy: string }) {
  const budgets = partyBudgets(props.party);
  const fits = difficultyOf(props.total, budgets);
  if (partySize(props.party) === 0) {
    return <Help>Give the party a level to see the XP budget.</Help>;
  }
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <div role="table" aria-label="XP budget" style={{ display: "grid", gap: theme.space(0.5) }}>
        {DIFFICULTIES.map((d) => {
          const here = fits === d;
          return (
            <div
              key={d}
              role="row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: theme.space(2),
                minHeight: 32,
                padding: `0 ${theme.space(3)}px`,
                borderRadius: theme.radius.sm,
                border: `${theme.line.border}px solid ${here ? TONE[d] : "transparent"}`,
                background: theme.color.surfaceRaised,
              }}
            >
              <span role="cell" style={{ flex: 1, fontWeight: here ? theme.weight.bold : theme.weight.regular, color: here ? TONE[d] : theme.color.text }}>
                {DIFFICULTY_LABEL[d]}
              </span>
              <span role="cell" style={{ fontVariantNumeric: "tabular-nums", color: theme.color.textMuted }}>
                {xpText(budgets[d])}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: theme.font.body14 }}>
        <span style={{ fontWeight: theme.weight.strong }}>This encounter: {xpText(props.total)}</span>
        {fits ? <span style={{ color: TONE[fits], fontWeight: theme.weight.strong }}> · {verdict(fits, props.total, budgets)}</span> : null}
      </div>
      {props.unknown > 0 ? (
        <Notice>
          {props.unknown === 1 ? "1 creature is" : `${props.unknown} creatures are`} not counted: {props.unknownWhy}
        </Notice>
      ) : null}
    </div>
  );
}

function verdict(fits: Difficulty | "over", total: number, budgets: Record<Difficulty, number>): string {
  if (fits === "over") return `over the High budget by ${xpText(total - budgets.high)}`;
  return `${DIFFICULTY_LABEL[fits]}, ${xpText(budgets[fits] - total)} left`;
}
