import { useEffect, useMemo, useState } from "react";
import type { AreaTemplate, RoomState } from "#shared/model.ts";
import { MAX_ENTRIES_PER_OP } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Input } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { useSendAnswered } from "../encounter/hooks.ts";
import { usePanelHeader } from "../panels.ts";
import { caughtTokens, contextFrom } from "./coverage.ts";
import { damageOp, damageTargets, dealt, defaultResult, parseDamage, type DamageTarget, type SaveResult } from "./damage.ts";
import { areaTitle } from "./labels.ts";
import { useLiveTokens } from "./useLiveTokens.ts";

/**
 * Damage to the creatures in an area, DM only (features section 9): who
 * the area catches, each with a pass or fail for its save, one damage roll
 * for all of them, and one confirm that applies it as one undo step. The
 * list is the DM's, hidden creatures included. Players only ever see the HP
 * lines their log already allows.
 *
 * It is a subpage of the Areas panel, named by the area, so the sheet or
 * the side panel shows "Damage from Fireball" in its header with "Back to
 * Areas" (docs/design-v1-visual.md 2.3) instead of a back link in the body.
 */

const RESULTS: readonly { value: SaveResult; label: string }[] = [
  { value: "fail", label: "Fail" },
  { value: "pass", label: "Pass" },
  { value: "none", label: "Skip" },
];

const EMPTY_CHARACTERS: RoomState["characters"] = {};

export function AreaDamage(props: { template: AreaTemplate; onDone(): void }) {
  const { template } = props;
  const ui = useRoomUi();
  const scene = useRoomView((s) => (s.view ? s.view.scenes[template.sceneId] : undefined));
  const buildChunks = useRoomView((s) => s.view?.buildChunks);
  const settings = useRoomView((s) => s.view?.meta.settings);
  const characters = useRoomView((s) => s.view?.characters ?? EMPTY_CHARACTERS);
  const live = useLiveTokens();
  const { send, answer } = useSendAnswered();
  const waiting = answer === "waiting";
  const [text, setText] = useState("");
  const [results, setResults] = useState<Record<string, SaveResult>>({});
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ids = scene && buildChunks && settings ? caughtTokens(template, contextFrom({ tokens: live.tokens, buildChunks, settings }, scene), scene.id) : [];
  const targets = useMemo(() => damageTargets(ids, live.tokens, characters), [ids, live.tokens, characters]);
  const parsed = text.trim() ? parseDamage(text) : null;
  const amount = parsed?.ok ? parsed.amount : 0;
  const resultOf = (t: DamageTarget) => results[t.tokenId] ?? defaultResult(t);
  const op = amount > 0 ? damageOp(targets, results, amount) : null;
  const title = areaTitle(template);
  const tooMany = (op?.hits.length ?? 0) > MAX_ENTRIES_PER_OP;
  const busy = waiting || sent !== null;
  // Damage typed or saves marked and not yet applied keep the sheet from a swipe's close. Once sent, the server has them (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince({ text, results }, !busy);
  usePanelHeader({ title: `Damage from ${title}`, parent: "Areas", onBack: props.onDone });

  // Only once the server has taken it does the DM hear that it landed, and the form goes back to the list. A refusal
  // has its own toast, and the form stays with the damage and saves as typed, to send again or change. When the
  // connection dropped before the server answered, nobody knows whether it landed: the form stays, and sending it
  // again blind could hit everyone twice, so the DM is told to look first.
  const { onDone } = props;
  useEffect(() => {
    if (sent === null || answer === "waiting") return;
    if (answer === "taken") {
      ui.notify(`${title} dealt damage to ${sent === 1 ? "1 creature" : `${sent} creatures`}. Undo takes it all back.`, "info");
      onDone();
    } else if (answer === "unknown") {
      ui.notify("Check the HP: the connection dropped before the server answered.", "error");
    }
    setSent(null);
  }, [sent, answer, onDone, ui, title]);

  const apply = () => {
    if (waiting || sent !== null) return;
    const check = parseDamage(text);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (!op || tooMany) return;
    send(op);
    setSent(op.hits.length);
  };

  // "All fail" and "All pass" mark the creatures. Objects keep what the DM marked them, skipped until then.
  const setAll = (result: SaveResult) =>
    setResults((all) => ({ ...all, ...Object.fromEntries(targets.filter((t) => !t.object).map((t) => [t.tokenId, t.dead ? "none" : result])) }));

  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      <Help>Type the damage rolled once for everyone. A creature that passes its save takes half, rounded down.</Help>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        style={{ display: "flex", gap: theme.space(2) }}
      >
        <Input
          aria-label="Damage rolled"
          value={text}
          inputMode="numeric"
          enterKeyHint="done"
          autoComplete="off"
          placeholder="Damage, e.g. 28"
          error={error !== null || (parsed !== null && !parsed.ok)}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          style={{ flex: 1, width: 0 }}
        />
      </form>
      {error ? <ErrorLine>{error}</ErrorLine> : parsed && !parsed.ok ? <ErrorLine>{parsed.error}</ErrorLine> : null}
      {targets.length === 0 ? (
        <Empty>Nobody is in this area.</Empty>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            <Button size="sm" onClick={() => setAll("fail")}>
              All fail
            </Button>
            <Button size="sm" onClick={() => setAll("pass")}>
              All pass
            </Button>
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(2) }}>
            {targets.map((t) => {
              const result = resultOf(t);
              const takes = dealt(amount, result);
              return (
                <li key={t.tokenId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
                  {/* Narrow enough that the name, the three save choices and the damage share one line on a 360 px panel. */}
                  <div style={{ flex: "1 1 80px", minWidth: 0 }}>
                    <div style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, overflowWrap: "anywhere" }}>{t.name}</div>
                    <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
                      {t.hp ? `${t.hp.cur}/${t.hp.max}${t.hp.temp > 0 ? ` +${t.hp.temp}` : ""}` : ""}
                      {t.hidden ? " · hidden" : ""}
                      {t.object ? " · object" : ""}
                      {t.dead ? " · dead" : ""}
                    </div>
                  </div>
                  <Segmented label={`${t.name}'s save`} value={result} options={RESULTS} onChange={(r) => setResults((all) => ({ ...all, [t.tokenId]: r }))} />
                  <span
                    aria-label={`${t.name} takes ${takes}`}
                    style={{
                      minWidth: 36,
                      textAlign: "right",
                      fontWeight: theme.weight.bold,
                      fontVariantNumeric: "tabular-nums",
                      color: takes > 0 ? theme.color.dangerText : theme.color.textMuted,
                    }}
                  >
                    {takes > 0 ? `−${takes}` : "0"}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {tooMany ? <ErrorLine>{`At most ${MAX_ENTRIES_PER_OP} creatures take damage at once.`}</ErrorLine> : null}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="sm" variant="primary" busy={busy} disabled={!op || tooMany} onClick={apply}>
          {busy ? "Applying…" : op ? `Apply to ${op.hits.length}` : "Apply"}
        </Button>
      </div>
    </div>
  );
}

/** What stops the damage, in the error red that reads on a panel (`dangerText`, 5.9:1). */
function ErrorLine(props: { children: string }) {
  return <Help style={{ color: theme.color.dangerText }}>{props.children}</Help>;
}
