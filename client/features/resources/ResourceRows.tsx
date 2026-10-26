import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import type { CharacterId, ClassResource } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { CountPips, countWords, NameLine } from "../../components/CountPips.tsx";
import { Input } from "../../components/Field.tsx";
import { buttonLook } from "../../components/looks.ts";
import { theme } from "../../lib/theme.ts";
import type { OnAnswer } from "../../state/types.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { useAnyPending } from "../encounter/hooks.ts";
import { amountOutcome, backLabel, emptyText, fullText, left, reasonText, RESET_WORDS, useLabel } from "./logic.ts";

/**
 * Where a character's class resource rows stand
 * (docs/design-v1-combat-controls.md 7.2): `card` in its turn card, and
 * `list` in its tracker row's Uses group and its token bar's Uses drawer,
 * the off-turn list.
 */
export type ResourceRowsForm = "card" | "list";

/**
 * A character's class resources as rows, each with its count and Use, Use…
 * for a pool, and Restore (docs/design-v1-combat-controls.md 7.2).
 * The turn card shows Use alone, as its rows are the turn's menu, and the
 * off-turn list adds Restore, and Edit where the Combat section's Uses
 * passes `edit`. Nothing at all for a character with none, or for a
 * viewer whose copy holds none, since they reach only the DM and the
 * character's players.
 */
export function ClassResourceRows(props: { characterId: CharacterId; form: ResourceRowsForm; label: string; edit?(r: ClassResource, opener: HTMLElement): void }) {
  const resources = useRoomView((s) => s.view?.characters[props.characterId]?.resources);
  if (!resources || resources.length === 0) return null;
  return <ResourceList characterId={props.characterId} resources={resources} back={props.form === "list"} label={props.label} edit={props.edit} />;
}

/**
 * The rows themselves, with one status line under them that says why a tap
 * was refused, such as the last use spent first on another device.
 */
function ResourceList(props: { characterId: CharacterId; resources: readonly ClassResource[]; back: boolean; label: string; edit?(r: ClassResource, opener: HTMLElement): void }) {
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div data-resource-list style={{ display: "grid", gap: theme.space(1) }}>
      <ul aria-label={props.label} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(3) }}>
        {props.resources.map((r) => (
          <ResourceRow key={r.id} characterId={props.characterId} resource={r} back={props.back} edit={props.edit} onStatus={setStatus} />
        ))}
      </ul>
      {status ? (
        <p role="status" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
          {status}
        </p>
      ) : null}
    </div>
  );
}

export type Amount = { verb: "Spend" | "Restore"; text: string; error: string | null };

/**
 * What a pool's open amount field becomes as its counts change under it:
 * the same field while there is something to spend or restore, else
 * closed, with the row's own words for why, once another device spent the
 * last or restored the rest. It never asks for 1 to 0.
 *
 * `sending` is this row's own use waiting for its answer. The page shows a
 * use before the server answers, so spending the whole pool here empties it
 * at once: the field closes with no words then, as nothing went wrong, and
 * a refusal still says why when it comes.
 */
export function amountFor(opened: Amount | null, r: Pick<ClassResource, "name" | "max" | "used" | "pool">, sending: boolean): { amount: Amount | null; gone: string | null } {
  if (!opened) return { amount: null, gone: null };
  const most = opened.verb === "Spend" ? left(r) : r.used;
  if (most > 0) return { amount: opened, gone: null };
  return { amount: null, gone: sending ? null : opened.verb === "Spend" ? emptyText(r) : fullText(r) };
}

/**
 * One resource: its name and count over the rest that brings it back, and
 * its buttons on a line of their own under its words, as the uses rows
 * around them in a turn card, a row's Uses group and a bar's Uses drawer
 * stand (combat/CombatUses.tsx). Beside the words where they fit, a row
 * with short words, such as Lay on Hands' "Back on a Long Rest", would
 * stand a line shorter than one whose words push its Use under them, such
 * as Channel Divinity's. A pool's Use…
 * and Restore… open an amount field under the row, 16 px and numeric,
 * with Spend or Restore and Cancel. A button waits for the server's
 * answer, busy and deaf to a second tap, since the rules of a use are the
 * server's.
 */
