import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Actor, Token } from "#shared/model.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { statBlockShown, tokenStatBlock } from "../monsters/statBlockLink.ts";
import type { TokenAccess } from "./access.ts";
import { defenseLines, linkedBlockState, moreStatsShown, saveUnits, type LinkedBlock, type VitalItem, type VitalUnit } from "./statSummary.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { useSrdBlocks } from "../monsters/srdBlocks.ts";

/*
 * The stat summary (docs/design-v1-token-panel.md 3.2): the vitals line,
 * the saves and the defense lines, and on a short bar the "More stats"
 * disclosure that holds what leaves the line. The token bar places each
 * part in its own order, and the token panel shows the vitals in its stat
 * block's header. The rules are in statSummary.ts.
 */

/** The SRD's blocks while `active`: loaded on first need and kept for the page. A failure stays until a reload (monsters/SrdLoadFailed.tsx). */
export function useSrdList(active: boolean): { list: readonly SrdMonster[] | null; failed: boolean } {
  // Once any view has loaded the SRD chunk this page, a later bar shows its saves without a wait.
  return useSrdBlocks(active);
}

/**
 * The block behind a token's link, where this viewer reads it
 * (statBlockLink.ts statBlockShown): none, loading, failed, or ready. A
 * companion's stored block reads at once from the view, so only an SRD
 * block loads the chunk. The vitals never wait for it.
 */
export function useLinkedBlock(token: Pick<Token, "kind" | "companion">, actor: Partial<Actor> | undefined, access: Pick<TokenAccess, "dm" | "owner">): LinkedBlock {
  const monsters = useRoomView((s) => s.view?.monsters);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  const shown = statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor, companion: token.companion !== undefined });
  const srd = useSrdList(shown && tokenStatBlock(actor, monsters, blocks).kind === "srd");
  const block = shown ? linkedBlockState(actor, monsters, srd, blocks) : ({ kind: "none" } as const);
  return block;
}

/** "Open the sheet ↗": the owner's D&D Beyond sheet in a new tab, with no referrer and no opener. 44 px tall. */
export function SheetAnchor(props: { url: string }) {
  return (
    <a
      href={props.url}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: theme.touch,
        color: theme.color.accent,
        fontWeight: theme.weight.strong,
        whiteSpace: "nowrap",
      }}
    >
      Open the sheet ↗
    </a>
  );
}

function Unit(props: { unit: VitalUnit }) {
  const { unit } = props;
  switch (unit.kind) {
    case "ac":
      return <AcBadge ac={unit.ac} />;
    case "tag":
      return <Tag tone={unit.tone}>{unit.text}</Tag>;
    case "sheet":
      return <SheetAnchor url={unit.url} />;
    case "text":
      return (
        <span style={{ minWidth: 0 }}>
          {unit.label ? <span style={{ color: theme.color.textMuted }}>{unit.label} </span> : null}
          <span
            style={{
              fontWeight: unit.tone === "muted" ? undefined : theme.weight.strong,
              color: unit.tone === "temp" ? theme.color.ally : unit.tone === "muted" ? theme.color.textMuted : theme.color.text,
            }}
          >
            {unit.value}
          </span>
          {unit.comma ? "," : null}
        </span>
      );
  }
}

/**
 * One line of items at 14 px that wraps between units, never inside one
 * (statSummary.ts VitalUnit), so nothing runs out of even the narrowest
 * box. Each unit is a flex item at its own width: a line breaks before a
 * unit that does not fit, and only a unit wider than the whole box, which
 * none is in the boxes the panel and the bar take, shrinks and wraps
 * inside rather than run out of it. Items stand a little further apart
 * than the units inside them. `afterTag` follows the life tag, where the
 * DM's Revive goes, and `end` the last item, where a narrow token window's
 * elevation badge goes.
 */
