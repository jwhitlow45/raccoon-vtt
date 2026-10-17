import type { ReactNode, Ref } from "react";
import type { Character } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { Section, SmallButton } from "../tokens/ui.tsx";
import { useOpenPcStats } from "./open.ts";
import { PcStatsView } from "./PcStatsView.tsx";

/**
 * A player character's "Stat block" section (docs/design-v1-pc-stats.md
 * 7.1 and 7.3), for the DM and the character's players, in its token's
 * panel under the image and on its card. Without a block it holds the
 * summary line and "Add a stat block" on the heading's row. With one it is
 * the disclosure "Stat block", the summary under the heading folded or
 * open, and the view with Edit.
 */
export function PcStatBlock(props: {
  character: Character;
  fold: { open: boolean; onToggle(): void; foldRef?: Ref<HTMLButtonElement> };
  /** The token's summary line, under the heading whether the block is open or folded. */
  summary?: ReactNode;
}) {
  const { character, fold } = props;
  const openStats = useOpenPcStats();
  if (!character.stats) {
    return (
      <Section
        title="Stat block"
        aside={
          <SmallButton ref={fold.foldRef} wrap onClick={() => openStats(character.id)}>
            Add a stat block
          </SmallButton>
        }
      >
        {props.summary}
      </Section>
    );
  }
  return (
    <Section title="Stat block" fold={{ ...fold, summary: props.summary ? <div style={{ flexBasis: "100%", minWidth: 0, paddingBottom: theme.space(1) }}>{props.summary}</div> : undefined }}>
      <PcStatsView character={character} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <SmallButton onClick={() => openStats(character.id)}>Edit</SmallButton>
      </div>
    </Section>
  );
}
