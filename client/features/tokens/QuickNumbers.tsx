import type { ReactNode } from "react";
import type { Actor, Token } from "#shared/model.ts";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Icon } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { elevationBadge } from "../../lib/tokenView.ts";
import { SheetLink } from "./SheetLink.tsx";
import type { VitalItem } from "./statSummary.ts";

/**
 * The numbers a table asks for most, under a token's name at the top of its
 * panel (docs/design-v1-dice-ui.md 5.1): AC on its shield, speed after the
 * footprints, Passive Perception, initiative, the elevation off the
 * ground, and the sheet link where the viewer's copy holds one. Each
 * number is one unbreakable unit, speed breaking only between its modes,
 * that names itself in full for a
 * screen reader and in its tooltip ("Passive Perception 14"), and keeps a
 * short visible word where its icon alone would not be read at once on a
 * touch screen ("PP 14", "Init +2").
 */
export function QuickNumbers(props: { items: readonly VitalItem[]; actor: Partial<Actor> | undefined; token: Pick<Token, "elevation" | "kind"> }) {
  const units: ReactNode[] = [];
  let sheetUrl: string | null = null;
  for (const item of props.items) {
    if (item.key === "ac") {
      const ac = item.units[0];
      if (ac?.kind === "ac") units.push(<AcBadge key="ac" ac={ac.ac} />);
    } else if (item.key === "speed") {
      const modes = item.units.flatMap((u) => (u.kind === "text" ? [`${u.label === "Speed" ? "" : `${u.label} `}${u.value}`] : []));
      units.push(
        // Five speeds outrun a side panel's column, so this unit alone wraps, between its modes and never inside one, as the bar's do (StatSummary.tsx).
        <Unit key="speed" name={`Speed ${modes.join(", ")}`} wraps>
          <Icon name="speed" size="sm" style={{ color: theme.color.textMuted }} />
          {modes.map((mode, i) => (
            <strong key={i} data-unit="speed" style={{ whiteSpace: "nowrap" }}>
              {i < modes.length - 1 ? `${mode},` : mode}
            </strong>
          ))}
        </Unit>,
      );
    } else if (item.key === "sheet") {
      const sheet = item.units[0];
      if (sheet?.kind === "sheet") sheetUrl = sheet.url;
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
    const text = init < 0 ? `−${-init}` : `+${init}`;
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
      <Unit key="elevation" name={`Elevation ${props.token.elevation} ft`}>
        <strong>{height} ft</strong>
      </Unit>,
    );
  }
  if (sheetUrl) {
    // Last, as the one unit that leaves the page: its icon says a new tab, as every outside link's does.
    units.push(<SheetLink key="sheet" url={sheetUrl} />);
  }
  if (units.length === 0) return null;
  return (
    <div data-quick-numbers="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(3), rowGap: theme.space(1), fontSize: theme.font.body14, fontVariantNumeric: "tabular-nums" }}>
      {units}
    </div>
  );
}

function Unit(props: { name: string; wraps?: boolean; children: ReactNode }) {
  const wrap = props.wraps ? { flexWrap: "wrap", minWidth: 0, maxWidth: "100%" } as const : { whiteSpace: "nowrap" } as const;
  return (
    <span role="img" aria-label={props.name} title={props.name} style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), ...wrap }}>
      {props.children}
    </span>
  );
}
