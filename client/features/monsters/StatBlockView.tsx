import { useMemo } from "react";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { Markdown } from "../../components/Markdown.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { AbilityGrid } from "./AbilityGrid.tsx";
import { splitAbilityTable } from "./abilityTable.ts";
import { useSrdBlocks } from "./srdBlocks.ts";

/** The SRD's credit, which CC BY 4.0 asks for wherever its text is shown. */
export const SRD_CREDIT = "Stat blocks from the System Reference Document 5.2.1 by Wizards of the Coast, licensed under CC-BY-4.0.";

/**
 * A full 2024 stat block, read only: what the Monsters panel shows for a
 * monster it lists, and what the token panel shows for a token linked to
 * one (docs/design-v1-dm-tools.md 3.6). Nothing in it rolls.
 */
export function StatBlockView(props: { view: StatBlockMonster; source: "srd" | "room"; credit?: boolean }) {
  const split = useMemo(() => splitAbilityTable(props.view.statBlock), [props.view.statBlock]);
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {split ? (
        // The ability table three across, the text on either side drawn as written. The margins are the Markdown table's own, so the block keeps its rhythm.
        <div>
          <Markdown text={split.before} />
          <div style={{ margin: `${theme.space(2)}px 0` }}>
            <AbilityGrid abilities={split.abilities} />
          </div>
          <Markdown text={split.after} />
        </div>
      ) : (
        <Markdown text={props.view.statBlock} />
      )}
      {props.source === "srd" && props.credit ? <SrdCredit /> : null}
    </div>
  );
}

export function SrdCredit() {
  return <Help style={{ marginTop: theme.space(2) }}>{SRD_CREDIT}</Help>;
}

/**
 * The SRD's 330 stat blocks, loaded on first use in their own chunk
 * (shared/srd/monsters.ts): null until they arrive, and `failed` when the
 * load did not work, so a caller can say so and offer the reload
 * (SrdLoadFailed.tsx) instead of looking stuck.
 */
export function useSrdMonsters(): { monsters: readonly SrdMonster[] | null; failed: boolean } {
  const { list, failed } = useSrdBlocks();
  return { monsters: list, failed };
}
