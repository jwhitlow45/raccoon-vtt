import { useId, useState, type ReactNode, type Ref } from "react";
import type { Character, PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { bulkIds, bulkPressed, bulkToggle, SYNC_GROUPS, type AlsoItem, type SyncGroup, type SyncItem, type SyncPlan, type SyncResult, type SyncSection } from "#shared/rules/pcSync.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Notice } from "../../components/Notice.tsx";
import { SectionLabel } from "../../components/Panel.tsx";
import { Row, RowChevron, RowList } from "../../components/Row.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { alsoLine, changeLine, checkLines, differentIntro, groupSummary, keptRow, lossesText, NOTHING_NEW, ownRollsLine, replacesLine, syncReadLine, type ReadingBlocks } from "./resync.ts";

/**
 * A D&D Beyond read's review (docs/design-v1-resync.md 3.3), for the
 * re-sync dialog ("Check what changes") and the editor's D&D Beyond step
 * ("Check what was read"): the read line, Check these, the changes that
 * come in, Also set, then what is kept, what differs or what a fill
 * replaces, each with its tick. Lines wrap at 14 px and never sit in a
 * table, so a long list reads on a phone. Past 10 lines a list folds into
 * its groups, each a row with its summary.
 *
 * Each section's label can take focus (`tabIndex` -1): when a live change
 * removes the row that had it, focus goes to its section's label, and the
 * dialog finds that label by `labelId`.
 */

/** The review's sections, in its order, as focus names them. */
export type ReviewSection = "checks" | "changes" | "also" | "kept" | "different" | "replaces";

const FOLD_PAST = 10;

const LINE = { margin: 0, lineHeight: theme.leading.body, overflowWrap: "anywhere" } as const;

/**
 * A section of the review, spaced as a panel's `Section` inside a group
 * (components/Panel.tsx): one column no wider than the dialog, its rows
 * `space(2)` apart, and `space(4)` between sections. The review draws its
 * own, since its labels take an id, `tabIndex` and focus that the
 * re-sync's focus rule needs (docs/design-v1-resync.md 3.6), which
 * `Section` does not offer (docs/design-v1-look-pass-2.md 3, lane 3).
 */
const SECTION = { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), minWidth: 0 } as const;

