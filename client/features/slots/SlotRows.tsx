import { useEffect, useId, useRef, useState } from "react";
import type { CharacterId } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { CountPips, countWords } from "../../components/CountPips.tsx";
import { buttonLook } from "../../components/looks.ts";
import { theme } from "../../lib/theme.ts";
import type { OnAnswer } from "../../state/types.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { useAnyPending } from "../encounter/hooks.ts";
import { reasonText } from "../resources/logic.ts";
import { CountRowHead, RowButton } from "../resources/ResourceRows.tsx";
import {
  FOLDED_NAME,
  foldedBack,
  foldedUse,
  leftByLevel,
  PACT_BACK,
  PACT_BACK_LABEL,
  PACT_EMPTY,
  PACT_FULL,
  pactName,
  pactOp,
  pactUseLabel,
  slotBackLabel,
  slotCount,
  slotEmptyText,
  slotFullText,
  slotLevels,
  slotName,
  slotOp,
  slotUseLabel,
  SLOT_BACK,
  type SlotLevel,
} from "./logic.ts";

/**
 * Where a character's slot rows stand (docs/design/design-v1-slots.md 3.2):
 * `full` is one class resource row per slot level, in the panel, the page,
 * the tracker row and the token window, `folded` the turn card's one
 * "Spell slots" row, and `drawer` the folded row of the bar's Uses drawer on
 * a phone held upright, with Restore a slot… too.
 */
export type SlotForm = "full" | "folded" | "drawer";

/**
 * A character's spell slots and Pact Magic slots as rows, after its class
 * resources wherever those show (D-261127-078), with one status line under
 * them that says why a tap was refused. Nothing for a character without
 * slots, or for a viewer whose copy holds no classes: they reach only the
 * DM and the character's players.
 */
export function SlotRows(props: { characterId: CharacterId; form: SlotForm; label: string; search?: string }) {
  const character = useRoomView((s) => s.view?.characters[props.characterId]);
  const [status, setStatus] = useState<string | null>(null);
  if (!character || slotCount(character.classes) === 0) return null;
  const { levels, pact } = slotLevels(character);
  const folded = props.form !== "full";
  return (
    <div data-slot-rows={props.form} data-search={props.search} style={{ display: "grid", gap: theme.space(1) }}>
      <ul aria-label={props.label} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(3) }}>
        {folded ? (
          levels.length > 0 ? <FoldedRow characterId={character.id} levels={levels} back={props.form === "drawer"} onStatus={setStatus} /> : null
        ) : (
          levels.map((s) => <SlotRow key={s.level} characterId={character.id} slot={s} onStatus={setStatus} />)
        )}
        {pact ? <PactRow characterId={character.id} pact={pact} back={props.form !== "folded"} onStatus={setStatus} /> : null}
      </ul>
      {status ? (
        <p role="status" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
          {status}
        </p>
      ) : null}
    </div>
  );
}

/** One use op at a time, busy and deaf to a second tap until its answer, a refusal said in the list's status line. */
function useSlotSend(onStatus: (text: string | null) => void) {
  const actions = useRoomActions();
  const [sent, setSent] = useState<{ n: number; key: string } | null>(null);
  const busy = useAnyPending(sent === null ? [] : [sent.n]);
  return {
    busy: busy ? (sent?.key ?? null) : null,
    send(key: string, op: ClientOp) {
      if (busy) return;
      const onAnswer: OnAnswer = (answer, refusal) => onStatus(answer === "refused" ? reasonText(refusal) : null);
      const n = actions.dispatch(op, { quiet: true, onAnswer });
      if (n === null) onStatus("That could not be sent.");
      else setSent({ n, key });
    },
  };
}

/** One slot level as a class resource row (D-261127-273): "Level 3 spell slots", its pips, "Back on a Long Rest", Use and Restore. */
function SlotRow(props: { characterId: CharacterId; slot: SlotLevel; onStatus(text: string | null): void }) {
  const s = props.slot;
  const id = useId();
  const sender = useSlotSend(props.onStatus);
  return (
    <li data-slot-level={s.level} style={{ display: "grid", gap: theme.space(1) }}>
      <CountRowHead
        name={slotName(s.level)}
        spoken={countWords({ left: s.left, max: s.max })}
        end={<CountPips left={s.left} max={s.max} />}
        sub={SLOT_BACK}
        hidden={
          <>
            <span id={`${id}-none`} hidden>
              {slotEmptyText(s.level)}
            </span>
            <span id={`${id}-full`} hidden>
              {slotFullText(s.level)}
            </span>
          </>
        }
      >
        <RowButton label={slotUseLabel(s)} off={s.left === 0 ? `${id}-none` : undefined} busy={sender.busy === "use"} onClick={() => sender.send("use", slotOp(props.characterId, s.level, false))}>
          Use
        </RowButton>
        <RowButton label={slotBackLabel(s.level)} off={s.left >= s.max ? `${id}-full` : undefined} busy={sender.busy === "back"} onClick={() => sender.send("back", slotOp(props.characterId, s.level, true))}>
          Restore
        </RowButton>
      </CountRowHead>
    </li>
  );
}

