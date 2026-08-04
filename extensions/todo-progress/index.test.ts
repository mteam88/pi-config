import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import taskProgress from "./index.ts";
import {
  TASK_CREATE_PROMPT,
  TASK_GET_PROMPT,
  TASK_LIST_PROMPT,
  TASK_UPDATE_PROMPT,
} from "./prompts.ts";

test("registers Task* tools with useful model-facing prompts", () => {
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerShortcut() {},
    on() {},
  } as unknown as ExtensionAPI;

  taskProgress(pi);

  assert.deepEqual(
    [...tools.keys()],
    ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList"],
  );
  assert.equal(tools.get("TaskCreate")?.description, TASK_CREATE_PROMPT);
  assert.equal(tools.get("TaskGet")?.description, TASK_GET_PROMPT);
  assert.equal(tools.get("TaskUpdate")?.description, TASK_UPDATE_PROMPT);
  assert.equal(tools.get("TaskList")?.description, TASK_LIST_PROMPT);
  assert.equal(tools.has("todo_write"), false);
});

test("task prompts cover lifecycle and dependency guidance", () => {
  assert.match(TASK_CREATE_PROMPT, /multi-step/u);
  assert.match(TASK_CREATE_PROMPT, /pending/u);
  assert.match(TASK_GET_PROMPT, /blockedBy/u);
  assert.match(TASK_UPDATE_PROMPT, /in_progress/u);
  assert.match(TASK_UPDATE_PROMPT, /completed/u);
  assert.match(TASK_LIST_PROMPT, /unblocked pending task/u);
});

test("TaskCreate and TaskUpdate persist state in tool details and refresh the footer", async () => {
  const tools = new Map<string, any>();
  const statuses: string[] = [];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerShortcut() {},
    on() {},
  } as unknown as ExtensionAPI;
  taskProgress(pi);

  const ctx = {
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        strikethrough: (text: string) => text,
      },
      setStatus: (_key: string, text: string | undefined) => {
        if (text) statuses.push(text);
      },
    },
  };

  const created = await tools.get("TaskCreate").execute(
    "create-1",
    {
      subject: "Build extension",
      description: "Build it",
      activeForm: "Building extension",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    created.content[0]?.text,
    "Task #1 created successfully: Build extension",
  );
  assert.deepEqual(created.details.task, {
    id: "1",
    subject: "Build extension",
  });
  assert.equal(created.details.__taskProgressState.tasks[0]?.status, "pending");

  const updated = await tools
    .get("TaskUpdate")
    .execute(
      "update-1",
      { taskId: "1", status: "in_progress" },
      undefined,
      undefined,
      ctx,
    );
  assert.equal(updated.content[0]?.text, "Updated task #1 status");
  assert.deepEqual(
    {
      success: updated.details.success,
      taskId: updated.details.taskId,
      updatedFields: updated.details.updatedFields,
      statusChange: updated.details.statusChange,
    },
    {
      success: true,
      taskId: "1",
      updatedFields: ["status"],
      statusChange: { from: "pending", to: "in_progress" },
    },
  );
  assert.equal(
    updated.details.__taskProgressState.tasks[0]?.status,
    "in_progress",
  );
  assert.equal(
    statuses.at(-1),
    "  1 tasks (0 done, 1 in progress, 0 open)\n  ◼ Building extension",
  );

  await tools
    .get("TaskUpdate")
    .execute(
      "complete-1",
      { taskId: "1", status: "completed" },
      undefined,
      undefined,
      ctx,
    );
  await tools.get("TaskCreate").execute(
    "create-2",
    {
      subject: "Verify extension",
      description: "Inspect the result",
      activeForm: "Verifying extension",
      metadata: { gate: "tests" },
    },
    undefined,
    undefined,
    ctx,
  );
  await tools
    .get("TaskUpdate")
    .execute(
      "block-2",
      { taskId: "2", owner: "reviewer", addBlockedBy: ["1"] },
      undefined,
      undefined,
      ctx,
    );
  const fetched = await tools.get("TaskGet").execute("get-2", { taskId: "2" });
  assert.equal(fetched.content[0]?.text.includes("Blocked by:"), false);
  assert.deepEqual(fetched.details.task, {
    id: "2",
    subject: "Verify extension",
    description: "Inspect the result",
    activeForm: "Verifying extension",
    status: "pending",
    owner: "reviewer",
    blocks: [],
    blockedBy: [],
    metadata: { gate: "tests" },
  });
});

test("session_start restores branch-local tool-result state", () => {
  const handlers = new Map<string, any>();
  const statuses: string[] = [];
  const pi = {
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  taskProgress(pi);

  const state = {
    version: 2,
    nextId: 2,
    tasks: [
      {
        id: "1",
        subject: "Build extension",
        description: "Build it",
        activeForm: "Building extension",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
      },
    ],
  };
  const ctx = {
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "TaskUpdate",
            details: { __taskProgressState: state },
          },
        },
      ],
    },
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        strikethrough: (text: string) => text,
      },
      setStatus: (_key: string, text: string | undefined) => {
        if (text) statuses.push(text);
      },
    },
  };

  handlers.get("session_start")({}, ctx);
  assert.equal(
    statuses.at(-1),
    "  1 tasks (0 done, 1 in progress, 0 open)\n  ◼ Building extension",
  );

  const failedMutation = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "TaskUpdate",
      isError: true,
      details: {},
    },
  };
  handlers.get("session_start")(
    {},
    {
      ...ctx,
      sessionManager: {
        getBranch: () => [...ctx.sessionManager.getBranch(), failedMutation],
      },
    },
  );
  assert.equal(
    statuses.at(-1),
    "  1 tasks (0 done, 1 in progress, 0 open)\n  ◼ Building extension",
  );

  handlers.get("session_start")(
    {},
    {
      ...ctx,
      sessionManager: {
        getBranch: () => [
          ...ctx.sessionManager.getBranch(),
          failedMutation,
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "TaskUpdate",
              details: { __taskProgressState: { version: 2, tasks: [] } },
            },
          },
        ],
      },
    },
  );
  assert.equal(statuses.at(-1), "  0 tasks (0 done, 0 open)");
});