/** A row of a section that holds a line and its checkbox: kept, different and "Replaces your changes" rows alike. */
const TICK_ROW = { display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0`, minWidth: 0 } as const;

function groupsOf(items: readonly SyncItem[]): { group: SyncGroup; items: SyncItem[] }[] {
  return SYNC_GROUPS.map((group) => ({ group, items: items.filter((i) => i.group === group) })).filter((g) => g.items.length > 0);
}

export function SyncReview(props: {
  plan: SyncPlan;
  result: SyncResult;
  ticks: ReadonlySet<string>;
  onTick(id: string): void;
  onBulk(ticks: Set<string>): void;
  name: string;
  character: Pick<Character, "name" | "actor">;
  /** Nothing would change: no part, field or record. Only then does an empty Changes say so, and otherwise it is left out. */
  nothingNew: boolean;
  /** While Apply waits, the review holds still. */
  disabled?: boolean;
  firstRef?: Ref<HTMLParagraphElement>;
  labelId(section: ReviewSection): string;
  onFocusSection?(section: ReviewSection): void;
}) {
  const { plan, result, ticks, name } = props;
  const blocks: ReadingBlocks = {
    now: { stats: plan.input.stats ?? (EMPTY_PC_STATS as PcStats), level: plan.input.level },
    after: { stats: result.stats, level: result.level },
  };
  const first = plan.source === "first";
  const of = (section: SyncSection) => plan.items.filter((i) => i.section === section);
  const changes = of("changes");
  const kept = of("kept");
  const different = of("different");
  const replaces = of("replaces");
  const checks = checkLines(plan, result, name);
  const losses = lossesText(plan, name);
  const overwrite = [...bulkIds(plan, "kept"), ...bulkIds(plan, "different")];
  const overwriteAll = overwrite.length > 0 ? <BulkButton ids={overwrite} ticks={ticks} onBulk={props.onBulk} disabled={props.disabled} words="Overwrite all" /> : null;
  const section = (key: ReviewSection, label: string, body: ReactNode, action?: ReactNode) => (
    <section style={SECTION} onFocusCapture={() => props.onFocusSection?.(key)}>
      <SectionLabel id={props.labelId(key)} tabIndex={-1} action={action}>
        {label}
      </SectionLabel>
      {body}
    </section>
  );

  return (
    <div style={{ display: "grid", gap: theme.space(4), fontSize: theme.font.body14, minWidth: 0 }}>
      <p ref={props.firstRef} tabIndex={-1} style={{ ...LINE, outline: "none" }}>
        {syncReadLine(plan)}
      </p>
      {losses ? <Notice tone="warning">{losses}</Notice> : null}
      {checks.length > 0
        ? section(
            "checks",
            "Check these",
            checks.map((line, i) => (
              <p key={i} style={LINE}>
                {line}
              </p>
            )),
          )
        : null}
      {changes.length > 0
        ? section(
            "changes",
            `Changes from D&D Beyond (${changes.length})`,
            changes.length > FOLD_PAST ? (
              <Groups items={changes} blocks={blocks} first={first} folded render={(item) => <p style={LINE}>{changeLine(item, blocks, first)}</p>} />
            ) : (
              changes.map((item) => (
                <p key={item.id} style={LINE}>
                  {changeLine(item, blocks, first)}
                </p>
              ))
            ),
          )
        : props.nothingNew
          ? section("changes", "Changes from D&D Beyond", <p style={LINE}>{NOTHING_NEW}</p>)
          : null}
      {plan.also.length > 0
        ? section(
            "also",
            "Also set",
            plan.also.map((item) => <AlsoRow key={item.id} item={item} character={props.character} source={plan.input.fill.source} ticked={ticks.has(item.id)} onTick={props.onTick} disabled={props.disabled} />),
          )
        : null}
      {kept.length > 0
        ? section(
            "kept",
            `Your changes, kept (${kept.length})`,
            kept.map((item) => <KeptRowView key={item.id} item={item} blocks={blocks} ticked={ticks.has(item.id)} onTick={props.onTick} disabled={props.disabled} />),
            overwriteAll,
          )
        : null}
      {different.length > 0
        ? section(
            "different",
            `Different from D&D Beyond (${different.length})`,
            <>
              <p style={LINE}>{differentIntro(plan, name)}</p>
              <Groups
                items={different}
                blocks={blocks}
                first={first}
                folded={different.length > FOLD_PAST}
                bulk={(group) => ({ ids: bulkIds(plan, "different", group), words: "Take these" })}
                ticks={ticks}
                onBulk={props.onBulk}
                disabled={props.disabled}
                render={(item) => <KeptRowView item={item} blocks={blocks} ticked={ticks.has(item.id)} onTick={props.onTick} disabled={props.disabled} />}
              />
            </>,
            kept.length > 0 ? undefined : overwriteAll,
          )
        : null}
      {replaces.length > 0
        ? section(
            "replaces",
            `Replaces your changes (${replaces.length})`,
            replaces.length > FOLD_PAST ? (
              <Groups
                items={replaces}
                blocks={blocks}
                first={first}
                folded
                bulk={(group) => ({ ids: bulkIds(plan, "replaces", group), words: "Keep these" })}
                ticks={ticks}
                onBulk={props.onBulk}
                disabled={props.disabled}
                render={(item) => <ReplacesRow item={item} blocks={blocks} ticked={ticks.has(item.id)} onTick={props.onTick} disabled={props.disabled} />}
              />
            ) : (
              replaces.map((item) => <ReplacesRow key={item.id} item={item} blocks={blocks} ticked={ticks.has(item.id)} onTick={props.onTick} disabled={props.disabled} />)
            ),
            <BulkButton ids={bulkIds(plan, "replaces")} ticks={ticks} onBulk={props.onBulk} disabled={props.disabled} words="Keep all of yours" />,
          )
        : null}
      {plan.ownRolls > 0 ? <p style={{ ...LINE, color: theme.color.textMuted }}>{ownRollsLine(plan.ownRolls)}</p> : null}
    </div>
  );
}

/**
 * A bulk button (3.3): a secondary toggle with a fixed name, pressed while
 * every row it covers is ticked. A press ticks them all, or, pressed,
 * unticks them.
 */
function BulkButton(props: { ids: readonly string[]; ticks: ReadonlySet<string>; onBulk(ticks: Set<string>): void; disabled?: boolean; words: string; label?: string }) {
  return (
    <Button size="sm" pressed={bulkPressed(props.ids, props.ticks)} aria-label={props.label} disabled={props.disabled} onClick={() => props.onBulk(bulkToggle(props.ids, props.ticks))} style={{ whiteSpace: "normal" }}>
      {props.words}
    </Button>
  );
}

function AlsoRow(props: { item: AlsoItem; character: Pick<Character, "name" | "actor">; source: "paste" | "ddb"; ticked: boolean; onTick(id: string): void; disabled?: boolean }) {
  const line = alsoLine(props.item, props.character, props.source);
  return <Checkbox label={line.text} help={line.help} checked={props.ticked} disabled={props.disabled} onChange={() => props.onTick(props.item.id)} />;
}

/** A kept or different row (3.3): a group named by its first line, holding its tag, D&D Beyond's value and its unticked checkbox. */
function KeptRowView(props: { item: SyncItem; blocks: ReadingBlocks; ticked: boolean; onTick(id: string): void; disabled?: boolean }) {
  const id = useId();
  const row = keptRow(props.item, props.blocks);
  return (
    <div role="group" aria-labelledby={id} data-sync-row={props.item.id} style={TICK_ROW}>
      <p id={id} style={{ ...LINE, fontWeight: theme.weight.strong }}>
        {row.first}
      </p>
      {row.tag ? (
        <span>
          <Tag tone="warning" cut="100%">
            {row.tag}
          </Tag>
        </span>
      ) : null}
      {/* From 600 px the checkbox sits beside D&D Beyond's line where both fit, else under it. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(3), minWidth: 0 }}>
        <p style={{ ...LINE, flex: "1 1 240px", minWidth: 0 }}>{row.theirs}</p>
        <div style={{ flex: "0 1 auto", minWidth: 0 }}>
          <Checkbox label={row.tick} checked={props.ticked} disabled={props.disabled} onChange={() => props.onTick(props.item.id)} />
        </div>
      </div>
    </div>
  );
}

/** A line the editor's fill replaces, with its unticked Keep mine. */
function ReplacesRow(props: { item: SyncItem; blocks: ReadingBlocks; ticked: boolean; onTick(id: string): void; disabled?: boolean }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} data-sync-row={props.item.id} style={TICK_ROW}>
      <p id={id} style={LINE}>
        {replacesLine(props.item, props.blocks)}
      </p>
      <Checkbox label="Keep mine" checked={props.ticked} disabled={props.disabled} onChange={() => props.onTick(props.item.id)} />
    </div>
  );
}

/**
 * A long list by its groups (3.3): each a row named by its group, whose
 * summary wraps and describes it, that opens to show its lines, with a
 * bulk toggle beside it, outside its button, which wraps under it when the
 * line is narrow. Folded or open as the list opens, each then as tapped.
 */
function Groups(props: {
  items: readonly SyncItem[];
  blocks: ReadingBlocks;
  first: boolean;
  folded: boolean;
  render(item: SyncItem): ReactNode;
  bulk?: (group: SyncGroup) => { ids: readonly string[]; words: string };
  ticks?: ReadonlySet<string>;
  onBulk?(ticks: Set<string>): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<Partial<Record<SyncGroup, boolean>>>({});
  return (
    <RowList>
      {groupsOf(props.items).map(({ group, items }) => {
        const shown = open[group] ?? !props.folded;
        const bulk = props.bulk?.(group);
        return (
          <div key={group} style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0`, minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <Row
                  title={group}
                  detail={groupSummary(items, props.blocks, props.first)}
                  fullDetail
                  expanded={shown}
                  trailing={<RowChevron open={shown} />}
                  onClick={() => setOpen((o) => ({ ...o, [group]: !shown }))}
                />
              </div>
              {bulk && props.ticks && props.onBulk ? <BulkButton ids={bulk.ids} ticks={props.ticks} onBulk={props.onBulk} disabled={props.disabled} words={bulk.words} label={`${bulk.words}: ${group}`} /> : null}
            </div>
            {shown ? (
              <div style={{ display: "grid", gap: theme.space(1), paddingLeft: theme.space(3), minWidth: 0 }}>
                {items.map((item) => (
                  <div key={item.id}>{props.render(item)}</div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </RowList>
  );
}
