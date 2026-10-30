import { ABILITY_ABBR, ABILITY_NAMES } from "#shared/rules/skills.ts";
import { ProficiencyLabel, ProficiencyUnit } from "../../components/ProficiencyMark.tsx";
import { theme } from "../../lib/theme.ts";
import type { AbilityBox } from "./abilityTable.ts";

/**
 * The six abilities three across, as the 2024 block prints them: about a
 * third of the height of a seven-row table (docs/design-v1-dice-ui.md 6.1
 * and 6.3). A PC's block and a monster's draw the same grid, so the two
 * read alike in the token panel.
 */
export function AbilityGrid(props: { abilities: readonly AbilityBox[] }) {
  return (
    <dl data-ability-grid="" style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>
      {props.abilities.map((a) => (
        <div key={a.key} style={{ padding: `${theme.space(1)}px ${theme.space(2)}px`, borderRadius: theme.radius.sm, background: theme.color.surfaceRaised, lineHeight: theme.leading.tight }}>
          <dt style={{ fontSize: theme.font.tiny, fontWeight: theme.weight.bold, letterSpacing: theme.caps, textTransform: "uppercase", color: theme.color.textMuted }}>
            <abbr title={ABILITY_NAMES[a.key]} style={{ textDecoration: "none" }}>
              {ABILITY_ABBR[a.key]}
            </abbr>
          </dt>
          <dd style={{ margin: 0, whiteSpace: "nowrap" }}>
            <strong style={{ fontSize: theme.font.input }}>{a.score}</strong> <span style={{ color: theme.color.textMuted }}>{a.mod}</span>
          </dd>
          <dd style={{ margin: 0, fontSize: theme.font.small, whiteSpace: "nowrap", fontWeight: a.proficient ? theme.weight.bold : theme.weight.regular }}>
            {/* "Save" names it proficient for a screen reader too, and "Save +3" is framed whole (D-261030-527). */}
            <ProficiencyUnit level={a.proficient ? "prof" : "none"}>
              <span style={{ color: theme.color.textMuted, fontWeight: theme.weight.regular }}>
                <ProficiencyLabel level={a.proficient ? "prof" : "none"} bare>Save</ProficiencyLabel>{" "}
              </span>
              {a.save}
            </ProficiencyUnit>
          </dd>
        </div>
      ))}
    </dl>
  );
}