function ResourceRow(props: { characterId: CharacterId; resource: ClassResource; back: boolean; edit?(r: ClassResource, opener: HTMLElement): void; onStatus(text: string | null): void }) {
  const r = props.resource;
  const actions = useRoomActions();
  const [sent, setSent] = useState<{ n: number; back: boolean } | null>(null);
  const busy = useAnyPending(sent === null ? [] : [sent.n]);
  const [opened, setAmount] = useState<Amount | null>(null);
  const { amount, gone } = amountFor(opened, r, busy);
  const shut = opened !== null && amount === null;
  const amountField = useRef<HTMLInputElement>(null);
  const fieldFocused = useRef(false);
  const useButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const remaining = left(r);
  const pool = r.pool === true;
  const verb = amount?.verb;

  // The field takes focus as it opens, and again when Use… and Restore… swap it.
  useEffect(() => {
    if (verb) amountField.current?.focus();
  }, [verb]);

  // The field closed under the player, its pool emptied or filled: the list's status line says why when another device did it, and focus the field held goes to Use….
  useEffect(() => {
    if (!shut) return;
    setAmount(null);
    if (gone !== null) props.onStatus(gone);
    if (fieldFocused.current) useButton.current?.focus();
    fieldFocused.current = false;
  }, [shut]);

  const closeAmount = () => {
    setAmount(null);
    useButton.current?.focus();
  };
  const send = (op: ClientOp, back: boolean) => {
    if (busy) return;
    const onAnswer: OnAnswer = (answer, refusal) => {
      props.onStatus(answer === "refused" ? reasonText(refusal) : null);
      if (answer === "taken" && amount) closeAmount();
    };
    const n = actions.dispatch(op, { quiet: true, onAnswer });
    if (n === null) props.onStatus("That could not be sent.");
    else setSent({ n, back });
  };
  const use = (back: boolean, value?: number) =>
    send({ t: "actor.use", target: { characterId: props.characterId }, use: { kind: "resource", id: r.id, ...(value !== undefined ? { amount: value } : {}) }, ...(back ? { back: true as const } : {}) }, back);
  const submitAmount = () => {
    if (!amount) return;
    const outcome = amountOutcome(amount.text, amount.verb === "Spend" ? remaining : r.used, amount.verb);
    if (!outcome.ok) setAmount({ ...amount, error: outcome.error });
    else use(amount.verb === "Restore", outcome.amount);
  };
  // A field opened anew takes away the last reason, such as a pool another device emptied, which no longer holds.
  const toggle = (next: Amount["verb"]) => {
    props.onStatus(null);
    setAmount(verb === next ? null : { verb: next, text: "", error: null });
  };

  return (
    <li style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1), minHeight: theme.touch }}>
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          {/*
           * The count stands at the name line's right end, as pips do for monster rows (docs/design-v1-monster-uses.md 3.7).
           * A pool keeps its words at every size: it is spent by an amount, not a pip at a time, and a small one would flip to words as it grows (D-261026-2).
           */}
          <NameLine name={r.name} spoken={countWords({ left: remaining, max: r.max })} end={<CountPips left={remaining} max={r.max} words={pool} />} />
          <div style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>{RESET_WORDS[r.reset]}</div>
        </div>
        <div style={{ flex: "1 1 100%", minWidth: 0, maxWidth: "100%", display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
          <RowButton
            ref={useButton}
            label={useLabel(r)}
            off={remaining === 0 ? `${id}-none` : undefined}
            busy={busy && amount === null && sent?.back === false}
            expanded={pool ? verb === "Spend" : undefined}
            onClick={() => (pool ? toggle("Spend") : use(false))}
          >
            {pool ? "Use…" : "Use"}
          </RowButton>
          {props.back ? (
            <RowButton
              label={backLabel(r)}
              off={r.used === 0 ? `${id}-full` : undefined}
              busy={busy && amount === null && sent?.back === true}
              expanded={pool ? verb === "Restore" : undefined}
              onClick={() => (pool ? toggle("Restore") : use(true))}
            >
              {pool ? "Restore…" : "Restore"}
            </RowButton>
          ) : null}
          {props.edit ? (
            // The pencil alone, at its 44 px, so Use and Restore take the rest of the line (docs/design-v1-token-sections.md 3.1).
            <Button size="sm" icon="edit" iconOnly="always" onClick={(e) => props.edit?.(r, e.currentTarget)} style={{ flex: "none" }}>
              {`Edit ${r.name}`}
            </Button>
          ) : null}
        </div>
        {/* What an off button's description reads. Hidden, as a description may name a hidden element. */}
        <span id={`${id}-none`} hidden>
          {emptyText(r)}
        </span>
        <span id={`${id}-full`} hidden>
          {fullText(r)}
        </span>
      </div>
      {amount ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitAmount();
          }}
          onFocus={() => (fieldFocused.current = true)}
          onBlur={() => (fieldFocused.current = false)}
          style={{ display: "grid", gap: theme.space(1) }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
            <Input
              ref={amountField}
              aria-label={amount.verb === "Spend" ? `${r.name} to spend, up to ${remaining}` : `${r.name} to restore, up to ${r.used}`}
              aria-describedby={amount.error ? `${id}-amount` : undefined}
              error={amount.error !== null}
              inputMode="numeric"
              enterKeyHint="done"
              autoComplete="off"
              placeholder={amount.verb === "Spend" ? `1 to ${remaining}` : `1 to ${r.used}`}
              value={amount.text}
              onChange={(e) => setAmount({ ...amount, text: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Only the field closes, never the sheet or panel around it.
                e.stopPropagation();
                closeAmount();
              }}
              style={{ flex: "1 1 96px", minWidth: 0, fontVariantNumeric: "tabular-nums" }}
            />
            {/* One part, so a narrow row wraps both buttons under the field together, never Cancel alone. */}
            <div style={{ flex: "1 0 auto", display: "flex", justifyContent: "flex-end", gap: theme.space(1) }}>
              <Button size="sm" variant="primary" type="submit" busy={busy}>
                {amount.verb}
              </Button>
              <Button size="sm" onClick={closeAmount}>
                Cancel
              </Button>
            </div>
          </div>
          {amount.error ? (
            <p id={`${id}-amount`} style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
              {amount.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

/**
 * A row's Use or Restore. Off, it keeps its focus and says why through
 * the line `off` names (docs/design-v1-combat-controls.md 9), rather than
 * dropping out of the Tab order as a disabled button would.
 */
function RowButton(props: { ref?: Ref<HTMLButtonElement>; label: string; off?: string; busy?: boolean; expanded?: boolean; onClick(): void; children: ReactNode }) {
  const off = props.off !== undefined;
  return (
    <Button
      ref={props.ref}
      size="sm"
      aria-label={props.label}
      aria-disabled={off || undefined}
      aria-describedby={props.off}
      expanded={props.expanded}
      busy={props.busy}
      onClick={off ? undefined : props.onClick}
      style={{ whiteSpace: "nowrap", flex: "1 1 auto", ...(off ? { ...buttonLook("secondary", { disabled: true }), cursor: "default" } : null) }}
    >
      {props.children}
    </Button>
  );
}