/** Pact Magic's one row: "Pact Magic, level 3", "Back on a Short or Long Rest", Use, and Restore off the turn card. */
function PactRow(props: { characterId: CharacterId; pact: { slots: number; level: number; left: number }; back: boolean; onStatus(text: string | null): void }) {
  const p = props.pact;
  const id = useId();
  const sender = useSlotSend(props.onStatus);
  return (
    <li data-slot-pact="" style={{ display: "grid", gap: theme.space(1) }}>
      <CountRowHead
        name={pactName(p)}
        spoken={countWords({ left: p.left, max: p.slots })}
        end={<CountPips left={p.left} max={p.slots} />}
        sub={PACT_BACK}
        hidden={
          <>
            <span id={`${id}-none`} hidden>
              {PACT_EMPTY}
            </span>
            <span id={`${id}-full`} hidden>
              {PACT_FULL}
            </span>
          </>
        }
      >
        <RowButton label={pactUseLabel(p)} off={p.left === 0 ? `${id}-none` : undefined} busy={sender.busy === "use"} onClick={() => sender.send("use", pactOp(props.characterId, false))}>
          Use
        </RowButton>
        {props.back ? (
          <RowButton label={PACT_BACK_LABEL} off={p.left >= p.slots ? `${id}-full` : undefined} busy={sender.busy === "back"} onClick={() => sender.send("back", pactOp(props.characterId, true))}>
            Restore
          </RowButton>
        ) : null}
      </CountRowHead>
    </li>
  );
}

/**
 * The slots folded to one row (D-261127-360), for the turn card and the
 * phone's drawer, whose column holds about 650 px: "Spell slots" with what
 * is left by level, and Use a slot…, which opens one 44 px button per level
 * under the row, wrapping, as a pool's Use… opens its field. The drawer
 * adds Restore a slot…. Escape or a second tap closes it, and Escape hands
 * focus back to the button that opened it.
 */
function FoldedRow(props: { characterId: CharacterId; levels: readonly SlotLevel[]; back: boolean; onStatus(text: string | null): void }) {
  const [open, setOpen] = useState<"use" | "back" | null>(null);
  const sender = useSlotSend(props.onStatus);
  const useButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);
  const toggle = (next: "use" | "back") => {
    props.onStatus(null);
    setOpen(open === next ? null : next);
  };
  const close = () => {
    const from = open === "back" ? backButton.current : useButton.current;
    setOpen(null);
    from?.focus();
  };
  const line = leftByLevel(props.levels);
  return (
    <li data-slot-folded="" style={{ display: "grid", gap: theme.space(1) }}>
      <CountRowHead name={FOLDED_NAME} spoken={line} end={null} sub={<span aria-hidden="true">{line}</span>}>
        <Button ref={useButton} size="sm" expanded={open === "use"} aria-controls={open === "use" ? `${id}-levels` : undefined} onClick={() => toggle("use")} style={{ whiteSpace: "nowrap", flex: "1 1 auto" }}>
          Use a slot…
        </Button>
        {props.back ? (
          <Button ref={backButton} size="sm" expanded={open === "back"} aria-controls={open === "back" ? `${id}-levels` : undefined} onClick={() => toggle("back")} style={{ whiteSpace: "nowrap", flex: "1 1 auto" }}>
            Restore a slot…
          </Button>
        ) : null}
      </CountRowHead>
      {open ? (
        <div
          ref={panel}
          id={`${id}-levels`}
          role="group"
          aria-label={open === "use" ? "Use a slot" : "Restore a slot"}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // Only the levels close, never the card or drawer around them.
            e.stopPropagation();
            close();
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}
        >
          {props.levels.map((s) => {
            const words = open === "use" ? foldedUse(s) : foldedBack(s);
            const off = open === "use" ? (s.left === 0 ? slotEmptyText(s.level) : null) : s.left >= s.max ? slotFullText(s.level) : null;
            const key = `${open}:${s.level}`;
            return (
              <span key={key} style={{ display: "contents" }}>
                <Button
                  size="sm"
                  aria-label={words.label}
                  aria-disabled={off !== null || undefined}
                  aria-describedby={off !== null ? `${id}-${s.level}-off` : undefined}
                  busy={sender.busy === key}
                  onClick={() => (off !== null ? props.onStatus(off) : sender.send(key, slotOp(props.characterId, s.level, open === "back")))}
                  style={{ whiteSpace: "nowrap", flex: "1 1 auto", ...(off !== null ? { ...buttonLook("secondary", { disabled: true }), cursor: "default" } : null) }}
                >
                  {words.text}
                </Button>
                {off !== null ? (
                  <span id={`${id}-${s.level}-off`} hidden>
                    {off}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
    </li>
  );
}
