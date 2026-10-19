import type { AreaTemplate } from "#shared/model.ts";
import { askedArea } from "#shared/permissions.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import { areaCreatures } from "../../areas/caster.ts";
import { NO_CREATURE } from "../../areas/FromControl.tsx";
import { useOptionStore } from "../optionState.ts";
import { areaAskSpec, areaSpellName, openedBlock } from "./cast.ts";

/**
 * A player's Ask for saves on an area of their own (docs/design-v1-player-save-spell.md
 * 3.1), in the picked area's row and in the Areas panel, where the DM's
 * Save and damage stands. It opens the Dice panel on the area's caster when
 * that is theirs, else on the creature the panel has picked, with the block
 * under the row of the area's spell. While an ask names the area it reads
 * "Saves asked" and opens the panel on its waiting line, where Withdraw is.
 */
export function useAreaAsk(template: Pick<AreaTemplate, "id" | "casterId" | "spell" | "label" | "shape" | "size" | "sceneId">): { open(): void; disabled: string | null; asked: boolean; words: string; name: string } {
  const room = useRoomStore();
  const options = useOptionStore();
  const ui = useRoomUi();
  const asked = useRoomView((s) => (s.view ? askedArea(s.view, template.id) : false));
  const none = useRoomView((s) => {
    const { view, you } = s;
    return !view || !you || areaCreatures({ view, sceneId: template.sceneId, you }).length === 0;
  });
  const open = () => {
    const { view, you } = room.getState();
    if (!view || !you) return;
    const spec = areaAskSpec({ creatures: areaCreatures({ view, sceneId: template.sceneId, you }), view, template, picked: options.getState().picked });
    if (!spec) return;
    // A bar's Roll asks the panel to scroll to the options the same way (dice/optionState.ts focus). A new block brings itself into view instead (CastBlock.tsx).
    options.setState((s) => (asked ? { picked: spec.key, focus: s.focus + 1 } : openedBlock(spec)));
    ui.openPanel("dice");
  };
  const spell = areaSpellName(template);
  return {
    open,
    disabled: asked ? null : none ? NO_CREATURE : null,
    asked,
    words: asked ? "Saves asked" : "Ask for saves",
    // The disabled button says why, as the From control does.
    name: asked ? `Saves asked for ${spell}. Withdraw to change it.` : none ? NO_CREATURE : `Ask the DM for saves against ${spell}`,
  };
}