export function VitalsLine(props: { items: readonly VitalItem[]; afterTag?: ReactNode; end?: ReactNode }) {
  if (props.items.length === 0 && props.end == null) return null;
  return (
    <div data-vitals="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: theme.space(1), columnGap: theme.space(1.5), fontSize: theme.font.body14, minWidth: 0 }}>
      {props.items.flatMap((item, i) =>
        item.units.flatMap((unit, j) => {
          const last = j === item.units.length - 1;
          const gap = last && i < props.items.length - 1 ? { marginInlineEnd: theme.space(1.5) } : null;
          const shown = (
            <span key={`${item.key}:${j}`} data-unit={item.key} style={{ display: "inline-flex", alignItems: "center", minWidth: 0, maxWidth: "100%", ...gap }}>
              <Unit unit={unit} />
            </span>
          );
          return unit.kind === "tag" && props.afterTag ? [shown, <span key={`${item.key}:after`} style={{ display: "inline-flex" }}>{props.afterTag}</span>] : [shown];
        }),
      )}
      {props.end}
    </div>
  );
}

/**
 * The six saves, "Saves" then "Str +5" and the rest, each a unit that
 * never breaks. While the SRD chunk loads the line keeps its place and,
 * after the usual 200 ms, says so, and a failed load offers the reload.
 */
export function SavesLine(props: { block: LinkedBlock }) {
  const { block } = props;
  if (block.kind === "none") return null;
  if (block.kind === "loading") {
    return (
      <div style={{ minHeight: 21 }}>
        <Loading text="Loading saves…" />
      </div>
    );
  }
  if (block.kind === "failed") {
    return <SrdLoadFailed what="Saves" inline />;
  }
  return (
    <div data-saves="" style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", rowGap: theme.space(1), columnGap: theme.space(1.5), fontSize: theme.font.body14 }}>
      <span style={{ color: theme.color.textMuted }}>Saves</span>
      {saveUnits(block.block).map((text) => {
        const [ability, value] = text.split(" ");
        return (
          <span key={ability} style={{ whiteSpace: "nowrap" }}>
            <span style={{ color: theme.color.textMuted }}>{ability} </span>
            <span style={{ fontWeight: theme.weight.strong }}>{value}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The block's vulnerabilities, resistances and immunities, one line each.
 * Running text that wraps between words, and inside one only when it is
 * wider than the box. `clamp` keeps each to three lines in the bar, since a
 * room monster may type 500 characters, and the block holds the rest.
 */
export function DefenseLines(props: { block: LinkedBlock; clamp?: boolean }) {
  if (props.block.kind !== "ready") return null;
  const lines = defenseLines(props.block.block);
  if (lines.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
      {lines.map((line) => (
        <p
          key={line.label}
          data-defense={line.label}
          style={{
            margin: 0,
            overflowWrap: "anywhere",
            ...(props.clamp ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3, overflow: "hidden" } : null),
          }}
        >
          <span style={{ color: theme.color.textMuted }}>{line.label} </span>
          {line.text}
        </p>
      ))}
    </div>
  );
}

/**
 * A short bar's "More stats" (3.3): speed, Passive Perception, saves and
 * defenses behind one 44 px disclosure after the effects, closed when the
 * bar opens and not remembered. Its name says more than saves because it
 * holds the speed too. Nothing when it would hold nothing.
 */
export function MoreStats(props: { more: readonly VitalItem[]; block: LinkedBlock }) {
  const [open, setOpen] = useState(false);
  // Opened in a window that scrolls, what it shows scrolls itself into view (docs/design-v1-token-window.md 5.7).
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  if (!moreStatsShown(props.more, props.block)) return null;
  return (
    <div ref={ref} style={{ display: "grid", gap: theme.space(2) }}>
      <Button size="sm" expanded={open} onClick={() => setOpen((o) => !o)} style={{ justifyContent: "space-between", width: "100%" }}>
        More stats
        <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />
      </Button>
      {open ? (
        <>
          <VitalsLine items={props.more} />
          <SavesLine block={props.block} />
          <DefenseLines block={props.block} clamp />
        </>
      ) : null}
    </div>
  );
}
