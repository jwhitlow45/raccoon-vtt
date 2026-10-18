import type { ReactNode } from "react";
import type { Actor, Token } from "#shared/model.ts";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Icon } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { elevationBadge } from "../../lib/tokenView.ts";
import type { VitalItem } from "./statSummary.ts";

/**
 * The numbers a table asks for most, under a token's name at the top of its
 * panel (docs/design-v1-dice-ui.md 5.1): AC on its shield, speed after the
 * footprints, Passive Perception, initiative and the elevation off the
 * ground. Each is one unbreakable unit that names itself in full for a
 * screen reader and in its tooltip ("Passive Perception 14"), and keeps a
 * short visible word where its icon alone would not be read at once on a
 * touch screen ("PP 14", "Init +2").
 */
export function QuickNumbers(props: { items: readonly VitalItem[]; actor: Partial<Actor> | undefined; token: Pick<Token, "elevation" | "kind">; full: boolean }) {
  const units: ReactNode[] = [];
  for (const item of props.items) {
    if (item.key === "ac") {
      const ac = item.units[0];
      if (ac?.kind === "ac") units.push(<AcBadge key="ac" ac={ac.ac} />);
    } else if (item.key === "speed") {
      const words = item.units.map((u) => (u.kind === "text" ? `${u.label === "Speed" ? "" : `${u.label} `}${u.value}` : "")).join(", ");
      units.push(
        <Unit key="speed" name={`Speed ${words}`}>
          <Icon name="speed" size="sm" style={{ color: theme.color.textMuted }} />
          <strong>{words}</strong>
        </Unit>,
      );
    } else if (item.key === "passivePerception") {
      const pp = item.units[0];
      if (pp?.kind === "text")
        units.push(
          <Unit key="pp" name={`Passive Perception ${pp.value}`}>
            <span style={{ color: theme.color.textMuted }}>PP</span>
            <strong>{pp.value}</strong>
          </Unit>,
        );
    }
  }
  const init = props.actor?.initBonus;
  if (props.token.kind !== "object" && typeof init === "number") {
    const text = init < 0 ? `${init}` : `+${init}`;
    units.push(
      <Unit key="init" name={`Initiative ${text}`}>
        <span style={{ color: theme.color.textMuted }}>Init</span>
        <strong>{text}</strong>
      </Unit>,
    );
  }
  const height = elevationBadge(props.token.elevation);
  if (height) {
    units.push(
      <Unit key="elevation" name={`Elevation ${height} ft`}>
        <strong>{height} ft</strong>
      </Unit>,
    );
  }
  if (units.length === 0) return null;
  return (
    <div data-quick-numbers="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(3), rowGap: theme.space(1), fontSize: theme.font.body14 }}>
      {units}
    </div>
  );
}

function Unit(props: { name: string; children: ReactNode }) {
  return (
    <span role="img" aria-label={props.name} title={props.name} style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), whiteSpace: "nowrap" }}>
      {props.children}
    </span>
  );
}
