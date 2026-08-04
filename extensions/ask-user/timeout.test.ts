import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { buildAskUserResultMessage } from "./prompt.ts";
import {
  getIdleTimeoutSnapshot,
  loadAskUserQuestionTimeout,
  parseAskUserQuestionTimeout,
  resetIdleTimeoutAfterActivity,
} from "./src/timeout.ts";

test("uses Claude Code's askUserQuestionTimeout values", () => {
  assert.equal(parseAskUserQuestionTimeout("never"), null);
  assert.equal(parseAskUserQuestionTimeout("60s"), 60_000);
  assert.equal(parseAskUserQuestionTimeout("5m"), 300_000);
  assert.equal(parseAskUserQuestionTimeout("10m"), 600_000);
  assert.equal(parseAskUserQuestionTimeout("1m"), null);
  assert.equal(parseAskUserQuestionTimeout("toString"), null);
  assert.equal(parseAskUserQuestionTimeout(60_000), null);
});

test("loads askUserQuestionTimeout from the global Pi settings file", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "ask-user-timeout-"));
  try {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ askUserQuestionTimeout: "5m" }),
    );
    assert.equal(await loadAskUserQuestionTimeout(agentDir), 300_000);

    await writeFile(join(agentDir, "settings.json"), "not json");
    assert.equal(await loadAskUserQuestionTimeout(agentDir), null);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("shows the final 20-second countdown and times out on inactivity", () => {
  assert.deepEqual(getIdleTimeoutSnapshot(60_000, 1_000, 40_999), {
    remainingSeconds: 21,
    showCountdown: false,
    timedOut: false,
  });
  assert.deepEqual(getIdleTimeoutSnapshot(60_000, 1_000, 41_000), {
    remainingSeconds: 20,
    showCountdown: true,
    timedOut: false,
  });
  assert.deepEqual(getIdleTimeoutSnapshot(60_000, 1_000, 61_000), {
    remainingSeconds: 0,
    showCountdown: true,
    timedOut: true,
  });
});

test("activity starts a fresh timeout window but cannot revive an expired one", () => {
  const timeoutMs = 60_000;
  const activityAt = 55_000;
  assert.deepEqual(
    getIdleTimeoutSnapshot(timeoutMs, activityAt, activityAt + 1_000),
    {
      remainingSeconds: 59,
      showCountdown: false,
      timedOut: false,
    },
  );
  assert.equal(resetIdleTimeoutAfterActivity(timeoutMs, 1_000, 60_999), 60_999);
  assert.equal(resetIdleTimeoutAfterActivity(timeoutMs, 1_000, 61_000), null);
  assert.equal(resetIdleTimeoutAfterActivity(timeoutMs, 1_000, 61_001), null);
});

test("uses a fail-closed model-facing timeout result", () => {
  assert.equal(
    buildAskUserResultMessage({ kind: "timeout", afkTimeoutMs: 60_000 }),
    "No response after 60s — the user may be away from keyboard. A timeout is not approval or consent. Continue only with work that does not require user authorization; otherwise leave the action pending and re-ask later.",
  );
});

test("the real tool resets on activity, then continues without an answer", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "ask-user-tool-timeout-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ askUserQuestionTimeout: "60s" }),
  );

  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });

  try {
    const { default: registerAskUser } = await import("./index.ts");
    let tool: ToolDefinition<any, any, any> | undefined;
    registerAskUser({
      registerTool(definition: ToolDefinition<any, any, any>) {
        tool = definition;
      },
    } as unknown as ExtensionAPI);
    assert.ok(tool);

    let component: Component | undefined;
    let resolveComponent: ((value: Component) => void) | undefined;
    const componentReady = new Promise<Component>((resolve) => {
      resolveComponent = resolve;
    });
    let doneCalls = 0;
    const theme = {
      fg: (_color: string, value: string) => value,
      bold: (value: string) => value,
    };
    const ctx = {
      mode: "tui",
      ui: {
        custom(factory: (...args: any[]) => Component) {
          return new Promise((resolve) => {
            const rendered = factory(
              { requestRender() {} },
              theme,
              {},
              (value: unknown) => {
                doneCalls++;
                resolve(value);
              },
            );
            component = rendered;
            resolveComponent?.(rendered);
          });
        },
      },
    } as unknown as ExtensionContext;

    const pending = tool.execute(
      "timeout-test",
      {
        question: "Wait for timeout?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
      undefined,
      undefined,
      ctx,
    );

    component = await componentReady;

    t.mock.timers.tick(40_000);
    assert.match(component.render(80).join("\n"), /auto-continue in 20s/);

    component.handleInput?.("x");
    assert.doesNotMatch(component.render(80).join("\n"), /auto-continue/);

    t.mock.timers.tick(59_000);
    assert.equal(doneCalls, 0);
    assert.match(component.render(80).join("\n"), /auto-continue in 1s/);

    t.mock.timers.tick(1_000);
    const result = await pending;
    assert.equal(doneCalls, 1);
    assert.deepEqual(result.details, {
      question: "Wait for timeout?",
      options: ["Yes", "No"],
      answer: null,
      wasCustom: false,
      cancelled: false,
      timedOut: true,
      afkTimeoutMs: 60_000,
    });
    assert.equal(
      result.content[0]?.type === "text" ? result.content[0].text : undefined,
      "No response after 60s — the user may be away from keyboard. A timeout is not approval or consent. Continue only with work that does not require user authorization; otherwise leave the action pending and re-ask later.",
    );
  } finally {
    t.mock.timers.reset();
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
});
