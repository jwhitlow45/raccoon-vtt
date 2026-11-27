import { useEffect, useId, useRef, useState } from "react";
import { uuidv7 } from "#shared/ids.ts";
import type { Actor, Character, HitDieSize } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { CountPips, countWords } from "../../components/CountPips.tsx";
import { FieldRow, Input, NUMBER_FIELD_WIDTH } from "../../components/Field.tsx";
import { theme } from "../../lib/theme.ts";
import type { OnAnswer } from "../../state/types.ts";
import { useRoomActions } from "../../state/view.ts";
import { rollTrouble, useCardRoll } from "../encounter/CardRoll.tsx";
import { useAnyPending } from "../encounter/hooks.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { useCharacterRollNumbers } from "../pcstats/useRollNumbers.ts";
import { reasonText } from "../resources/logic.ts";
import { CountRowHead, RowButton } from "../resources/ResourceRows.tsx";
import { RollResultLine } from "../rolls/card.ts";
import {
  conOf,
  conSource,
  dieBackLabel,
  dieFullText,
  dieName,
  dieRows,
  hitDiceLine,
  hitDieOp,
  hitDieRollOp,
  rolledText,
  rollLabel,
  rollText,
  spendOff,
  typedLabel,
  typedOutcome,
  type DieRow,
} from "./logic.ts";

/** The muted count line under the rest choice (docs/design/design-v1-slots.md 3.3): "Hit Point Dice: 3 of 5 d10". Nothing without classes. */
export function HitDiceCount(props: { character: Pick<Character, "classes" | "spent">; search?: string }) {
  const line = hitDiceLine(dieRows(props.character));
  return line ? <div data-search={props.search} style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>{line}</div> : null;
}

/** The device's typed Constitution modifier for a character, kept in this browser alone (D-261127-091). */
function conKey(characterId: string): string {
  return `raccoon.hitDieCon.${characterId}`;
}
function readCon(characterId: string): string {
  try {
    return localStorage.getItem(conKey(characterId)) ?? "";
  } catch {
    return "";
  }
}
function writeCon(characterId: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(conKey(characterId), text.trim());
    else localStorage.removeItem(conKey(characterId));
  } catch {
    // A private window or blocked site data: the field still works for this visit.
  }
}

/**
 * The Short Rest card's die rows (3.3): one per die size, largest first,
 * each with Roll, which rolls one die plus Constitution on the server and
 * heals by it at once, Type a roll…, which spends one die for a roll made
 * at the table, and Restore. Constitution is the modifier the Dice panel
 * rolls with, the stat block's or a shape's mixed in. Only with no block
 * and no shape does a field stand above the rows, which this device keeps.
 */
export function HitDiceRows(props: { character: Character; actor: Pick<Actor, "hp" | "srdId"> | undefined }) {
  const { character } = props;
  const rows = dieRows(character);
  const read = useCharacterRollNumbers(rows.length > 0 ? character.id : null);
  const shaped = character.actor.srdId !== undefined;
  const source = conSource({ shaped, hasBlock: character.stats !== undefined, numbersCon: read.numbers?.abilities.con.mod, loading: read.loading, failed: read.failed });
  const [conText, setConText] = useState(() => readCon(character.id));
  const [status, setStatus] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const typedCon = conOf(conText);
  const con = source.kind === "numbers" ? source.con : source.kind === "field" ? (typedCon ?? 0) : null;
  const sendCon = source.kind === "field" ? (typedCon ?? 0) : undefined;
  return (
    <div data-hit-dice="" style={{ display: "grid", gap: theme.space(3) }}>
      {source.kind === "field" ? (
        <FieldRow label="Constitution modifier" hint="-5 to 10. No stat block to read it from. This device keeps it.">
          <Input
            aria-label="Constitution modifier"
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="off"
            placeholder="+0"
            value={conText}
            error={conText.trim() !== "" && typedCon === null}
            onChange={(e) => {
              setConText(e.target.value);
              writeCon(character.id, e.target.value);
            }}
            style={{ width: NUMBER_FIELD_WIDTH, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
          />
        </FieldRow>
      ) : null}
      <ul aria-label={`${character.name}'s Hit Point Dice`} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(3) }}>
        {rows.map((row) => (
          <DieLine key={row.die} character={character} hp={props.actor?.hp} row={row} con={con} sendCon={sendCon} loading={source.kind === "loading"} failed={source.kind === "failed"} onStatus={setStatus} />
        ))}
      </ul>
      {source.kind === "failed" ? <SrdLoadFailed what="The Constitution modifier" inline /> : null}
      {status ? (
        <p role="status" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
          {status}
        </p>
      ) : null}
    </div>
  );
}

/** A die row's own roll row in the roll options' store, so its result survives the card being drawn again. */
function dieRollRow(characterId: string, die: HitDieSize): string {
  return `hitDie|${characterId}|d${die}`;
}

