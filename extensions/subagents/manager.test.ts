/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  MAX_RUNNING,
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("waitFor returns when any listed subagent settles", async () => {
  await withManager(async (manager, runtime) => {
    const slow = await runTool(
      runtime,
      manager.spawn("claude", task("Take the normal slow path")),
    );
    const fast = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: finish early")),
    );

    const settled = await runTool(runtime, manager.waitFor([slow.id, fast.id]));

    assert.deepEqual(settled, [fast.id]);
    assert.equal(manager.view.get(fast.id)?.status, "error");
    assert.equal(manager.view.get(slow.id)?.status, "running");
    await runTool(runtime, manager.cancel([slow.id]));
  });
});

test("waitFor stops on steering interruption and leaves children running", async () => {
  await withManager(async (manager, runtime) => {
    const slow = await runTool(
      runtime,
      manager.spawn("claude", task("Take the normal slow path")),
    );
    const steering = new AbortController();
    const waiting = runTool(
      runtime,
      manager.waitFor([slow.id], undefined, steering.signal),
    );

    steering.abort();

    assert.deepEqual(await waiting, []);
    assert.equal(manager.view.get(slow.id)?.status, "running");
    await runTool(runtime, manager.cancel([slow.id]));
  });
});

test("waitFor preserves genuine tool AbortSignal cancellation", async () => {
  await withManager(async (manager, runtime) => {
    const slow = await runTool(
      runtime,
      manager.spawn("claude", task("Take the normal slow path")),
    );
    const toolAbort = new AbortController();
    const waiting = runTool(runtime, manager.waitFor([slow.id]), {
      signal: toolAbort.signal,
      interruptMessage: "Wait aborted. Subagents keep running.",
    });

    toolAbort.abort();

    await assert.rejects(waiting, /Wait aborted\. Subagents keep running\./);
    assert.equal(manager.view.get(slow.id)?.status, "running");
    await runTool(runtime, manager.cancel([slow.id]));
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      ...Array.from({ length: MAX_RUNNING - 1 }, (_, index) =>
        task(`Task ${index + 2}`),
      ),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, MAX_RUNNING);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      new RegExp(`Max ${MAX_RUNNING} subagents`),
    );
  });
});

test("the concurrency cap rejects one extra running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: MAX_RUNNING }, (_, index) => index + 1),
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, MAX_RUNNING);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task(`Task ${MAX_RUNNING + 1}`))),
      new RegExp(`Max ${MAX_RUNNING} subagents`),
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill every slot with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: MAX_RUNNING }, (_, index) => index + 1),
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would exceed the cap.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      new RegExp(`Max ${MAX_RUNNING} subagents`),
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("restored subagents stay dormant and resume on send", async () => {
  const firstRuntime = createTestRuntime();
  let saved: ReturnType<SubagentManagerShape["view"]["persisted"]>[number];
  try {
    const manager = await firstRuntime.runPromise(SubagentManager);
    const started = await runTool(
      firstRuntime,
      manager.spawn("claude", task("Persist me")),
    );
    await runTool(firstRuntime, manager.waitFor([started.id]));
    saved = manager.view.persisted()[0];
  } finally {
    await firstRuntime.dispose();
  }

  const secondRuntime = createTestRuntime();
  try {
    const manager = await secondRuntime.runPromise(SubagentManager);
    await runTool(
      secondRuntime,
      manager.restore([saved], () => parent),
    );
    assert.equal(manager.view.get(saved.snapshot.id)?.status, "done");

    await runTool(secondRuntime, manager.send(saved.snapshot.id, "Continue"));
    await runTool(secondRuntime, manager.waitFor([saved.snapshot.id]));
    assert.equal(manager.view.get(saved.snapshot.id)?.status, "done");
    assert.match(
      manager.view.get(saved.snapshot.id)?.finalText ?? "",
      /Continue/,
    );
  } finally {
    await secondRuntime.dispose();
  }
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
