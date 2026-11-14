import { useEffect, useRef, useState } from "react";
import { Button } from "../../client/components/Button.tsx";
import { QrCode } from "../../client/components/QrCode.tsx";
import { Switch } from "../../client/components/Switch.tsx";
import { theme } from "../../client/lib/theme.ts";
import { WORDS, type Platform, type RaccoonLocal, type SupervisorStatus } from "../contract.ts";
import { Card, Help, useAction } from "./ui.tsx";
import { canReconfigure, failureText, notWorkingLines, playersView, restoring, switchBusy } from "./view.ts";

/** Players join at (design 9, item 2): the address, Copy, the QR code, the switch, the device count and Not working?. */
export function PlayersSection(props: { sup: SupervisorStatus; platform: Platform; bridge: RaccoonLocal }) {
  const { sup, bridge } = props;
  const view = playersView(sup);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const [fold, setFold] = useState(false);
  const toggle = useAction(async (on: boolean) => {
    const result = await bridge.setNetworkPlay(on);
    return result.ok ? null : failureText(result.failure, "other");
  });
  const busy = toggle.busy || switchBusy(sup);
  const copy = () => {
    if (!view.address) return;
    void bridge.copyText(view.address);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Card id="players" title={WORDS.players.heading}>
      {view.address ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(3), alignItems: "center" }}>
          <div role="group" aria-labelledby="players" style={{ display: "grid", gap: theme.space(2), flex: "1 1 180px", minWidth: 0 }}>
            <p data-address="" style={{ margin: 0, fontSize: theme.font.title, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, overflowWrap: "anywhere", userSelect: "all" }}>
              {view.address}
            </p>
            <div>
              <Button size="sm" aria-live="polite" onClick={copy}>
                {copied ? WORDS.players.copied : WORDS.players.copy}
              </Button>
            </div>
          </div>
          <QrCode value={view.address} size={144} label={WORDS.players.qrAlt(view.address)} />
        </div>
      ) : null}
      <Switch
        label={WORDS.players.switch}
        help={view.note ?? undefined}
        checked={sup.settings.networkPlay}
        busy={busy}
        disabled={restoring(sup) || (!canReconfigure(sup) && !busy)}
        onChange={(on) => void toggle.start(on)}
      />
      {toggle.error ? <Help role="alert" tone="danger">{toggle.error}</Help> : null}
      <Help>{view.devices}</Help>
      {view.awake ? <Help>{WORDS.players.awake}</Help> : null}
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <div>
          <Button size="sm" expanded={fold} aria-controls="not-working" onClick={() => setFold((f) => !f)}>
            {WORDS.notWorking.heading}
          </Button>
        </div>
        {fold ? (
          <div id="not-working" style={{ display: "grid", gap: theme.space(2) }}>
            {notWorkingLines(sup, props.platform).map((line) => (
              <Help key={line} style={line.startsWith("If a firewall") ? { fontFamily: theme.font.mono, userSelect: "text" } : undefined}>
                {line}
              </Help>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
