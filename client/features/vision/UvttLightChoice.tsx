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
 * which the DM can change. It is the level party vision uses once the DM
 * turns vision on in the scene's settings.
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
      <Help>{props.proposal ? `${props.proposal.why} ` : ""}Party vision stays off until you turn it on in the scene's settings.</Help>
    </div>
  );
}
