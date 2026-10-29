import type { Defense } from "#shared/dice/defenses.ts";
import { damageTypeName, type DamageType } from "#shared/rules/damage.ts";
import { defenseApplies, nonnegativeDamageParts, type OutcomePart, type rowDamage } from "#shared/rules/typedDamage.ts";

export type DamageSummaryContext = {
  result?: ReturnType<typeof rowDamage>;
  defenses?: readonly Defense[];
  qualifiedOn?: ReadonlySet<string>;
  saved?: "half" | "none";
};

export type DefenseSummaryLine = {
  label: "Immune" | "Resists" | "Vulnerable" | "Saved" | "Evasion";
  entries: { icon?: DamageType | "untyped"; text: string; qualifier?: string }[];
};

/** Text for the compact bar header and other callers that cannot carry markup. */
export function defenseSummaryText(line: DefenseSummaryLine): string {
  return `${line.label}${line.entries.length ? `: ${line.entries.map((entry) => `${entry.text}${entry.qualifier ? ` ${entry.qualifier}` : ""}`).join(", ")}` : ""}`;
}

export type DamageSummaryLines = {
  parts: { icon: DamageType | "untyped"; gutter: "" | "+"; amount: number | string; original?: number; label: string }[];
  total?: number;
  defenses: DefenseSummaryLine[];
  targets: { name: string; amount: number; defenses: DefenseSummaryLine[] }[];
};

/** Presentation only. Amounts and applied defense notes come from the shared rule. */
export function damageSummary(parts: readonly OutcomePart[], context: DamageSummaryContext & { targets?: readonly (DamageSummaryContext & { name: string })[] } = {}): DamageSummaryLines {
  parts = nonnegativeDamageParts(parts);
  const result = context.targets ? undefined : context.result;
  const lines = parts.map((part, index): DamageSummaryLines["parts"][number] => {
    const before = "amount" in part ? part.amount : part.formula;
    const amount = result?.byPart[index] ?? before;
    return {
      icon: part.type ?? "untyped", gutter: index === 0 ? "" : "+", amount,
      ...(typeof before === "number" && before !== amount ? { original: before } : {}),
      label: `${part.type ? `${damageTypeName(part.type)} ` : ""}damage`,
    };
  });
  const defenses: DefenseSummaryLine[] = [];
  if (result) {
    for (const kind of ["immune", "resist", "vulnerable"] as const) {
      const entries = new Map<string, DefenseSummaryLine["entries"][number]>();
      for (const defense of context.defenses ?? []) {
        if (defense.kind !== kind || !defenseApplies(defense, context.qualifiedOn ?? new Set())) continue;
        // Notes identify applied defenses. A matching type alone must never reveal a defense bypassed by a save or immunity.
        const applied = parts.some((part) => {
          if (defense.of !== "all" && defense.of !== part.type) return false;
          const type = part.type ? damageTypeName(part.type) : "";
          const note = kind === "immune" ? `Immune to ${type || "it"}` : kind === "resist" ? `Resists ${defense.of === "all" ? "all damage" : type}` : `Vulnerable to ${type}`;
          return result.notes.includes(note);
        });
        if (applied) entries.set(`${defense.of}:${defense.qualifier ?? ""}`, {
          icon: defense.of === "all" ? "untyped" : defense.of as DamageType,
          text: defense.of === "all" ? "all damage" : damageTypeName(defense.of),
          ...(defense.qualifier ? { qualifier: defense.qualifier } : {}),
        });
      }
      if (entries.size) defenses.push({ label: ({ immune: "Immune", resist: "Resists", vulnerable: "Vulnerable" } as const)[kind], entries: [...entries.values()] });
    }
    if (result.notes.includes("Evasion")) defenses.push({ label: "Evasion", entries: [] });
    else if (context.saved && parts.some((part) => "amount" in part && part.amount > 0)) defenses.push({ label: "Saved", entries: [{ text: context.saved === "half" ? "half" : "no damage" }] });
  }
  const targets = (context.targets ?? []).flatMap((target) => {
    if (!target.result) return [];
    const summary = damageSummary(parts, target);
    if (!summary.parts.some((part) => part.original !== undefined) && summary.defenses.length === 0) return [];
    return [{ name: target.name, amount: target.result.amount, defenses: summary.defenses }];
  });
  return {
    parts: lines,
    ...(lines.length > 1 && lines.every((line) => typeof line.amount === "number") ? { total: result?.amount ?? lines.reduce((sum, line) => sum + Number(line.amount), 0) } : {}),
    defenses, targets,
  };
}
