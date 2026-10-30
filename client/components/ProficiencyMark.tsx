import type { ReactNode } from "react";
import type { Proficiency } from "#shared/rules/proficiency.ts";

export function ProficiencyMark(props: { level: Proficiency; under?: boolean }) {
  const name = props.level === "expert" ? "Expertise" : props.level === "prof" ? "Proficient" : undefined;
  return (
    <span data-proficiency-marker={props.level} role={name ? "img" : undefined} aria-label={name} title={name} aria-hidden={name ? undefined : true} data-proficiency-placement={props.under ? "under" : undefined} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "1em", height: "1em", lineHeight: 1, color: "inherit", ...(props.under ? { position: "absolute", left: "0.05em", top: "calc(50% + 0.3em)", width: "0.4em", height: "0.4em" } as const : {}) }}>
      {name ? <svg aria-hidden="true" width="100%" height="100%" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r={props.under ? props.level === "expert" ? 2.5 : 5 : 3} />{props.level === "expert" ? <circle cx="8" cy="8" r={props.under ? 6.5 : 6} fill="none" stroke="currentColor" strokeWidth={props.under ? 2 : 1.5} /> : null}</svg> : null}
    </span>
  );
}

/** Columns align reserved slots. Flowing text puts a compact mark below its first capital without widening the words. */
export function ProficiencyLabel(props: { level: Proficiency; column?: boolean; children: ReactNode }) {
  return <span data-proficiency-label="" data-proficiency-level={props.level} data-proficiency-layout={props.column ? "column" : "flow"} style={props.column ? { display: "inline-flex", alignItems: "center", gap: "0.25em", whiteSpace: "nowrap", verticalAlign: "middle" } : { display: "inline-block", position: "relative", whiteSpace: "nowrap", verticalAlign: "baseline" }}>
    {props.column || props.level !== "none" ? <ProficiencyMark level={props.level} under={!props.column} /> : null}<span data-proficiency-name="" style={{ whiteSpace: "nowrap" }}>{props.children}</span>
  </span>;
}
