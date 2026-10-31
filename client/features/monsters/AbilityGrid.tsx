import { ABILITY_ABBR, ABILITY_NAMES } from "#shared/rules/skills.ts";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import type { AbilityBox } from "./abilityTable.ts";

/**
 * The six abilities three across, as the 2024 block prints them: about a
 * third of the height of a seven-row table (docs/design-v1-dice-ui.md 6.1
 * and 6.3). A PC's block and a monster's draw the same grid, so the two
 * read alike in the token panel.
 *
 * An ability whose save is proficient has its whole box outlined, name,
 * score, modifier and save together, and nothing else sets it apart
 * (D-261030-588). The outline is FL-12's border: 1 px in the text's color,
 * never the accent's, drawn inside the box's own rounded edge as a shadow,
 * so no box, row or grid changes size for it.
 */
export function AbilityGrid(props: { abilities: readonly AbilityBox[] }) {
  return (
    <dl data-ability-grid="" style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>
      {props.abilities.map((a) => (
        <div
          key={a.key}
          {...(a.proficient ? { "data-save-proficient": "" } : {})}
          style={{ padding: `${theme.space(1)}px ${theme.space(2)}px`, borderRadius: theme.radius.sm, background: theme.color.surfaceRaised, lineHeight: theme.leading.tight, ...(a.proficient ? { boxShadow: theme.shadow.markInside } : {}) }}
        >
          <dt style={{ fontSize: theme.font.tiny, fontWeight: theme.weight.bold, letterSpacing: theme.caps, textTransform: "uppercase", color: theme.color.textMuted }}>
            <abbr title={ABILITY_NAMES[a.key]} style={{ textDecoration: "none" }}>
              {ABILITY_ABBR[a.key]}
            </abbr>
          </dt>
          <dd style={{ margin: 0, whiteSpace: "nowrap" }}>
            <strong style={{ fontSize: theme.font.input }}>{a.score}</strong> <span style={{ color: theme.color.textMuted }}>{a.mod}</span>
          </dd>
          <dd style={{ margin: 0, fontSize: theme.font.small, whiteSpace: "nowrap" }}>
            <span style={{ color: theme.color.textMuted }}>Save </span>
            {a.save}
            {/* The outline is not read out, so a screen reader hears a proficient save as one here. */}
            {a.proficient ? <span style={VISUALLY_HIDDEN}>, proficient</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
