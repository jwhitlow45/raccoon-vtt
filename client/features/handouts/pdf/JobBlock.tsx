import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { roomHandoutPages } from "#shared/handouts.ts";
import { useStore } from "zustand";
import { Button } from "../../../components/Button.tsx";
import { ErrorText, Field } from "../../../components/Field.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { Help } from "../../../components/Panel.tsx";
import { VISUALLY_HIDDEN } from "../../../lib/a11y.ts";
import { isCoarsePointer } from "../../../lib/device.ts";
import { theme } from "../../../lib/theme.ts";
import { useRoomView } from "../../../state/view.ts";
import {
  REFUSALS,
  canLeaveOut,
  canTryAgain,
  cancelledWords,
  checkRange,
  openedWords,
  progressWords,
  rangeTotal,
  recoveredWords,
  recoveryWords,
  savedWords,
  stopWords,
  uploadLabel,
  type PdfJob,
} from "./job.ts";
import { usePdfJob } from "./live.ts";
import { TITLE_FIELD_MAX } from "../handouts.ts";
import { titleProblem } from "./title.ts";

/**
 * The PDF upload's block in the DM panel's Handouts section
 * (docs/design-v1-pdf-handouts.md 4.1.1 and 9): the file, the range or the
 * progress, the title and the job's buttons, apart from the Show a handout
 * form, which keeps working beside it. It is a group named by its file, so
 * its Title field is told apart from the form's. The job itself lives in
 * the room's scope (job.ts), and this only draws it and passes on presses.
 *
 * Focus follows 4.1.7: picking a PDF and every button that leaves when
 * pressed hand focus to the block's heading, the saved line takes it when
 * the progress gives way to it, and Done, Dismiss or the block leaving any
 * other way hands it to `onLeave`.
 */
