import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneTaskState,
  createTask,
  displayLabel,
  emptyTaskState,
  formatFooter,
  normalizeTaskState,
  openBlockers,
  taskCounts,
  updateTask,
} from "./core.ts";

test("displayLabel removes terminal escapes and control bytes", () => {
  assert.equal(
    displayLabel(
      "  Build\u001b[31m red\u001b[0m\u001b]0;injected title\u0007\u0000\nnow  ",
    ),
    "Build red now",
  );
  assert.equal(displayLabel("\u001b]0;unterminated"), "0;unterminated");
});

test("TaskCreate assigns monotonic IDs and pending status", () => {
  const state = emptyTaskState();
  const first = createTask(state, {
    subject: "  Inspect\ntask tools  ",
    description: "Read the task implementation",
    activeForm: "  Inspecting\ttask tools  ",
  });
  const second = createTask(state, {
    subject: "Build extension",
    description: "Implement the Task tools",
  });

  assert.deepEqual(first, {
    id: "1",
    subject: "  Inspect\ntask tools  ",
    description: "Read the task implementation",
    activeForm: "  Inspecting\ttask tools  ",
    status: "pending",
    blocks: [],
    blockedBy: [],
    owner: undefined,
    metadata: undefined,
  });
  assert.equal(second.id, "2");
  assert.equal(state.nextId, 3);
});

test("TaskUpdate projects dependencies symmetrically and filters completed blockers", () => {
  const state = emptyTaskState();
  createTask(state, { subject: "Build core", description: "Build it" });
  createTask(state, { subject: "Run tests", description: "Test it" });

  assert.deepEqual(updateTask(state, { taskId: "2", addBlockedBy: ["1"] }), {
    success: true,
    taskId: "2",
    updatedFields: ["blockedBy"],
    statusChange: undefined,
  });
  assert.deepEqual(state.tasks[0]?.blocks, ["2"]);
  assert.deepEqual(state.tasks[1]?.blockedBy, ["1"]);
  assert.deepEqual(openBlockers(state, state.tasks[1]!), ["1"]);

  updateTask(state, { taskId: "1", status: "completed" });
  assert.deepEqual(openBlockers(state, state.tasks[1]!), []);
});

test("dependency cycles are rejected atomically and cannot restore", () => {
  const state = emptyTaskState();
  createTask(state, { subject: "One", description: "One" });
  createTask(state, { subject: "Two", description: "Two" });
  assert.equal(
    updateTask(state, { taskId: "1", addBlocks: ["2"] }).success,
    true,
  );
  const before = cloneTaskState(state);
  assert.deepEqual(updateTask(state, { taskId: "2", addBlocks: ["1"] }), {
    success: false,
    taskId: "2",
    updatedFields: [],
    error: "Task dependencies cannot contain a cycle",
  });
  assert.deepEqual(cloneTaskState(state), before);

  const cyclic = cloneTaskState(state);
  cyclic.tasks[0]!.blockedBy = ["2"];
  cyclic.tasks[1]!.blocks = ["1"];
  assert.equal(normalizeTaskState(cyclic), undefined);
});

test("failed dependency updates are atomic", () => {
  const state = emptyTaskState();
  createTask(state, { subject: "Original", description: "Original" });
  const before = cloneTaskState(state);

  assert.equal(
    updateTask(state, {
      taskId: "1",
      subject: "Changed",
      addBlockedBy: ["999"],
    }).success,
    false,
  );
  assert.deepEqual(cloneTaskState(state), before);
});

test("TaskUpdate merges metadata, deletes null keys, and reports status changes", () => {
  const state = emptyTaskState();
  createTask(state, {
    subject: "Build core",
    description: "Build it",
    metadata: { keep: 1, remove: true },
  });

  assert.deepEqual(
    updateTask(state, {
      taskId: "1",
      status: "in_progress",
      owner: "agent-1",
      metadata: { remove: null, added: "yes" },
    }),
    {
      success: true,
      taskId: "1",
      updatedFields: ["owner", "metadata", "status"],
      statusChange: { from: "pending", to: "in_progress" },
    },
  );
  assert.deepEqual(state.tasks[0]?.metadata, { keep: 1, added: "yes" });
});

