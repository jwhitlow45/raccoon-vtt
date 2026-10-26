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
  // Each unit drawn with the margin it takes when another follows it.
  const units: ((between: CSSProperties | undefined) => ReactNode)[] = [];
  let sheetUrl: string | null = null;
  for (let n = 0; n < props.items.length; n++) {
    const item = props.items[n]!;
    if (item.key === "ac") {
      const ac = item.units[0];
      if (ac?.kind === "ac") {
        units.push((between) => (
          <span key="ac" style={{ display: "inline-flex", ...between }}>
            <AcBadge ac={ac.ac} />
          </span>
        ));
      }
    } else if (item.key === "sheet") {
      const sheet = item.units[0];
      if (sheet?.kind === "sheet") sheetUrl = sheet.url;
    } else {
      const unit = quickUnit(item);
      const next = props.items[n + 1];
      const pp = next ? quickUnit(next) : null;
      if (unit?.key === "speed" && unit.modes.length > 1 && pp?.key === "passivePerception") {
        units.push((between) => <SpeedThenPerception key="speed" speed={unit} pp={pp} style={between} />);
        n++;
      } else if (unit) units.push((between) => <QuickNumberUnit key={unit.key} unit={unit} style={between} />);
    }
  }
  const init = props.actor?.initBonus;
  if (props.token.kind !== "object" && typeof init === "number") {
    const text = init < 0 ? `−${-init}` : `+${init}`;
    units.push((between) => (
      <Unit key="init" name={`Initiative ${text}`} style={between}>
        <span style={{ color: theme.color.textMuted }}>Init</span>
        <strong>{text}</strong>
      </Unit>
    ));
  }
  const height = elevationBadge(props.token.elevation);
  if (height) {
    units.push((between) => (
      <Unit key="elevation" name={`Elevation ${props.token.elevation} ft`} style={between}>
        <strong>{height} ft</strong>
      </Unit>
    ));
  }
  if (sheetUrl) {
    const url = sheetUrl;
    // Last, as the one unit that leaves the page: its icon says a new tab, as every outside link's does.
    units.push(() => <SheetLink key="sheet" url={url} />);
  }
  if (units.length === 0) return null;
  /*
   * The line's own gap is the speed's 4 px between its modes, which its last
   * mode keeps from the rest (SpeedThenPerception), and a unit another
   * follows adds 8 more, so the units stand 12 px apart. A trailing margin
   * can only send a unit to the next line a little early. A negative one
   * let the speed stay on a line it ran 8 px past (FU31 review F10).
   */
  return (
    <div data-quick-numbers="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(1), rowGap: theme.space(1), fontSize: theme.font.body14, fontVariantNumeric: "tabular-nums" }}>
      {units.map((draw, i) => draw(i < units.length - 1 ? BETWEEN : undefined))}
    </div>
  );
}

/** What a header unit that another follows adds to the line's 4 px gap. */
const BETWEEN: CSSProperties = { marginInlineEnd: theme.space(2) };

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
 * the last mode drawn beside Passive Perception is hidden from it. Under a
 * pointer the last mode names the whole speed and takes the taps over the
 * sheet link's reach, as the rest of the speed does (FU31 review F7).
 *
 * The two parts are the line's own items, not one box around them: a box
 * whose contents wrap takes its whole line, and the item after Passive
 * Perception then stood alone under it where it fit beside it, as
 * "Init +0" did under "Burrow 30 ft PP 21" (FU31 review F1). So the
 * speed stands from its last mode by the gap of the line they stand in,
 * the modes' own 4 px, in the panel's header and a summary line alike
 * (FU31-SUMMARY-GAP). No margin on the speed takes it back, since a
 * negative one let the speed stay on a line it ran past (FU31 review F10). `style` goes on the part
 * with Passive Perception, which ends this.
 */
export function SpeedThenPerception(props: { speed: SpeedUnit; pp: PerceptionUnit; style?: CSSProperties }) {
  const { speed } = props;
  const last = speed.modes.length - 1;
  return (
    <span data-speed-pp="" style={{ display: "contents" }}>
      <Unit name={speed.name} wraps>
        <Icon name="speed" size="sm" style={{ color: theme.color.textMuted }} />
        {speed.modes.slice(0, last).map((mode, i) => (
          <strong key={i} data-unit="speed" style={{ whiteSpace: "nowrap" }}>
            {`${mode},`}
          </strong>
        ))}
      </Unit>
      <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", rowGap: theme.space(1), columnGap: theme.space(3), minWidth: 0, maxWidth: "100%", ...props.style }}>
        <strong data-unit="speed" aria-hidden="true" title={speed.name} style={{ whiteSpace: "nowrap", ...OVER_REACH }}>
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
