import { useState } from "react";
import { Button } from "../../client/components/Button.tsx";
import { Input } from "../../client/components/Field.tsx";
import { Switch } from "../../client/components/Switch.tsx";
import { theme } from "../../client/lib/theme.ts";
import { WORDS, type RaccoonLocal, type SettingsPatch, type SupervisorStatus } from "../contract.ts";
import { ButtonRow, Card, Confirm, Help, useAction } from "./ui.tsx";
import { canReconfigure, checkPort, failureText, portBusy, restoring } from "./view.ts";

/** Settings (design 9, item 6): Port with Change port, the two daily choices, and the two folders. */
export function SettingsSection(props: { sup: SupervisorStatus | null; bridge: RaccoonLocal }) {
  const { sup, bridge } = props;
  const current = sup?.settings.port ?? sup?.port ?? null;
  const [text, setText] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const shown = text ?? (current === null ? "" : String(current));
  const check = checkPort(shown);
  const reconfigure = canReconfigure(sup);

  const changePort = useAction(async (port: number) => {
    const result = await bridge.setPort(port);
    if (result.ok) setText(null);
    return result.ok ? null : failureText(result.failure, "other");
  });
  const setting = useAction(async (patch: SettingsPatch) => {
    const result = await bridge.setSettings(patch);
    return result.ok ? null : failureText(result.failure, "other");
  });
  const portWorking = changePort.busy || portBusy(sup);
  const edited = check.ok && check.port !== current;

  return (
    <Card id="settings" title={WORDS.settings.heading}>
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <label htmlFor="port" style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>
          {WORDS.settings.port}
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          <Input
            id="port"
            inputMode="numeric"
            autoComplete="off"
            value={shown}
            error={text !== null && !check.ok}
            disabled={!reconfigure || portWorking}
            aria-describedby={text !== null && !check.ok ? "port-help" : undefined}
            onChange={(e) => setText(e.target.value)}
            style={{ width: 120 }}
          />
          <Button disabled={!reconfigure || !edited} busy={portWorking} onClick={() => check.ok && setAsking(check.port)}>
            {WORDS.settings.changePort}
          </Button>
        </div>
        {text !== null && !check.ok ? <Help tone="danger" role="alert"><span id="port-help">{WORDS.settings.portRange}</span></Help> : null}
        {changePort.error ? <Help role="alert" tone="danger">{changePort.error}</Help> : null}
      </div>
      <Switch label={WORDS.settings.checkUpdates} checked={sup?.settings.checkUpdates ?? true} disabled={!sup || restoring(sup)} onChange={(on) => void setting.start({ checkUpdates: on })} />
      <Switch label={WORDS.settings.openBrowser} checked={sup?.settings.openBrowser ?? true} disabled={!sup || restoring(sup)} onChange={(on) => void setting.start({ openBrowser: on })} />
      {setting.error ? <Help role="alert" tone="danger">{setting.error}</Help> : null}
      <ButtonRow>
        <Button size="sm" onClick={() => void bridge.openFolder("data")}>{WORDS.settings.showData}</Button>
        <Button size="sm" onClick={() => void bridge.openFolder("logs")}>{WORDS.settings.showLogs}</Button>
      </ButtonRow>
      {asking !== null ? (
        <Confirm
          name={WORDS.settings.changePort}
          question={WORDS.settings.confirmPort(asking)}
          confirm={WORDS.settings.changePort}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const port = asking;
            setAsking(null);
            void changePort.start(port);
          }}
        />
      ) : null}
    </Card>
  );
}
