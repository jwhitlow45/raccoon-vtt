import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DDB_LINK_ERROR, ddbCharacterId, ddbSheetUrl } from "#shared/ddb/link.ts";
import { BLOCK_SAVES_TOO_FAST, CHARACTER_CHANGED, LIMITS, serializedBytes } from "#shared/limits.ts";
import type { Character } from "#shared/model.ts";
import { expectOf } from "#shared/permissions.ts";
import type { ExpectPart } from "#shared/protocol.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { defaultTicks, planSync, recordFits, syncPatch, syncResult, undoSync, type SyncPlan } from "#shared/rules/pcSync.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog, PINNED_FOOT } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import type { OpAnswer, OpRefusal, UnknownCause } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { editsPcStats } from "../tokens/access.ts";
import { DDB_WORDS, getDdbFill, importErrorText, readPastedJson } from "./ddb.ts";
import { DdbStep } from "./PcStatsEditor.tsx";
import { blockTooBigText, doneLine, lateApplyText, lateUndoText, recordTooBigText, refusalText, RESYNC_WORDS, resyncNumber } from "./resync.ts";
import { openResync, stepResync, type ResyncEffect, type ResyncEvent, type ResyncState, type SyncAnswer, type SyncOp } from "./resyncFlow.ts";
import { SyncReview, type ReviewSection } from "./SyncReview.tsx";

/** Every line a plan lists, by id, as the flow keeps ticks for them. */
function lineIds(plan: SyncPlan): string[] {
  return [...plan.items.map((i) => i.id), ...plan.also.map((a) => a.id)];
}

function planFor(character: Character, fill: PcFill): SyncPlan {
  return planSync({ mode: "resync", stats: character.stats, level: character.level, character, fill });
}

/** A refusal sorted by what the dialog does with it (3.5): the stale check's and the save budget's words are known by their text. */
function answerOf(answer: OpAnswer, refusal?: OpRefusal): { answer: SyncAnswer; message?: string } {
  if (answer === "taken" || answer === "unknown") return { answer };
  const message = refusal?.message.trim() ?? "";
  if (message === CHARACTER_CHANGED) return { answer: "stale" };
  if (message === BLOCK_SAVES_TOO_FAST) return { answer: "fast", message };
  return message ? { answer: "refused", message } : { answer: "refused" };
}

/**
 * "Re-sync from D&D Beyond" (docs/design-v1-resync.md 1.2 and 3): fetches
 * the character the sheet link names, else the record's, at once, reviews
 * what changed against the live character, applies it in one op that
 * expects each part as the review saw it, and offers Undo until it
 * closes. The steps are one state machine (resyncFlow.ts). A fetch that
 * fails shows the editor's D&D Beyond step, with its field and pasted
 * JSON, so the same ways out are there.
 */
