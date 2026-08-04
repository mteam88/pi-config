import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const ASK_USER_TIMEOUT_VALUES = ["never", "60s", "5m", "10m"] as const;
export type AskUserQuestionTimeout = (typeof ASK_USER_TIMEOUT_VALUES)[number];

const TIMEOUT_MS: Record<AskUserQuestionTimeout, number | null> = {
  never: null,
  "60s": 60_000,
  "5m": 300_000,
  "10m": 600_000,
};

export const ASK_USER_COUNTDOWN_THRESHOLD_MS = 20_000;

export interface IdleTimeoutSnapshot {
  remainingSeconds: number;
  showCountdown: boolean;
  timedOut: boolean;
}

export function parseAskUserQuestionTimeout(value: unknown): number | null {
  return typeof value === "string" && Object.hasOwn(TIMEOUT_MS, value)
    ? TIMEOUT_MS[value as AskUserQuestionTimeout]
    : null;
}

export async function loadAskUserQuestionTimeout(
  agentDir: string,
): Promise<number | null> {
  try {
    const settings = JSON.parse(
      await readFile(join(agentDir, "settings.json"), "utf8"),
    ) as { askUserQuestionTimeout?: unknown };
    return parseAskUserQuestionTimeout(settings.askUserQuestionTimeout);
  } catch {
    return null;
  }
}

export function resetIdleTimeoutAfterActivity(
  timeoutMs: number,
  lastActivityAt: number,
  now: number,
): number | null {
  return now - lastActivityAt >= timeoutMs ? null : now;
}

export function getIdleTimeoutSnapshot(
  timeoutMs: number,
  lastActivityAt: number,
  now: number,
  countdownThresholdMs = ASK_USER_COUNTDOWN_THRESHOLD_MS,
): IdleTimeoutSnapshot {
  const elapsedMs = Math.max(0, now - lastActivityAt);
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  const thresholdMs = Math.min(countdownThresholdMs, timeoutMs);

  return {
    remainingSeconds: Math.ceil(remainingMs / 1000),
    showCountdown: remainingMs <= thresholdMs,
    timedOut: elapsedMs >= timeoutMs,
  };
}