export function JobBlock(props: {
  /** Where focus goes when the block leaves: Show a handout, or the form when it is open. */
  onLeave(): void;
  /** Show it: the saved document picked in the form. */
  onShow(docId: string): void;
  /** View: the saved document in the viewer, focus back on `opener`. */
  onView(docId: string, opener: HTMLElement | null): void;
}) {
  const { job, store, current } = usePdfJob();
  const blockShown = useRef(false);
  const block = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const savedLine = useRef<HTMLParagraphElement>(null);
  const roomPages = useRoomView((s) => (s.view ? roomHandoutPages(s.view) : 0));
  const connection = useRoomView((s) => s.connection);
  const phase = job?.phase.k ?? null;
  const touch = isCoarsePointer();
  const { onLeave } = props;

  // The job toasts a pause only while this block is out of sight, where its status line goes unheard (4.1.1).
  useEffect(() => {
    const el = block.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      store.setState({ blockShown: el !== null });
      return () => store.setState({ blockShown: false });
    }
    const observer = new IntersectionObserver(([entry]) => {
      blockShown.current = entry?.isIntersecting === true;
      store.setState({ blockShown: blockShown.current });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      store.setState({ blockShown: false });
    };
  }, [store, job !== null]);

  // A job started here, or a recovery found, puts focus on the block's heading, which names the file. One already there when the panel opens does not.
  const docId = job?.docId ?? null;
  const seen = useRef(docId);
  useLayoutEffect(() => {
    if (docId && docId !== seen.current) heading.current?.focus();
    seen.current = docId;
  }, [docId]);

  // The progress giving way to "Saved as …" moves focus in the block to that line.
  useLayoutEffect(() => {
    if (phase === "saved" && block.current?.contains(document.activeElement)) savedLine.current?.focus();
  }, [phase]);

  // The block leaving while it held focus hands focus on, rather than to the page.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (job) return;
    if (hadFocus.current) onLeave();
    hadFocus.current = false;
  }, [job, onLeave]);

  if (!job) return null;
  const runner = current();
  const toHeading = () => heading.current?.focus();
  const leaving = (act: () => unknown) => () => {
    void act();
    toHeading();
  };
  const end = () => {
    hadFocus.current = true;
    void runner?.end();
  };

  return (
    <div
      ref={block}
      role="group"
      aria-label={`PDF upload, ${job.fileName}`}
      onFocus={() => (hadFocus.current = true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hadFocus.current = false;
      }}
      style={{
        display: "grid",
        // A column that may be narrower than a field's own width, so at 246 px nothing runs past the block's edge.
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.bg,
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      <h4 ref={heading} tabIndex={-1} style={{ margin: 0, fontSize: theme.font.body14, fontWeight: theme.weight.bold, outlineOffset: 2 }}>
        {job.phase.k === "recovery" || job.phase.k === "recovered" ? "PDF upload" : job.phase.k === "range" ? openedWords(job)[0] : job.fileName}
      </h4>
      {/* The start, each pause or stop, and the end, never every page (4.1.4). A new child each time, so the same words said twice are heard twice. */}
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        <span key={job.announced}>{job.announce}</span>
      </div>
      <Body job={job} runner={runner} roomPages={roomPages} connection={connection} touch={touch} savedLine={savedLine} leaving={leaving} end={end} onShow={props.onShow} onView={props.onView} />
    </div>
  );
}

type Runner = ReturnType<ReturnType<typeof usePdfJob>["current"]>;

function Body(props: {
  job: PdfJob;
  runner: Runner;
  roomPages: number;
  connection: string;
  touch: boolean;
  savedLine: RefObject<HTMLParagraphElement | null>;
  leaving: (act: () => unknown) => () => void;
  end(): void;
  onShow(docId: string): void;
  onView(docId: string, opener: HTMLElement | null): void;
}) {
  const { job, runner, leaving, end } = props;
  const phase = job.phase;
  const cancel = (busy = false) => (
    <Button variant="danger" size="sm" busy={busy} onClick={leaving(() => runner?.cancel())}>
      {busy ? "Cancelling…" : "Cancel upload"}
    </Button>
  );
  const title = (
    <Field
      label="Title"
      value={job.title}
      maxLength={TITLE_FIELD_MAX}
      error={titleProblem(job.title)}
      onChange={(e) => runner?.setTitle(e.target.value)}
    />
  );
  const keepOpen = props.touch ? <Help>Keep this page open until it finishes.</Help> : null;

  switch (phase.k) {
    case "loading":
      return (
        <>
          <Loading text="Loading the PDF reader…" delay={0} />
          <Buttons>{cancel()}</Buttons>
        </>
      );
    case "refused":
      return (
        <>
          <ErrorText>{REFUSALS[phase.kind]}</ErrorText>
          <Buttons>
            <Button size="sm" onClick={end}>
              Dismiss
            </Button>
          </Buttons>
        </>
      );
    case "range": {
      const check = checkRange(job.from, job.to, job.numPages, props.roomPages);
      return (
        <>
          {openedWords(job)
            .slice(1)
            .map((line) => (
              <Line key={line}>{line}</Line>
            ))}
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            <div style={{ flex: "1 1 120px", minWidth: 0 }}>
              {/* A small intrinsic width, so the two fields share a 246 px block side by side or stack, never past its edge. */}
              <Field
                label="From page"
                inputMode="numeric"
                size={4}
                maxLength={6}
                value={job.from}
                error={check.ok ? null : check.from}
                onChange={(e) => runner?.setRange(e.target.value, job.to)}
              />
            </div>
            <div style={{ flex: "1 1 120px", minWidth: 0 }}>
              <Field label="To page" inputMode="numeric" size={4} maxLength={6} value={job.to} error={check.ok ? null : check.to} onChange={(e) => runner?.setRange(job.from, e.target.value)} />
            </div>
          </div>
          {title}
          <Buttons>
            <Button variant="primary" size="sm" disabled={!check.ok} onClick={leaving(() => runner?.upload())}>
              {uploadLabel(check.ok ? check.count : null)}
            </Button>
            {cancel()}
          </Buttons>
        </>
      );
    }
    case "preparing":
    case "paused":
    case "titleInvalid": {
      const total = rangeTotal(job);
      const done = job.pages.length;
      const words = progressWords(job);
      return (
        <>
          {/* Not live: the block's own status line says the start, each pause or stop, and the end, never every page (4.1.4). */}
          {phase.k === "preparing" ? <Loading live={false} text={words} detail={phase.waiting ? "Waiting for the server…" : null} delay={0} /> : null}
          {phase.k === "paused" ? <Line strong>{stopWords(job, phase.page, phase.stop)}</Line> : null}
          {phase.k === "titleInvalid" ? <Line strong>Fix the title to save.</Line> : null}
          <div
            role="progressbar"
            aria-label="Pages uploaded"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={words}
            style={{ height: 6, borderRadius: theme.radius.pill, background: theme.color.surfaceRaised, overflow: "hidden" }}
          >
            <div style={{ width: `${total > 0 ? (100 * done) / total : 0}%`, height: "100%", background: theme.color.accent }} />
          </div>
          {keepOpen}
          {title}
          <Buttons>
            {phase.k === "paused" && canTryAgain(phase.stop) ? (
              <Button size="sm" onClick={leaving(() => runner?.tryAgain())}>
                Try again
              </Button>
            ) : null}
            {phase.k === "paused" && canLeaveOut(phase.stop) ? (
              <Button size="sm" onClick={leaving(() => runner?.leaveOut())}>
                Leave this page out
              </Button>
            ) : null}
            {phase.k === "titleInvalid" ? (
              <Button variant="primary" size="sm" disabled={titleProblem(job.title) !== null} onClick={leaving(() => runner?.save())}>
                Save
              </Button>
            ) : null}
            {cancel()}
          </Buttons>
        </>
      );
    }
    case "saving":
    case "checking":
      return (
        <>
          <Loading
            text={phase.k === "checking" ? "Checking whether the handout saved…" : props.connection === "open" ? "Saving the handout…" : "Waiting for the connection to save."}
            delay={0}
          />
          {keepOpen}
          <Buttons>{cancel()}</Buttons>
        </>
      );
    case "saveFailed":
      return (
        <>
          <ErrorText>{phase.words}</ErrorText>
          {title}
          <Buttons>
            <Button size="sm" disabled={titleProblem(job.title) !== null} onClick={leaving(() => runner?.tryAgain())}>
              Try again
            </Button>
            {cancel()}
          </Buttons>
        </>
      );
    case "removing":
      return <Loading text="Removing the pages…" delay={0} />;
    case "cancelling":
      return (
        <>
          <Loading text="Cancelling…" delay={0} />
          <Buttons>{cancel(true)}</Buttons>
        </>
      );
    case "cancelled":
      return (
        <>
          <Summary lines={cancelledWords(job, phase)} thumb={job.uncertain?.thumb ?? null} />
          <Buttons>
            <Button size="sm" onClick={end}>
              Done
            </Button>
          </Buttons>
        </>
      );
    case "saved":
      return (
        <>
          {savedWords(job).map((line, i) => (
            <Line key={line} strong={i === 0} lineRef={i === 0 ? props.savedLine : undefined}>
              {line}
            </Line>
          ))}
          <Buttons>
            <Button size="sm" onClick={() => props.onShow(job.docId)}>
              Show it
            </Button>
            <Button size="sm" onClick={(e) => props.onView(job.docId, e.currentTarget)}>
              View
            </Button>
            <Button size="sm" onClick={end}>
              Done
            </Button>
          </Buttons>
        </>
      );
    case "empty":
      return (
        <>
          <Line strong>No pages were uploaded.</Line>
          <Buttons>
            <Button size="sm" onClick={leaving(() => runner?.tryAgain())}>
              Try again
            </Button>
            <Button size="sm" onClick={end}>
              Dismiss
            </Button>
          </Buttons>
        </>
      );
    case "recovery":
      return (
        <>
          <Summary lines={recoveryWords(phase.ledger)} thumb={phase.ledger.uncertain?.thumb ?? null} />
          <Buttons>
            {phase.ledger.ids.length > 0 ? (
              <>
                <Button size="sm" onClick={leaving(() => runner?.removeRecovered())}>
                  Remove them
                </Button>
                <Button size="sm" onClick={leaving(() => runner?.keepRecovered())}>
                  Keep them
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={end}>
                Done
              </Button>
            )}
          </Buttons>
        </>
      );
    case "recovered":
      return (
        <>
          <Summary lines={[recoveredWords(phase)]} thumb={job.uncertain?.thumb ?? null} />
          <Buttons>
            <Button size="sm" onClick={end}>
              Done
            </Button>
          </Buttons>
        </>
      );
  }
}

function Line(props: { children: ReactNode; strong?: boolean; lineRef?: RefObject<HTMLParagraphElement | null> }) {
  return (
    <p ref={props.lineRef} tabIndex={props.lineRef ? -1 : undefined} style={{ margin: 0, fontSize: theme.font.body14, fontWeight: props.strong ? theme.weight.strong : undefined }}>
      {props.children}
    </p>
  );
}

/** A summary's lines, with the small picture of a page that may be left in the library, so the DM can spot it there (4.1.6). */
function Summary(props: { lines: string[]; thumb: string | null }) {
  return (
    <div style={{ display: "flex", gap: theme.space(3), alignItems: "flex-start" }}>
      <div style={{ display: "grid", gap: theme.space(1), minWidth: 0, flex: 1 }}>
        {props.lines.map((line, i) => (
          <Line key={line} strong={i === 0}>
            {line}
          </Line>
        ))}
      </div>
      {props.thumb ? <img src={props.thumb} alt="" width={48} style={{ flex: "none", height: "auto", borderRadius: theme.radius.sm, border: `${theme.line.border}px solid ${theme.color.border}` }} /> : null}
    </div>
  );
}

function Buttons(props: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>{props.children}</div>;
}
