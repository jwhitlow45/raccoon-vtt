import { useId } from "react";
import type { LightLevel } from "#shared/model.ts";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { theme } from "../../lib/theme.ts";
import { LIGHT_LEVELS } from "./settings.ts";
import type { LightProposal } from "./uvttLight.ts";

/**
 * The light level on a Universal VTT import's summary sheet
 * (docs/design-v1-maps-vision.md section 4.3.8): what the file proposes,
 * which the DM can change. It is the level party vision uses, at once
 * under Explore, and its help is the proposal's reason alone, since Players
 * see above it now says whether vision is on (docs/design-v1-map-discovery.md
 * 8.1, MD-O-29).
 */
export function UvttLightChoice(props: { value: LightLevel; proposal: LightProposal | null; disabled: boolean; onChange(level: LightLevel): void }) {
  const labelId = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <span id={labelId} style={{ fontWeight: theme.weight.strong }}>
        Light, for party vision
      </span>
      <Segmented<LightLevel>
        labelledBy={labelId}
        value={props.value}
        options={LIGHT_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
        disabled={props.disabled}
        onChange={props.onChange}
      />
      {props.proposal ? <Help>{props.proposal.why}</Help> : null}
    </div>
  );
}
