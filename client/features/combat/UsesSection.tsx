import { useEffect, useRef, useState, type ReactNode } from "react";
import { LIMITS } from "#shared/limits.ts";
import type { Character } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { levelUps } from "#shared/rules/classResources.ts";
import type { IconName } from "../../components/Icon.tsx";
import { Help } from "../../components/Panel.tsx";
import { handFocusNow } from "../../lib/handFocus.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { LegendaryPips } from "../encounter/Pips.tsx";
import { updateTitle } from "../resources/logic.ts";
import { ResourceSheet, type SheetMode } from "../resources/ResourceSheet.tsx";
import { Section, SmallButton } from "../tokens/ui.tsx";
import { CreatureUses, useUsesPresence } from "./CombatUses.tsx";

/** What Uses says with nothing in it, where class resources are added (the D&D Beyond stack's words). */
export const NOTHING_TO_LIST = "Count Rage, Channel Divinity, Lay on Hands and the like here, picked by class and level, typed, or brought in with Re-sync from D&D Beyond.";

/** Add a class resource's box, where focus goes when the sheet's opener went with what it saved. */
const ADD_BOX = "[data-uses-add]";

/**
 * Combat's Uses section on the token panel and a character's page
 * (docs/design-v1-token-sections.md 3.1): the one list the token bar's
 * drawer and the tracker row's group show, for the DM and the creature's
 * owners while it has something in it. For the DM, the legendary pips
 * under it. With `character`, the character whose class resources this
 * viewer edits (the DM and its players, never a player lent only its
 * token), it also stands with nothing in it, so Add is reached: each
 * resource gains Edit on its button line, a level that rose past what a
 * class's presets were read at asks once per class to update them, and
 * Add, or the limit's line, comes last.
 */
export function UsesSection(props: { target: ActorTarget; name: string; character?: Character }) {
  const { character } = props;
  const presence = useUsesPresence(props.target);
  const dm = useRoomView((s) => s.you?.role === "dm");
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLElement | null>(null);
  /*
   * The sheet gives focus back to its opener as it closes. What it saved
   * can take the opener with it: Remove takes the resource's Edit, and an
   * answered level-up takes its line's Update. Focus then goes to Add,
   * else the section's first control, never the page (D-261024-43). This
   * runs after the commit that closed the sheet, so its own hand-back has
   * had its turn.
   */
  useEffect(() => {
    if (sheet === null) handFocusNow(box.current, opener.current, [`${ADD_BOX} button`, "button"]);
  }, [sheet]);
  if (!character && presence === "no") return null;
  const open = (mode: SheetMode, from: HTMLElement | null) => {
    opener.current = from;
    box.current = from?.closest("section") ?? null;
    setSheet(mode);
  };
  const resources = character?.resources ?? [];
  const full = resources.length >= LIMITS.resourcesPerCharacter;
  return (
    <Section title="Uses">
      {character
        ? levelUps(resources, character.level).map((up) => (
            <div key={up.classId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1) }}>
              <p style={{ flex: "1 1 160px", minWidth: 0, margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body }}>{`Your level went up. ${updateTitle(up.classId)}?`}</p>
              <OpenerButton onOpen={(from) => open({ kind: "update", up }, from)}>Update</OpenerButton>
            </div>
          ))
        : null}
      <CreatureUses target={props.target} name={props.name} edit={character ? (r, from) => open({ kind: "edit", id: r.id }, from) : undefined} pips={dm ? <LegendaryPips target={props.target} /> : null} />
      {character && presence === "no" ? <Help>{NOTHING_TO_LIST}</Help> : null}
      {!character ? null : full ? (
        <Help>{`A character holds at most ${LIMITS.resourcesPerCharacter} class resources. Remove one to add another.`}</Help>
      ) : (
        <div data-uses-add="">
          <OpenerButton icon="plus" onOpen={(from) => open({ kind: "add" }, from)}>
            Add a class resource
          </OpenerButton>
        </div>
      )}
      {sheet && character ? <ResourceSheet character={character} mode={sheet} opener={opener} onClose={() => setSheet(null)} /> : null}
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
