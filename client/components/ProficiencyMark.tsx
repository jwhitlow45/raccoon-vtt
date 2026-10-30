import type { ReactNode } from "react";
import type { Proficiency } from "#shared/rules/proficiency.ts";

export function ProficiencyMark(props: { level: Proficiency }) {
  const name = props.level === "expert" ? "Expertise" : props.level === "prof" ? "Proficient" : undefined;
  return (
    <span data-proficiency-marker={props.level} role={name ? "img" : undefined} aria-label={name} title={name} aria-hidden={name ? undefined : true} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "1em", height: "1em", lineHeight: 1, color: "inherit" }}>
      {name ? <svg aria-hidden="true" width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="3" />{props.level === "expert" ? <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}</svg> : null}
    </span>
  );
}

/** A test's marker, name and number are one unit. Lists may wrap between units. */
export function ProficiencyLabel(props: { level: Proficiency; children: ReactNode }) {
  return <span data-proficiency-label="" style={{ display: "inline-flex", alignItems: "center", gap: "0.25em", whiteSpace: "nowrap", verticalAlign: "middle" }}><ProficiencyMark level={props.level} /><span data-proficiency-name="" style={{ whiteSpace: "nowrap" }}>{props.children}</span></span>;
}
