import type { CSSProperties, ReactNode } from "react";
import type { Actor, Token } from "#shared/model.ts";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Icon } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { elevationBadge } from "../../lib/tokenView.ts";
import { SheetLink } from "./SheetLink.tsx";
import { quickUnit, type QuickUnit, type VitalItem } from "./statSummary.ts";

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
    } else if (item.key === "sheet") {
      const sheet = item.units[0];
      if (sheet?.kind === "sheet") sheetUrl = sheet.url;
    } else {
      const unit = quickUnit(item);
      if (unit) units.push(<QuickNumberUnit key={unit.key} unit={unit} />);
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

/**
 * Speed after the footprints or Passive Perception after "PP", as one
 * quick number. The token window's summary line draws its speed and
 * Passive Perception with this too (StatSummary.tsx VitalsLine), so a
 * creature's numbers read alike wherever they are summed up.
 */
export function QuickNumberUnit(props: { unit: QuickUnit; style?: CSSProperties }) {
  const { unit } = props;
  if (unit.key === "speed") {
    return (
      // Five speeds outrun a side panel's column or a narrow window, so this unit alone wraps, between its modes and never inside one.
      <Unit name={unit.name} wraps style={props.style}>
        <Icon name="speed" size="sm" style={{ color: theme.color.textMuted }} />
        {unit.modes.map((mode, i) => (
          <strong key={i} data-unit="speed" style={{ whiteSpace: "nowrap" }}>
            {i < unit.modes.length - 1 ? `${mode},` : mode}
          </strong>
        ))}
      </Unit>
    );
  }
  return (
    <Unit name={unit.name} style={props.style}>
      <span style={{ color: theme.color.textMuted }}>PP</span>
      <strong>{unit.value}</strong>
    </Unit>
  );
}

function Unit(props: { name: string; wraps?: boolean; style?: CSSProperties; children: ReactNode }) {
  const wrap = props.wraps ? { flexWrap: "wrap", minWidth: 0, maxWidth: "100%" } as const : { whiteSpace: "nowrap" } as const;
  return (
    <span role="img" aria-label={props.name} title={props.name} style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), ...wrap, ...props.style }}>
      {props.children}
    </span>
  );
}