export function ResyncDialog(props: { characterId: string; onClose(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  const roomId = useRoomView((s) => s.roomId);
  const you = useRoomView((s) => s.you);
  const live = useRoomView((s) => s.view?.characters[props.characterId]);
  const name = useRef(live?.name ?? "This character");
  if (live) name.current = live.name;
  const yours = live !== undefined && editsPcStats(you, live);

  const [flow, setFlow] = useState<ResyncState>(openResync);
  const flowRef = useRef(flow);
  // The number and link as the dialog opened: the fetch and its field start from them.
  const [number] = useState(() => (live ? resyncNumber(live, ddbCharacterId) : null));
  const [link, setLink] = useState(() => (live?.actor.sheetUrl && ddbCharacterId(live.actor.sheetUrl) ? live.actor.sheetUrl : number ? ddbSheetUrl(number) : ""));
  const [json, setJson] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [readingJson, setReadingJson] = useState(false);
  const open = useRef(true);
  const gets = useRef(new Map<number, AbortController>());
  // The character the review saw when Apply went, held while it waits, and the one Undo starts from once taken.
  const frozen = useRef<Character | null>(null);
  // The character the review was last built from, so a later one is a change from another device.
  const seen = useRef<Character | null>(null);
  const staleRebuild = useRef(false);
  const counts = useRef<ReturnType<typeof syncResult>["counts"] | null>(null);

  const send = (event: ResyncEvent) => {
    const { state, effects } = stepResync(flowRef.current, event);
    flowRef.current = state;
    setFlow(state);
    for (const effect of effects) run(effect);
  };

  const run = (effect: ResyncEffect) => {
    if (effect.kind === "close") props.onClose();
    else if (effect.kind === "fetch") startGet(effect.id);
    else if (effect.kind === "abort") {
      gets.current.get(effect.id)?.abort();
      gets.current.delete(effect.id);
    } else sendOp(effect.what, effect.op);
  };

  // Fetches at once. Under React's strict mode the effect runs twice, and the second "open" aborts the first fetch and starts its own.
  useEffect(() => {
    open.current = true;
    const live = gets.current;
    send({ t: "open" });
    return () => {
      open.current = false;
      for (const controller of live.values()) controller.abort();
      live.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reviewOf = (fill: PcFill) => {
    const now = store.getState().view?.characters[props.characterId];
    if (!now) return null;
    seen.current = now;
    const plan = planFor(now, fill);
    return { fill, ids: lineIds(plan), ticks: defaultTicks(plan) };
  };

  const startGet = (id: number) => {
    const controller = new AbortController();
    gets.current.set(id, controller);
    const target = flowRef.current.field ? link : (number ?? link);
    getDdbFill(roomId, target, controller.signal).then(
      (fill) => {
        gets.current.delete(id);
        if (!open.current) return;
        const review = reviewOf(fill);
        send({ t: "got", id, result: review ?? { error: RESYNC_WORDS.gone } });
      },
      (err: unknown) => {
        gets.current.delete(id);
        if (!controller.signal.aborted && open.current) send({ t: "got", id, result: { error: importErrorText(err) } });
      },
    );
  };

  const getIt = () => {
    if (flowRef.current.get !== null) return;
    if (!ddbCharacterId(link)) {
      setLinkError(DDB_LINK_ERROR);
      return;
    }
    setLinkError(null);
    send({ t: "get" });
  };

  const readJson = () => {
    if (readingJson) return;
    setReadingJson(true);
    setLinkError(null);
    readPastedJson(json).then(
      (result) => {
        setReadingJson(false);
        if (!open.current) return;
        if ("error" in result) setLinkError(result.error);
        else {
          const review = reviewOf(result.fill);
          if (review) send({ t: "read", ...review });
          else setLinkError(RESYNC_WORDS.gone);
        }
      },
      () => {
        setReadingJson(false);
        if (open.current) setLinkError("The reader did not load. Check the connection, then try again.");
      },
    );
  };

  // The review follows the live character, except while Apply waits, when it holds still on what Apply sent.
  const reviewCharacter = flow.applying ? frozen.current : (live ?? null);
  const plan = useMemo(() => (flow.fill && reviewCharacter ? planFor(reviewCharacter, flow.fill) : null), [flow.fill, reviewCharacter]);
  const result = useMemo(() => (plan ? syncResult(plan, flow.ticks) : null), [plan, flow.ticks]);
  const op = useMemo(() => (plan && result && reviewCharacter ? syncPatch(reviewCharacter, result) : null), [plan, result, reviewCharacter]);
  useEffect(() => {
    if (!plan || !reviewCharacter || flowRef.current.step !== "review" || flowRef.current.applying || reviewCharacter === seen.current) return;
    seen.current = reviewCharacter;
    const changed = !staleRebuild.current;
    staleRebuild.current = false;
    send({ t: "lines", ids: lineIds(plan), changed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, reviewCharacter]);

  const [retryAt, setRetryAt] = useState<number | null>(null);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setTimeout(() => {
      setRetryAt(null);
      send({ t: "refilled" });
    }, Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryAt]);

  const sendOp = (what: "apply" | "undo", sync: SyncOp) => {
    const who = name.current;
    const onAnswer = (answer: OpAnswer, refusal?: OpRefusal, _unknown?: UnknownCause, stamped?: string) => {
      const sorted = answerOf(answer, refusal);
      if (!open.current) {
        const text = what === "apply" ? lateApplyText(who, answer, refusal?.message) : lateUndoText(who, answer, refusal?.message);
        if (text) ui.notify(text, "error");
        return;
      }
      if (sorted.answer === "fast") setRetryAt(Date.now() + LIMITS.companionBlockWriteRefillMs);
      if (sorted.answer === "stale" && what === "apply") staleRebuild.current = true;
      send(what === "apply" ? { t: "applied", ...sorted, ...(stamped ? { at: stamped } : {}) } : { t: "undid", ...sorted });
    };
    // In "view as a player" nothing is sent: the preview says so, and the review stays.
    if (actions.dispatch({ t: "character.update", characterId: props.characterId, patch: sync.patch, expect: sync.expect }, { onAnswer, quiet: true }) === null) {
      send(what === "apply" ? { t: "applied", answer: "refused" } : { t: "undid", answer: "refused" });
    }
  };

  const apply = () => {
    // Nothing new and nothing ticked: Done sends nothing.
    if (op === null) {
      send({ t: "apply", op: null });
      return;
    }
    if (!reviewCharacter || !result || !yours || tooBig) return;
    frozen.current = reviewCharacter;
    counts.current = result.counts;
    send({ t: "apply", op });
  };

  // Undo starts from the character Apply saw, the patch it sent and the `at` its answer gave, and only while the live character still holds what Apply wrote.
  const undo = useMemo(() => {
    if (flow.step !== "done" || !flow.applied || !frozen.current || !live) return null;
    const back = undoSync(frozen.current, flow.applied.patch, flow.appliedAt ?? undefined);
    if (!back) return null;
    const now = expectOf(live, Object.keys(back.expect) as ExpectPart[]);
    return Object.entries(back.expect).every(([part, hash]) => now[part as ExpectPart] === hash) ? back : null;
  }, [flow.step, flow.applied, flow.appliedAt, live]);

  const close = () => send({ t: "close" });
  const blockBytes = result ? serializedBytes(result.stats) : 0;
  const recordBig = result ? !recordFits(result.record) : false;
  const tooBig = blockBytes > LIMITS.pcStatsBytes || recordBig;

  // Focus (3.6): when an answer changes the state and focus is on the dialog itself or went with a removed control, the new state's first line takes it. A live rebuild that removed the focused row gives it to its section's label.
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLParagraphElement>(null);
  const done = useRef<HTMLParagraphElement>(null);
  const labelBase = useId();
  const labelId = (section: ReviewSection) => `${labelBase}-${section}`;
  const lastSection = useRef<ReviewSection | null>(null);
  useLayoutEffect(() => {
    const dialog = root.current?.closest("dialog");
    const active = document.activeElement;
    const lost = active === null || active === document.body || active === dialog || !active.isConnected;
    if (!lost) return;
    if (flow.step === "review") {
      const label = lastSection.current ? document.getElementById(labelId(lastSection.current)) : null;
      (label ?? first.current)?.focus({ preventScroll: false });
    } else if (flow.step === "done" || flow.step === "undone") done.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.step, plan, flow.refused]);
  useEffect(() => {
    if (flow.step !== "review") lastSection.current = null;
  }, [flow.step]);

  const who = name.current;
  const refused = flow.refused;
  const notice = !refused ? null : refused.answer === "stale" && refused.of === "apply" ? (
    RESYNC_WORDS.stale(who)
  ) : refused.answer === "unknown" ? (
    refused.of === "apply" ? RESYNC_WORDS.unknown(who) : RESYNC_WORDS.unknownUndo(who)
  ) : refused.answer === "stale" ? null : refused.message ? (
    refused.answer === "fast" ? refused.message : refusalText(refused.of === "apply" ? "Not re-synced" : "Not undone", refused.message)
  ) : null;
  const status = flow.step === "review" && retryAt !== null ? RESYNC_WORDS.retry : flow.step === "review" && flow.live ? RESYNC_WORDS.liveChange(who, flow.live.dropped) : null;
  const statusLine = status ? <span role="status">{status}</span> : null;

  if (flow.step === "ddb") {
    const failed = flow.error === DDB_WORDS.failed;
    const waiting = flow.get !== null;
    return (
      <Dialog
        title={`Re-sync ${who}`}
        onClose={close}
        phone="fill"
        width="lg"
        footer={
          <>
            <Button key="secondary" onClick={close}>
              Cancel
            </Button>
            <Button key="primary" variant="primary" busy={waiting} onClick={getIt}>
              {waiting ? "Getting it…" : failed ? "Try again" : "Get it"}
            </Button>
          </>
        }
      >
        <div ref={root}>
          {flow.field ? (
            <DdbStep
              link={link}
              onLink={(v) => {
                setLink(v);
                setLinkError(null);
              }}
              onGet={getIt}
              waiting={waiting}
              error={linkError ?? flow.error}
              json={json}
              onJson={setJson}
              onReadJson={readJson}
              readingJson={readingJson}
              name={who}
            />
          ) : (
            <Loading text={RESYNC_WORDS.getting(who)} />
          )}
        </div>
      </Dialog>
    );
  }

  if (flow.step === "review" && (!plan || !result)) {
    // The character left this viewer's view while the review was open.
    return (
      <Dialog
        title="Check what changes"
        onClose={close}
        phone="fill"
        width="lg"
        footer={
          <Button key="primary" variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <div ref={root}>
          <Notice tone="warning" role="alert">
            {RESYNC_WORDS.gone}
          </Notice>
        </div>
      </Dialog>
    );
  }

  if (flow.step === "review" && plan && result) {
    const applying = flow.applying !== null;
    const nothing = op === null;
    return (
      <Dialog
        title="Check what changes"
        onClose={close}
        back={applying ? null : { label: "Back to the D&D Beyond link", onBack: () => send({ t: "back" }) }}
        status={statusLine}
        phone="fill"
        width="lg"
        footer={
          <>
            {nothing ? null : (
              <Button key="secondary" onClick={close}>
                Cancel
              </Button>
            )}
            <Button key="primary" variant="primary" busy={applying} disabled={!nothing && (!yours || tooBig || retryAt !== null)} onClick={apply}>
              {applying ? "Applying…" : nothing ? "Done" : "Apply"}
            </Button>
          </>
        }
      >
        <div ref={root} style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
          {!yours ? (
            <Notice tone="warning" role="alert">
              {RESYNC_WORDS.gone}
            </Notice>
          ) : null}
          <SyncReview
            plan={plan}
            result={result}
            ticks={flow.ticks}
            onTick={(id) => send({ t: "tick", id })}
            onBulk={(ticks) => send({ t: "bulk", ticks })}
            name={who}
            character={plan.input.character as Character}
            disabled={applying}
            firstRef={first}
            labelId={labelId}
            onFocusSection={(section) => (lastSection.current = section)}
          />
          {notice || tooBig ? (
            <div style={{ ...PINNED_FOOT, display: "grid", gap: theme.space(2) }}>
              {notice ? (
                <Notice tone="danger" role="alert">
                  {notice}
                </Notice>
              ) : null}
              {tooBig ? (
                <Notice tone="danger" role="alert">
                  {blockBytes > LIMITS.pcStatsBytes ? blockTooBigText(who, blockBytes) : recordTooBigText(who)}
                </Notice>
              ) : null}
            </div>
          ) : null}
        </div>
      </Dialog>
    );
  }

  const undone = flow.step === "undone";
  return (
    <Dialog
      title={undone ? "Re-sync undone" : `${who} is re-synced`}
      onClose={close}
      phone="fill"
      width="lg"
      footer={
        <>
          {undone ? null : (
            <Button key="secondary" busy={flow.undoing} disabled={!undo || flow.undoStale} onClick={() => undo && send({ t: "undo", op: undo })}>
              {flow.undoing ? "Undoing…" : "Undo the re-sync"}
            </Button>
          )}
          <Button key="primary" variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div ref={root} style={{ display: "grid", gap: theme.space(3) }}>
        <p ref={done} tabIndex={-1} role="status" style={{ display: "flex", gap: theme.space(2), alignItems: "flex-start", margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, outline: "none" }}>
          <span style={{ color: theme.color.success, flex: "none", display: "inline-flex", paddingTop: 2 }}>
            <Icon name="check" size="sm" />
          </span>
          <span>{undone ? RESYNC_WORDS.undone(who) : doneLine(counts.current ?? { cameIn: 0, removed: 0, cameBack: 0, stayed: 0 })}</span>
        </p>
        {!undone && !flow.undoing && (!undo || flow.undoStale) ? <Help>{RESYNC_WORDS.undoStale(who)}</Help> : null}
        {!undone && notice ? (
          <Notice tone="danger" role="alert">
            {notice}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}
