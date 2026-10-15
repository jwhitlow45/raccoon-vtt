import { keys } from "../keys.ts";
import type { SavedEncounter } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * Fights the DM builds ahead (features section 10). An encounter only names
 * its monsters and places nothing itself: the builder places it with
 * ordinary token creates, so saving, editing or deleting one never touches
 * a scene, and it may name a room monster deleted since.
 */
export function savedEncounterCreate(tx: Tx, op: OpOf<"savedEncounter.create">): void {
  if (tx.state.savedEncounters[op.encounter.id]) throw invalid("encounter already exists");
  tx.write(keys.savedEncounter(op.encounter.id), { ...op.encounter, rev: 0 });
}

export function savedEncounterUpdate(tx: Tx, op: OpOf<"savedEncounter.update">): void {
  const encounter = tx.state.savedEncounters[op.encounterId];
  if (!encounter) throw gone("encounter");
  const next: SavedEncounter = { ...encounter };
  const { name, monsters, party } = op.patch;
  if (name !== undefined) next.name = name;
  if (monsters !== undefined) next.monsters = monsters;
  if (party === null) delete next.party;
  else if (party !== undefined) next.party = party;
  tx.write(keys.savedEncounter(encounter.id), next);
}

export function savedEncounterDelete(tx: Tx, op: OpOf<"savedEncounter.delete">): void {
  if (!tx.state.savedEncounters[op.encounterId]) throw gone("encounter");
  tx.remove(keys.savedEncounter(op.encounterId));
}
