import { useEffect, useRef, useState } from "react";
import { Button } from "../../client/components/Button.tsx";
import { theme } from "../../client/lib/theme.ts";
import { WORDS, type RaccoonLocal, type WindowState } from "../contract.ts";
import { ClockNotice, UpdateBanner } from "./Banners.tsx";
import { BackupsSection } from "./BackupsSection.tsx";
import { Footer } from "./FooterSection.tsx";
import { PlayersSection } from "./PlayersSection.tsx";
import { RoomsSection } from "./RoomsSection.tsx";
import { SettingsSection } from "./SettingsSection.tsx";
import { BOX, RestoreNotice, Status } from "./StatusSection.tsx";
import { Confirm } from "./ui.tsx";
import { currentError, serverUp } from "./view.ts";

/** The window's one scrolling page (design 9). `bridge` is `window.raccoonLocal`, or the fake. */
export function App(props: { bridge: RaccoonLocal }) {
  const { bridge } = props;
  const [state, setState] = useState<WindowState | null>(null);
  useEffect(() => bridge.subscribe(setState), [bridge]);
  const now = useNow();
  const [quitAsk, setQuitAsk] = useState(false);
  const open = useRef<HTMLButtonElement>(null);

  const sup = state?.supervisor ?? null;
  const up = serverUp(sup);
  // The window opens with focus on Open RaccoonVTT. It cannot hold focus before the server answers, so it takes it
  // the first time it is enabled, unless the person has already moved on to something else.
  const focused = useRef(false);
  useEffect(() => {
    if (!up || focused.current) return;
    focused.current = true;
    const active = document.activeElement;
    if (active === null || active === document.body) open.current?.focus();
  }, [up]);

  if (!state) return null;
  const error = currentError(state);
  const devices = sup?.remoteDevices ?? 0;

  const quit = () => {
    if (devices > 0) setQuitAsk(true);
    else void bridge.quit();
  };
  const toBackups = () => {
    const section = document.querySelector<HTMLElement>("[data-card=backups]");
    section?.scrollIntoView({ block: "start" });
    const first = section?.querySelector<HTMLButtonElement>("ul button:not([disabled])");
    (first ?? section?.querySelector<HTMLButtonElement>("button:not([disabled])"))?.focus({ preventScroll: true });
  };
  const players = sup !== null && error === null && (sup.state === "running" || sup.state === "restarting");

  return (
    <div style={{ height: "100%", overflowY: "auto", background: theme.color.bg, color: theme.color.text }}>
      <main style={{ display: "grid", gap: theme.space(3), maxWidth: 640, margin: "0 auto", padding: theme.space(4), minWidth: 0 }}>
        <UpdateBanner shell={state.shell} bridge={bridge} />
        <ClockNotice minutes={state.shell.clockOffsetMinutes} />
        <RestoreNotice notice={sup?.notice ?? null} now={now} />
        <Status state={state} bridge={bridge} now={now} onRestoreChoice={toBackups} onQuit={quit} />
        {players ? <PlayersSection sup={sup} platform={state.shell.platform} bridge={bridge} /> : null}
        {sup && !error ? (
          <>
            <div style={BOX}>
              <Button ref={open} variant="primary" block disabled={!up} onClick={() => void bridge.openApp()}>
                {WORDS.openApp}
              </Button>
            </div>
            <RoomsSection sup={sup} bridge={bridge} now={now} />
          </>
        ) : null}
        {sup ? <BackupsSection sup={sup} bridge={bridge} now={now} /> : null}
        {sup ? <SettingsSection sup={sup} bridge={bridge} /> : null}
        <Footer version={state.shell.version} bridge={bridge} onQuit={quit} />
      </main>
      {quitAsk ? (
        <Confirm
          name={WORDS.quit.quit}
          question={WORDS.quit.confirm(devices)}
          confirm={WORDS.quit.quit}
          cancel={WORDS.quit.keepRunning}
          danger
          onCancel={() => setQuitAsk(false)}
          onConfirm={() => {
            setQuitAsk(false);
            void bridge.quit();
          }}
        />
      ) : null}
    </div>
  );
}

/** The clock for relative times, refreshed each minute, so "2 minutes ago" does not go stale in an open window. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}
