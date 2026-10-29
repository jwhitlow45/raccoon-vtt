import { Fragment } from "react";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import type { DamageSummaryLines, DefenseSummaryLine } from "./damageSummaryLines.ts";

type Props = { suffix?: string } & (
  | { summary: DamageSummaryLines }
  | { change: { kind: "heal" | "temp" | "set"; text: string } }
);

const STRIPE = { damage: theme.color.danger, heal: theme.color.success, temp: theme.color.textMuted, set: theme.color.textMuted };
const mutedLabel = { color: theme.color.textMuted, fontWeight: theme.weight.strong };

/** Icons are CSS masks so the external SVGs inherit the surrounding text color. */
function DamageIcon({ icon }: { icon: DamageSummaryLines["parts"][number]["icon"] }) {
  return <span aria-hidden data-damage-icon={icon} style={{
    display: "inline-block", flex: "none", width: "1em", height: "1em", background: "currentColor",
    maskImage: `url(/icons/damage/${icon}.svg)`, maskRepeat: "no-repeat", maskSize: "contain", maskPosition: "center",
    WebkitMaskImage: `url(/icons/damage/${icon}.svg)`, WebkitMaskRepeat: "no-repeat", WebkitMaskSize: "contain", WebkitMaskPosition: "center",
  }} />;
}

function DefenseWords({ line, inline = false }: { line: DefenseSummaryLine; inline?: boolean }) {
  return <>
    <span style={mutedLabel}>{line.label}{line.entries.length ? inline ? " " : ": " : ""}</span>
    {line.entries.map((entry, index) => <Fragment key={index}>
      {index > 0 ? ", " : null}
      {entry.icon ? <span data-damage-defense-entry="" style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), whiteSpace: "nowrap" }}>
        <DamageIcon icon={entry.icon} /><span data-damage-text="">{entry.text}</span>
      </span> : entry.text}
      {entry.qualifier ? ` ${entry.qualifier}` : null}
    </Fragment>)}
  </>;
}

/** One slip for every HP preview, with shared columns for the worked-out damage. */
export function DamageSummary(props: Props) {
  const summary = "summary" in props ? props.summary : null;
  const kind = "change" in props ? props.change.kind : "damage";
  const suffix = props.suffix ?? "";
  return (
    <div data-damage-summary="" data-hp-preview={kind} style={{
      display: "grid", gap: theme.space(1), width: "100%", minWidth: 0, boxSizing: "border-box",
      padding: theme.space(2), background: theme.color.surfaceRaised, borderRadius: theme.radius.sm,
      border: `${theme.line.border}px solid ${theme.color.border}`, borderLeft: `${theme.line.stripe}px solid ${STRIPE[kind]}`,
      fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.text,
    }}>
      {summary ? <>
        <div role="list" aria-label="Damage parts" style={{ display: "grid", gridTemplateColumns: "1ch 1em max-content minmax(0, 1fr)", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>
          {summary.parts.map((part, index) => (
            // Contents keeps every row in the same grid so a wider original never moves another row's result.
            <div key={index} role="listitem" data-damage-part="" style={{ display: "contents" }}>
              <span aria-hidden data-damage-gutter="" style={{ width: "1ch", color: theme.color.textMuted }}>{part.gutter ? `${part.gutter} ` : ""}</span>
              <DamageIcon icon={part.icon} />
              <span data-damage-amount="" style={{ textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {part.original !== undefined ? <><s aria-hidden style={{ color: theme.color.textMuted }}>{part.original}</s>{" "}<span style={VISUALLY_HIDDEN}>{`was ${part.original}, now `}</span></> : null}
                <span data-damage-result="" style={{ fontWeight: theme.weight.strong }}>{part.amount}</span>{" "}
              </span>
              <span data-damage-text="" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{`${part.label}${summary.parts.length === 1 ? suffix : ""}`}</span>
            </div>
          ))}
          {summary.total !== undefined ? <div role="listitem" data-damage-total="" style={{ display: "contents" }}>
            <span aria-hidden data-damage-total-rule="" style={{ gridColumn: "3 / -1", borderTop: `${theme.line.border}px solid ${theme.color.border}` }} />
            <span aria-hidden style={{ gridColumn: 1, color: theme.color.textMuted }}>{"= "}</span>
            <span data-damage-amount="" style={{ gridColumn: 3, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
              <span data-damage-result="" style={{ fontWeight: theme.weight.bold }}>{summary.total}</span>{" "}
            </span>
            <span data-damage-text="" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{`damage${suffix}`}</span>
          </div> : null}
        </div>
        {summary.defenses.length > 0 || summary.targets.length > 0 ? <div data-damage-defenses="" style={{ display: "grid", gap: theme.space(1), paddingTop: theme.space(1), borderTop: `${theme.line.border}px solid ${theme.color.border}`, fontSize: theme.font.small, minWidth: 0, overflowWrap: "anywhere" }}>
          {summary.defenses.map((line) => <div key={line.label} data-damage-defense=""><DefenseWords line={line} /></div>)}
          {summary.targets.map((target, index) => <div key={index} data-damage-target="">
            <span style={mutedLabel}>{`${target.name}: `}</span>
            {target.defenses.map((line, index) => <Fragment key={line.label}>{index > 0 ? ", " : null}<DefenseWords line={line} inline /></Fragment>)}
            {target.defenses.length ? ", " : null}<span style={{ fontWeight: theme.weight.strong, fontVariantNumeric: "tabular-nums" }}>{target.amount}</span>
          </div>)}
        </div> : null}
      </> : "change" in props ? <span>{`${props.change.text}${suffix}`}</span> : null}
    </div>
  );
}
