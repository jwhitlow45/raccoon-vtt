import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { CONDITION_KEYS, CR_VALUES } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Select } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import {
  ALIGNMENTS,
  chipFocusAfter,
  CREATURE_TYPES,
  DAMAGE_TYPES,
  filterChips,
  matchesText,
  MOVEMENT_LABEL,
  MOVEMENTS,
  NO_FILTERS,
  SENSES,
  SIZES,
  titleWords,
  toggled,
  type CrValue,
  type MonsterFilters,
} from "./monsterFilters.ts";

/**
 * The search row with its Filters button, the filters that are on as chips
 * under it, and the filters sheet, for the monster browser and the
 * encounter builder. Phone first: the sheet rises from the bottom on a
 * phone and floats as a card on a wider screen, and every filter applies
 * as it is tapped, with the number of monsters it leaves on the sheet's
 * button.
 */
export function MonsterFilterBar(props: {
  filters: MonsterFilters;
  onChange(next: MonsterFilters): void;
  /** All the monsters the search and the filters leave, even where the list shows only the first few, or null while the SRD list loads. */
  count: number | null;
  /** The search field, which shares the row with the Filters button. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const chips = filterChips(props.filters);
  const close = useCallback(() => setOpen(false), []);
  const chipRow = useRef<HTMLDivElement>(null);
  // A removed chip takes its focus with it, which would drop a keyboard or screen reader user at the top of the page.
  const refocus = useRef<number | "filters" | null>(null);
  useLayoutEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    const chip = target === "filters" ? undefined : chipRow.current?.querySelectorAll<HTMLButtonElement>("button[data-chip]")[target];
    (chip ?? button.current)?.focus({ preventScroll: true });
  });
  return (
    <>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        {props.children}
        <Button
          ref={button}
          size="sm"
          icon="filter"
          aria-haspopup="dialog"
          aria-label={chips.length > 0 ? `Filters, ${chips.length} on` : "Filters"}
          onClick={() => setOpen(true)}
          style={{ flex: "none" }}
        >
          Filters
          {chips.length > 0 ? <CountBadge count={chips.length} /> : null}
        </Button>
      </div>
      {chips.length > 0 ? (
        <div ref={chipRow} role="group" aria-label="Filters that are on" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
          {chips.map((chip, i) => (
            <Chip
              key={chip.key}
              remove
              data-chip
              aria-label={`Remove the filter ${chip.label}`}
              onClick={() => {
                refocus.current = chipFocusAfter(i, chips.length - 1) ?? "filters";
                props.onChange(chip.without);
              }}
            >
              {chip.label}
            </Chip>
          ))}
          <ClearButton
            onClick={() => {
              refocus.current = "filters";
              props.onChange(NO_FILTERS);
            }}
          />
        </div>
      ) : null}
      {open ? <FilterSheet filters={props.filters} onChange={props.onChange} count={props.count} onClose={close} opener={button} /> : null}
    </>
  );
}

/** How many filters are on, as a count is shown everywhere: a status in text color, not the accent, which means "act here". */
function CountBadge(props: { count: number }) {
  return (
    <span
      aria-hidden
      style={{
        minWidth: 20,
        padding: `1px ${theme.space(1.5)}px`,
        borderRadius: theme.radius.pill,
        background: theme.color.text,
        color: theme.color.bg,
        fontSize: theme.font.tiny,
        fontWeight: theme.weight.bold,
        lineHeight: theme.leading.body,
        textAlign: "center",
      }}
    >
      {props.count}
    </span>
  );
}

/** Resets a view, so it is a quiet button: nothing is lost that one tap per chip could not put back. */
function ClearButton(props: { onClick(): void; disabled?: boolean }) {
  return (
    <Button variant="quiet" size="sm" onClick={props.onClick} disabled={props.disabled}>
      Clear filters
    </Button>
  );
}

type CrChoice = CrValue | "any";

const CR_OPTIONS: readonly { value: CrChoice; label: string }[] = [{ value: "any", label: "Any" }, ...CR_VALUES.map((cr) => ({ value: cr, label: `CR ${cr}` }))];

function FilterSheet(props: {
  filters: MonsterFilters;
  onChange(next: MonsterFilters): void;
  count: number | null;
  onClose(): void;
  opener: RefObject<HTMLButtonElement | null>;
}) {
  const { filters, onChange, onClose } = props;
  const set = (patch: Partial<MonsterFilters>) => onChange({ ...filters, ...patch });
  const crChoice = (choice: CrChoice) => (choice === "any" ? null : choice);
  const any = filterChips(filters).length > 0;

  // A phone gets a sheet from the bottom. From 600 px wide it floats as a card, as the image picker's dialog does.
  return (
    <Dialog
      title="Monster filters"
      onClose={onClose}
      opener={props.opener}
      phone="sheet"
      width="md"
      backClose
      bodyStyle={{ fontSize: theme.font.body14, paddingTop: 0, paddingBottom: theme.space(2) }}
      // The whole count, also where a list shows only its first rows, so the DM sees how much each filter narrows.
      status={<span role="status">{matchesText(props.count)}</span>}
      footer={
        <>
          <ClearButton onClick={() => onChange(NO_FILTERS)} disabled={!any} />
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {/* The chips under the search follow this order (filterChips). */}
      <Group first title="Challenge rating" hint="Or type it in the search: cr 5, cr 1-5, cr 1/2-3.">
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <CrSelect label="Lowest CR" value={filters.crMin ?? "any"} onChange={(v) => set({ crMin: crChoice(v) })} />
          <span style={{ color: theme.color.textMuted }}>to</span>
          <CrSelect label="Highest CR" value={filters.crMax ?? "any"} onChange={(v) => set({ crMax: crChoice(v) })} />
        </div>
      </Group>
      <Group title="Creature type" hint="Any type picked.">
        <Picks title="Creature type" options={CREATURE_TYPES} picked={filters.types} label={titleWords} onChange={(types) => set({ types })} />
      </Group>
      <Group title="Legendary and lair">
        <div>
          <Checkbox checked={filters.legendary} onChange={(legendary) => set({ legendary })} label="Legendary" help="Has legendary actions." />
          <Checkbox checked={filters.lair} onChange={(lair) => set({ lair })} label="Has a lair" help="More XP or legendary uses in its lair." />
        </div>
      </Group>
      <Group title="Size" hint="Any size picked. A Medium or Small creature counts as both.">
        <Picks title="Size" options={SIZES} picked={filters.sizes} label={titleWords} onChange={(sizes) => set({ sizes })} />
      </Group>
      <Fold title="Condition immunities" picked={filters.conditionImmunities.length} hint="Immune to every condition picked.">
        <Picks title="Condition immunities" options={CONDITION_KEYS} picked={filters.conditionImmunities} label={titleWords} onChange={(conditionImmunities) => set({ conditionImmunities })} />
      </Fold>
      <Fold title="Damage immunities" picked={filters.damageImmunities.length} hint="Immune to every damage type picked.">
        <Picks title="Damage immunities" options={DAMAGE_TYPES} picked={filters.damageImmunities} label={titleWords} onChange={(damageImmunities) => set({ damageImmunities })} />
      </Fold>
      <Fold title="Damage resistances" picked={filters.resistances.length} hint="Resists every damage type picked.">
        <Picks title="Damage resistances" options={DAMAGE_TYPES} picked={filters.resistances} label={titleWords} onChange={(resistances) => set({ resistances })} />
      </Fold>
      <Fold title="Damage vulnerabilities" picked={filters.vulnerabilities.length} hint="Vulnerable to every damage type picked.">
        <Picks title="Damage vulnerabilities" options={DAMAGE_TYPES} picked={filters.vulnerabilities} label={titleWords} onChange={(vulnerabilities) => set({ vulnerabilities })} />
      </Fold>
      <Fold title="Movement" picked={filters.movement.length} hint="Every kind picked.">
        <Picks title="Movement" options={MOVEMENTS} picked={filters.movement} label={(m) => MOVEMENT_LABEL[m]} onChange={(movement) => set({ movement })} />
      </Fold>
      <Fold title="Senses" picked={filters.senses.length} hint="Every sense picked.">
        <Picks title="Senses" options={SENSES} picked={filters.senses} label={titleWords} onChange={(senses) => set({ senses })} />
      </Fold>
      <Fold title="Alignment" picked={filters.alignments.length} hint="Any alignment picked.">
        <Picks title="Alignment" options={ALIGNMENTS} picked={filters.alignments} label={titleWords} onChange={(alignments) => set({ alignments })} />
      </Fold>
    </Dialog>
  );
}

function CrSelect(props: { label: string; value: CrChoice; onChange(value: CrChoice): void }) {
  return (
    <Select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value as CrChoice)} style={{ flex: 1, maxWidth: "100%" }}>
      {CR_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

/** A SectionLabel's look, for the folded groups, whose label is the button that unfolds them. */
const LABEL_STYLE: CSSProperties = {
  fontSize: theme.font.small,
  fontWeight: theme.weight.bold,
  letterSpacing: theme.caps,
  textTransform: "uppercase",
  lineHeight: theme.leading.tight,
  color: theme.color.textMuted,
};

function Group(props: { title: string; hint?: string; first?: boolean; children: ReactNode }) {
  return (
    <Section label={props.title} divider={props.first !== true} style={{ paddingTop: theme.space(3), paddingBottom: theme.space(3) }}>
      {props.hint ? <Help>{props.hint}</Help> : null}
      {props.children}
    </Section>
  );
}

/**
 * A group folded away until it is wanted, so the sheet opens short on a
 * phone. It starts open when something in it is picked, so a filter that
 * is on is never hidden.
 */
function Fold(props: { title: string; hint: string; picked: number; children: ReactNode }) {
  const [open, setOpen] = useState(props.picked > 0);
  const id = useId();
  return (
    <section style={{ borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
      <h3 style={{ margin: 0 }}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: theme.space(2),
            width: "100%",
            minHeight: theme.touch,
            padding: 0,
            border: "none",
            background: "transparent",
            color: theme.color.textMuted,
            fontFamily: theme.font.body,
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <span style={{ ...LABEL_STYLE, flex: 1 }}>{props.title}</span>
          {props.picked > 0 ? <Tag>{props.picked} on</Tag> : null}
          <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />
        </button>
      </h3>
      <div id={id} hidden={!open} style={{ display: "grid", gap: theme.space(2), paddingBottom: theme.space(3) }}>
        <Help>{props.hint}</Help>
        {props.children}
      </div>
    </section>
  );
}

/** One filter Chip per option, in the options' order. */
function Picks<T extends string>(props: { title: string; options: readonly T[]; picked: readonly T[]; label(value: NoInfer<T>): string; onChange(next: T[]): void }) {
  return (
    <ChipRow label={props.title}>
      {props.options.map((o) => (
        <Chip key={o} pressed={props.picked.includes(o)} onClick={() => props.onChange(toggled(props.options, props.picked, o))}>
          {props.label(o)}
        </Chip>
      ))}
    </ChipRow>
  );
}
