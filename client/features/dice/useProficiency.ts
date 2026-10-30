import { useCallback, useMemo } from "react";
import type { D20Test } from "#shared/dice/bonus.ts";
import type { RoomState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { useRoomView } from "../../state/view.ts";
import { useSrdBlocks } from "../monsters/srdBlocks.ts";
import { creatureProficiency } from "./creature.ts";
import { marksTest } from "./proficiencyPresentation.ts";

const NONE = {};

/**
 * How proficient a creature is in a test, for a surface that names tests
 * but reads no creature's rolls of its own: the Log, Recent rolls, a
 * toast, a roll card. One call serves the whole surface, and it hears only
 * the parts of the room a mark reads, so the Log does not draw again for a
 * change elsewhere. It reads the SRD blocks only once another view has
 * loaded them, so a mark never loads a chunk of its own (FL7-R1-12), and a
 * creature whose block has not loaded shows no mark, as one whose source
 * is unknown does (D-261029-414).
 */
export function useProficiency(): (creature: ActorTarget, test: D20Test) => Proficiency {
  const you = useRoomView((s) => s.you);
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const monsters = useRoomView((s) => s.view?.monsters ?? NONE);
  const companionBlocks = useRoomView((s) => s.view?.companionBlocks ?? NONE);
  const { list } = useSrdBlocks(false);
  // creatureProficiency reads only these parts of the view (creature.ts find, shownLink and readsCharacter).
  const view = useMemo(() => (tokens && characters ? ({ tokens, characters, monsters, companionBlocks } as unknown as RoomState) : null), [tokens, characters, monsters, companionBlocks]);
  return useCallback(
    (creature: ActorTarget, test: D20Test) => (you && view && marksTest(test) ? creatureProficiency({ you, view, srd: { monsters: list, rolls: null } }, creature, test) : "none"),
    [you, view, list],
  );
}
