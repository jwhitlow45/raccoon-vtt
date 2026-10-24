import { useRef, useState, type ReactNode } from "react";
import type { Character } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { levelUps } from "#shared/rules/classResources.ts";
import type { IconName } from "../../components/Icon.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { Section, SmallButton } from "../tokens/ui.tsx";
import { updateTitle } from "./logic.ts";
import { ResourceList } from "./ResourceRows.tsx";
import { ResourceSheet, type SheetMode } from "./ResourceSheet.tsx";

/**
 * A character's Class resources (docs/design-v1-combat-controls.md 7.2),
 * after Rest in the token panel's Combat group and on the character's
 * page: each with its count, Use or Use…, Restore and Edit, then Add.
 * A level that rose past what a class's presets were read at asks once per
 * class to update them. Only the DM and the character's players are given
 * this section, and both may change it all.
 */
export function ClassResourcesSection(props: { character: Character }) {
  const { character } = props;
  const resources = character.resources ?? [];
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = (mode: SheetMode, from: HTMLElement | null) => {
    opener.current = from;
    setSheet(mode);
  };
  const full = resources.length >= LIMITS.resourcesPerCharacter;
  return (
    <Section title="Class resources">
      {levelUps(resources, character.level).map((up) => (
        <div key={up.classId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1) }}>
          <p style={{ flex: "1 1 160px", minWidth: 0, margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body }}>{`Your level went up. ${updateTitle(up.classId)}?`}</p>
          <OpenerButton onOpen={(from) => open({ kind: "update", up }, from)}>Update</OpenerButton>
        </div>
      ))}
      {resources.length > 0 ? (
        <ResourceList characterId={character.id} resources={resources} back edit={(r, from) => open({ kind: "edit", id: r.id }, from)} />
      ) : (
        <Help>Count Rage, Channel Divinity, Lay on Hands and the like here, picked by class and level, typed, or brought in with Re-sync from D&D Beyond.</Help>
      )}
      {full ? (
        <Help>{`A character holds at most ${LIMITS.resourcesPerCharacter} class resources. Remove one to add another.`}</Help>
      ) : (
        <div>
          <OpenerButton icon="plus" onOpen={(from) => open({ kind: "add" }, from)}>
            Add a class resource
          </OpenerButton>
        </div>
      )}
      {sheet ? <ResourceSheet character={character} mode={sheet} opener={opener} onClose={() => setSheet(null)} /> : null}
    </Section>
  );
}

/** A small button that hands the sheet it opens the element to give focus back to. */
function OpenerButton(props: { onOpen(from: HTMLElement | null): void; icon?: IconName; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <SmallButton ref={ref} icon={props.icon} onClick={() => props.onOpen(ref.current)}>
      {props.children}
    </SmallButton>
  );
}
