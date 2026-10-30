import type { ReactNode } from "react";
import type { D20Test } from "#shared/dice/bonus.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { ProficiencyLabel } from "../../components/ProficiencyMark.tsx";
import { creatureProficiency } from "./creature.ts";
import { useDiceView } from "./useDiceView.ts";
import { testLabel } from "./options.ts";

export function ProficientTest(props: { creature: ActorTarget; test: D20Test; children?: ReactNode }) {
  const { dice } = useDiceView([props.creature]);
  const words = props.children ?? testLabel(props.test);
  if (props.test.kind !== "save" && !(props.test.kind === "check" && props.test.skill)) return <>{words}</>;
  return <ProficiencyLabel level={dice ? creatureProficiency(dice, props.creature, props.test) : "none"}>{words}</ProficiencyLabel>;
}
