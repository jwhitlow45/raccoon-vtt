import { creatureName } from "#shared/logText.ts";
import type { Toast } from "../../state/types.ts";
import { theme } from "../../lib/theme.ts";
import { ProficientTest } from "./ProficientTest.tsx";
import { ProficientText } from "./ProficientEvent.tsx";
import { rollTarget, rollTest } from "./proficiencyPresentation.ts";
import { useDiceView } from "./useDiceView.ts";

/** Toast metadata stays on this device. A missing creature leaves the original text intact. */
export function ProficientToast(props: { toast: Toast }) {
  const { toast } = props;
  const rolls = toast.rolls ?? [];
  const { dice } = useDiceView(rolls.flatMap((roll) => rollTarget(roll) ?? []));
  const known = rolls.flatMap((roll) => {
    const target = rollTarget(roll);
    const test = rollTest(roll);
    const exists = target && dice && ("tokenId" in target ? dice.view.tokens[target.tokenId] : dice.view.characters[target.characterId]);
    return target && test && exists && roll.label ? [{ roll, target, test }] : [];
  });
  const one = rolls.length === 1 ? known[0] : undefined;
  if (one) return <ProficientText text={toast.text} label={one.roll.label!} creature={one.target} test={one.test} />;
  if (known.length === 0 || !dice) return <>{toast.text}</>;
  return <span style={{ display: "grid", gap: theme.space(1) }}><span>{toast.text}</span>{known.map(({ roll, target, test }, i) => <span key={i}>{creatureName(dice.view, target)}: <ProficientTest creature={target} test={test}>{roll.label} {roll.total}</ProficientTest></span>)}</span>;
}