test("deletion scrubs dependencies without reusing IDs", () => {
  const state = emptyTaskState();
  createTask(state, { subject: "One", description: "One" });
  createTask(state, { subject: "Two", description: "Two" });
  updateTask(state, { taskId: "2", addBlockedBy: ["1"] });
  updateTask(state, { taskId: "1", status: "deleted" });

  assert.deepEqual(state.tasks[0]?.blockedBy, []);
  assert.equal(
    createTask(state, { subject: "Three", description: "Three" }).id,
    "3",
  );
});

test("state snapshots restore safely and reject malformed details", () => {
  const state = emptyTaskState();
  createTask(state, { subject: "One", description: "One" });
  const snapshot = cloneTaskState(state);

  assert.deepEqual(normalizeTaskState(snapshot), snapshot);
  assert.equal(normalizeTaskState({ ...snapshot, nextId: 0 }), undefined);
  assert.equal(normalizeTaskState({ ...snapshot, nextId: 1 }), undefined);
  assert.equal(
    normalizeTaskState({ ...snapshot, nextId: Number.MAX_SAFE_INTEGER + 1 }),
    undefined,
  );
  assert.equal(
    normalizeTaskState({
      ...snapshot,
      tasks: [{ ...snapshot.tasks[0], id: 1 }],
    }),
    undefined,
  );
  assert.equal(
    normalizeTaskState({
      ...snapshot,
      tasks: [{ ...snapshot.tasks[0], status: "doing" }],
    }),
    undefined,
  );
  assert.equal(
    normalizeTaskState({
      ...snapshot,
      tasks: [{ ...snapshot.tasks[0], blocks: ["2"] }],
    }),
    undefined,
  );
});

test("footer renders a multiline task list", () => {
  const state = emptyTaskState();
  assert.equal(formatFooter(state.tasks), "  0 tasks (0 done, 0 open)");

  createTask(state, {
    subject: "Build extension",
    description: "Build it",
    activeForm: "Building extension",
  });
  createTask(state, { subject: "Run tests", description: "Test it" });
  updateTask(state, { taskId: "1", status: "in_progress" });
  assert.equal(
    formatFooter(state.tasks),
    [
      "  2 tasks (0 done, 1 in progress, 1 open)",
      "  ◼ Building extension",
      "  ◻ Run tests",
    ].join("\n"),
  );

  updateTask(state, { taskId: "1", status: "completed" });
  const blocker = createTask(state, {
    subject: "Unblock tests",
    description: "Unblock them",
  });
  updateTask(state, { taskId: "2", addBlockedBy: [blocker.id] });
  assert.equal(
    formatFooter(state.tasks),
    [
      "  3 tasks (1 done, 2 open)",
      "  ✔ Build extension",
      "  ◻ Run tests › blocked by #3",
      "  ◻ Unblock tests",
    ].join("\n"),
  );

  updateTask(state, { taskId: blocker.id, status: "completed" });
  updateTask(state, { taskId: "2", status: "completed" });
  for (const subject of ["Four", "Five", "Six"])
    createTask(state, { subject, description: subject });
  assert.equal(
    formatFooter(state.tasks),
    [
      "  6 tasks (3 done, 3 open)",
      "  ◻ Four",
      "  ◻ Five",
      "  ◻ Six",
      "  ✔ Build extension",
      "  ✔ Run tests",
      "   … +1 completed",
    ].join("\n"),
  );
  assert.deepEqual(taskCounts(state.tasks), {
    total: 6,
    completed: 3,
    inProgress: 0,
    pending: 3,
  });
});
