/** How log entries read on this device. */
export * from "#shared/logText.ts";

import type { LogEvent } from "#shared/model.ts";
import type { CorrectionLogEvent } from "#shared/undoContract.ts";
import { describeEvent as describeSharedEvent, type LogNames } from "#shared/logText.ts";
import { correctionText } from "./corrections.ts";

export function describeEvent(data: LogEvent | CorrectionLogEvent, names: LogNames, dm = false): string {
  return data.type === "correction" ? correctionText(data, dm) : describeSharedEvent(data, names, dm);
}
