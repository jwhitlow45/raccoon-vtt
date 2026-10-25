import type { CSSProperties, ReactNode } from "react";
import type { Actor, Token } from "#shared/model.ts";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Icon } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { elevationBadge } from "../../lib/tokenView.ts";
import { OVER_REACH, SheetLink } from "./SheetLink.tsx";
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
  for (let n = 0; n < props.items.length; n++) {
    const item = props.items[n]!;
    if (item.key === "ac") {
      const ac = item.units[0];
      if (ac?.kind === "ac") units.push(<AcBadge key="ac" ac={ac.ac} />);
    } else if (item.key === "sheet") {
      const sheet = item.units[0];
      if (sheet?.kind === "sheet") sheetUrl = sheet.url;
    } else {
      const unit = quickUnit(item);
      const next = props.items[n + 1];
      const pp = next ? quickUnit(next) : null;
      if (unit?.key === "speed" && unit.modes.length > 1 && pp?.key === "passivePerception") {
        // The line's own gap, its columnGap below.
        units.push(<SpeedThenPerception key="speed" speed={unit} pp={pp} lineGap={theme.space(3)} />);
        n++;
      } else if (unit) units.push(<QuickNumberUnit key={unit.key} unit={unit} />);
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

type SpeedUnit = Extract<QuickUnit, { key: "speed" }>;
type PerceptionUnit = Extract<QuickUnit, { key: "passivePerception" }>;

/**
 * A speed of two modes or more with Passive Perception after it, as the
 * panel's header and a summary line draw them (StatSummary.tsx
 * VitalsLine): the speed's last mode and Passive Perception wrap as one
 * part, so where the modes do not
 * fit on one line, the last never stands alone under the others, as
 * "Climb 40 ft" did in More stats on the narrowest phone (FU30-NOTED).
 * The speed keeps its whole name, so a screen reader hears it once, and
 * the last mode drawn beside Passive Perception is hidden from it.
 *
 * The two parts are the line's own items, not one box around them: a box
 * whose contents wrap takes its whole line, and the item after Passive
 * Perception then stood alone under it where it fit beside it, as
 * "Init +0" did under "Burrow 30 ft PP 21" (FU31 review F1). `lineGap` is
 * the gap of the line they stand in. The speed's end margin takes it back
 * to the modes' own gap, and a speed that ends its line loses nothing by
 * it. `style` goes on the part with Passive Perception, which ends this.
 */
export function SpeedThenPerception(props: { speed: SpeedUnit; pp: PerceptionUnit; lineGap: number; style?: CSSProperties }) {
  const { speed } = props;
  const last = speed.modes.length - 1;
  return (
    <span data-speed-pp="" style={{ display: "contents" }}>
      <Unit name={speed.name} wraps style={{ marginInlineEnd: theme.space(1) - props.lineGap }}>
        <Icon name="speed" size="sm" style={{ color: theme.color.textMuted }} />
        {speed.modes.slice(0, last).map((mode, i) => (
          <strong key={i} data-unit="speed" style={{ whiteSpace: "nowrap" }}>
            {`${mode},`}
          </strong>
        ))}
      </Unit>
      <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", rowGap: theme.space(1), columnGap: theme.space(3), minWidth: 0, maxWidth: "100%", ...props.style }}>
        <strong data-unit="speed" aria-hidden="true" style={{ whiteSpace: "nowrap" }}>
          {speed.modes[last]}
        </strong>
        <QuickNumberUnit unit={props.pp} />
      </span>
    </span>
  );
}

function Unit(props: { name: string; wraps?: boolean; style?: CSSProperties; children: ReactNode }) {
  const wrap = props.wraps ? { flexWrap: "wrap", minWidth: 0, maxWidth: "100%" } as const : { whiteSpace: "nowrap" } as const;
  return (
    <span role="img" aria-label={props.name} title={props.name} style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), ...wrap, ...OVER_REACH, ...props.style }}>
      {props.children}
    </span>
  );
}