function DieLine(props: { character: Character; hp: { cur: number; max: number } | undefined; row: DieRow; con: number | null; sendCon: number | undefined; loading: boolean; failed: boolean; onStatus(text: string | null): void }) {
  const { row, character } = props;
  const id = useId();
  const actions = useRoomActions();
  const card = useCardRoll(dieRollRow(character.id, row.die));
  const [sent, setSent] = useState<{ n: number; back: boolean } | null>(null);
  const busy = useAnyPending(sent === null ? [] : [sent.n]);
  const [typing, setTyping] = useState<{ text: string; error: string | null } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const typeButton = useRef<HTMLButtonElement>(null);
  const opening = typing !== null;
  useEffect(() => {
    if (opening) field.current?.focus();
  }, [opening]);
  const off = spendOff(row, props.hp, character.name);
  // Roll waits on Constitution: busy while the shape's numbers load, off with the load-failure line if they fail.
  const rollOff = off ?? (props.failed ? "The Constitution modifier did not load." : null);
  const first = card.rolls[0];
  const face = first?.faces[0];
  const result = first && face !== undefined ? rolledText(face, first.total - face) : null;
  const trouble = rollTrouble(card.receipt, card.unsent);

  const send = (op: ClientOp, back: boolean, after?: () => void) => {
    if (busy) return;
    const onAnswer: OnAnswer = (answer, refusal) => {
      props.onStatus(answer === "refused" ? reasonText(refusal) : null);
      if (answer === "taken") after?.();
    };
    const n = actions.dispatch(op, { quiet: true, onAnswer });
    if (n === null) props.onStatus("That could not be sent.");
    else setSent({ n, back });
  };
  const roll = () => {
    if (card.waiting || props.loading || props.con === null) return;
    props.onStatus(null);
    if (card.send(hitDieRollOp(uuidv7(), character.id, row.die, props.sendCon)) === null) props.onStatus("That roll could not be sent. Try again.");
  };
  const closeTyping = () => {
    setTyping(null);
    typeButton.current?.focus();
  };
  const spend = () => {
    if (!typing) return;
    const outcome = typedOutcome(typing.text);
    if (!outcome.ok) setTyping({ ...typing, error: outcome.error });
    else send(hitDieOp(character.id, row.die, { heal: outcome.heal }), false, closeTyping);
  };
  const con = props.con ?? 0;
  return (
    <li data-hit-die={row.die} style={{ display: "grid", gap: theme.space(1) }}>
      <CountRowHead
        name={dieName(row.die)}
        spoken={countWords({ left: row.left, max: row.max })}
        end={<CountPips left={row.left} max={row.max} />}
        sub={result || trouble ? (
          <span role="status">
            {result ? <RollResultLine text={result} /> : null}
            {trouble ? <span style={{ color: theme.color.dangerText }}>{trouble}</span> : null}
          </span>
        ) : null}
        hidden={
          <>
            {off !== null || rollOff !== null ? (
              <span id={`${id}-off`} hidden>
                {rollOff ?? off}
              </span>
            ) : null}
            <span id={`${id}-full`} hidden>
              {dieFullText(row.die)}
            </span>
          </>
        }
      >
        <RowButton label={rollLabel(row, con)} off={rollOff !== null ? `${id}-off` : undefined} busy={card.waiting || props.loading} onClick={roll}>
          {rollText(row.die, con)}
        </RowButton>
        <RowButton ref={typeButton} label={`Type a roll for a d${row.die} Hit Point Die`} off={off !== null ? `${id}-off` : undefined} expanded={typing !== null} onClick={() => (typing ? closeTyping() : (props.onStatus(null), setTyping({ text: "", error: null })))}>
          Type a roll…
        </RowButton>
        <RowButton label={dieBackLabel(row.die)} off={row.left >= row.max ? `${id}-full` : undefined} busy={busy && sent?.back === true} onClick={() => send(hitDieOp(character.id, row.die, { back: true }), true)}>
          Restore
        </RowButton>
      </CountRowHead>
      {typing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            spend();
          }}
          style={{ display: "grid", gap: theme.space(1) }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
            <Input
              ref={field}
              aria-label={typedLabel(row.die)}
              aria-describedby={typing.error ? `${id}-typed` : undefined}
              error={typing.error !== null}
              inputMode="numeric"
              enterKeyHint="done"
              autoComplete="off"
              placeholder="HP back"
              value={typing.text}
              onChange={(e) => setTyping({ text: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Only the field closes, never the sheet or panel around it.
                e.stopPropagation();
                closeTyping();
              }}
              style={{ flex: "1 1 96px", minWidth: 0, fontVariantNumeric: "tabular-nums" }}
            />
            <div style={{ flex: "1 0 auto", display: "flex", justifyContent: "flex-end", gap: theme.space(1) }}>
              <Button size="sm" variant="primary" type="submit" busy={busy && sent?.back === false}>
                Spend
              </Button>
              <Button size="sm" onClick={closeTyping}>
                Cancel
              </Button>
            </div>
          </div>
          {typing.error ? (
            <p id={`${id}-typed`} style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
              {typing.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

