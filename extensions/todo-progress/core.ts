export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskState {
  version: 2;
  tasks: TaskItem[];
  nextId: number;
}

export interface TaskUpdateInput {
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus | "deleted";
  addBlocks?: string[];
  addBlockedBy?: string[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskUpdateResult {
  success: boolean;
  taskId: string;
  updatedFields: string[];
  error?: string;
  statusChange?: { from: string; to: string };
}

export function emptyTaskState(): TaskState {
  return { version: 2, tasks: [], nextId: 1 };
}

function cloneTask(task: TaskItem): TaskItem {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    owner: task.owner,
    metadata: task.metadata ? { ...task.metadata } : undefined,
  };
}

export function cloneTaskState(state: TaskState): TaskState {
  return {
    version: 2,
    tasks: state.tasks.map(cloneTask),
    nextId: state.nextId,
  };
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function hasDependencyCycle(tasks: readonly TaskItem[]): boolean {
  const edges = new Map(tasks.map((task) => [task.id, task.blocks]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const blockedId of edges.get(id) ?? []) {
      if (visit(blockedId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return tasks.some((task) => visit(task.id));
}

function wouldCreateDependencyCycle(
  state: TaskState,
  input: TaskUpdateInput,
): boolean {
  const proposed = state.tasks.map(cloneTask);
  const task = proposed.find((candidate) => candidate.id === input.taskId)!;
  for (const blockedId of input.addBlocks ?? []) {
    addUnique(task.blocks, blockedId);
  }
  for (const blockerId of input.addBlockedBy ?? []) {
    const blocker = proposed.find((candidate) => candidate.id === blockerId)!;
    addUnique(blocker.blocks, input.taskId);
  }
  return hasDependencyCycle(proposed);
}

export function normalizeTaskState(value: unknown): TaskState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 2 || !Array.isArray(raw.tasks)) return undefined;
  if (!Number.isSafeInteger(raw.nextId) || (raw.nextId as number) < 1)
    return undefined;

  const tasks: TaskItem[] = [];
  for (const entry of raw.tasks) {
    if (!entry || typeof entry !== "object") return undefined;
    const task = entry as Record<string, unknown>;
    if (typeof task.id !== "string" || !/^[1-9]\d*$/u.test(task.id))
      return undefined;
    if (!Number.isSafeInteger(Number(task.id))) return undefined;
    if (
      typeof task.subject !== "string" ||
      typeof task.description !== "string"
    )
      return undefined;
    if (task.activeForm !== undefined && typeof task.activeForm !== "string")
      return undefined;
    if (task.owner !== undefined && typeof task.owner !== "string")
      return undefined;
    if (!TASK_STATUSES.includes(task.status as TaskStatus)) return undefined;
    if (!stringArray(task.blocks) || !stringArray(task.blockedBy))
      return undefined;
    if (
      task.metadata !== undefined &&
      (!task.metadata ||
        typeof task.metadata !== "object" ||
        Array.isArray(task.metadata))
    )
      return undefined;

    tasks.push({
      id: task.id as string,
      subject: task.subject,
      description: task.description,
      activeForm: task.activeForm as string | undefined,
      status: task.status as TaskStatus,
      owner: task.owner as string | undefined,
      blocks: [...new Set(task.blocks)],
      blockedBy: [...new Set(task.blockedBy)],
      metadata: task.metadata
        ? { ...(task.metadata as Record<string, unknown>) }
        : undefined,
    });
  }

  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) return undefined;
  const maxId = tasks.reduce((max, task) => Math.max(max, Number(task.id)), 0);
  if ((raw.nextId as number) <= maxId) return undefined;

  for (const task of tasks) {
    if (task.blocks.includes(task.id) || task.blockedBy.includes(task.id))
      return undefined;
    for (const blockedId of task.blocks) {
      const blocked = tasks.find((candidate) => candidate.id === blockedId);
      if (!blocked?.blockedBy.includes(task.id)) return undefined;
    }
    for (const blockerId of task.blockedBy) {
      const blocker = tasks.find((candidate) => candidate.id === blockerId);
      if (!blocker?.blocks.includes(task.id)) return undefined;
    }
  }
  if (hasDependencyCycle(tasks)) return undefined;

  return { version: 2, tasks, nextId: raw.nextId as number };
}

export function createTask(
  state: TaskState,
  input: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  },
): TaskItem {
  const task: TaskItem = {
    id: String(state.nextId),
    subject: sanitizeTerminalText(input.subject),
    description: sanitizeTerminalText(input.description),
    activeForm:
      input.activeForm === undefined
        ? undefined
        : sanitizeTerminalText(input.activeForm),
    status: "pending",
    blocks: [],
    blockedBy: [],
    metadata: input.metadata ? { ...input.metadata } : undefined,
  };
  state.nextId += 1;
  state.tasks.push(task);
  return cloneTask(task);
}

export function getTask(
  state: TaskState,
  taskId: string,
): TaskItem | undefined {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  return task ? cloneTask(task) : undefined;
}

function addUnique(values: string[], value: string): boolean {
  if (values.includes(value)) return false;
  values.push(value);
  return true;
}

export function updateTask(
  state: TaskState,
  input: TaskUpdateInput,
): TaskUpdateResult {
  const task = state.tasks.find((candidate) => candidate.id === input.taskId);
  if (!task)
    return {
      success: false,
      taskId: input.taskId,
      updatedFields: [],
      error: "Task not found",
    };

  if (input.status === "deleted") {
    state.tasks = state.tasks.filter(
      (candidate) => candidate.id !== input.taskId,
    );
    for (const other of state.tasks) {
      other.blocks = other.blocks.filter((id) => id !== input.taskId);
      other.blockedBy = other.blockedBy.filter((id) => id !== input.taskId);
    }
    return {
      success: true,
      taskId: input.taskId,
      updatedFields: ["deleted"],
      statusChange: { from: task.status, to: "deleted" },
    };
  }

  const dependencyIds = [
    ...(input.addBlocks ?? []),
    ...(input.addBlockedBy ?? []),
  ];
  const missing = dependencyIds.find(
    (id) =>
      id === input.taskId ||
      !state.tasks.some((candidate) => candidate.id === id),
  );
  if (missing) {
    return {
      success: false,
      taskId: input.taskId,
      updatedFields: [],
      error:
        missing === input.taskId
          ? "A task cannot depend on itself"
          : `Task #${missing} not found`,
    };
  }
  if (wouldCreateDependencyCycle(state, input)) {
    return {
      success: false,
      taskId: input.taskId,
      updatedFields: [],
      error: "Task dependencies cannot contain a cycle",
    };
  }

  const updatedFields: string[] = [];
  const priorStatus = task.status;

  if (input.subject !== undefined && input.subject !== task.subject) {
    task.subject = sanitizeTerminalText(input.subject);
    updatedFields.push("subject");
  }
  if (
    input.description !== undefined &&
    input.description !== task.description
  ) {
    task.description = sanitizeTerminalText(input.description);
    updatedFields.push("description");
  }
  if (input.activeForm !== undefined && input.activeForm !== task.activeForm) {
    task.activeForm = sanitizeTerminalText(input.activeForm);
    updatedFields.push("activeForm");
  }
  if (input.owner !== undefined && input.owner !== task.owner) {
    task.owner = sanitizeTerminalText(input.owner);
    updatedFields.push("owner");
  }
  if (input.metadata !== undefined) {
    const metadata = { ...(task.metadata ?? {}) };
    for (const [key, metadataValue] of Object.entries(input.metadata)) {
      if (metadataValue === null) delete metadata[key];
      else metadata[key] = metadataValue;
    }
    task.metadata = metadata;
    updatedFields.push("metadata");
  }
  if (input.status !== undefined && input.status !== task.status) {
    task.status = input.status;
    updatedFields.push("status");
  }

  if (input.addBlocks) {
    let changed = false;
    for (const blockedId of input.addBlocks) {
      const blocked = state.tasks.find(
        (candidate) => candidate.id === blockedId,
      )!;
      changed = addUnique(task.blocks, blockedId) || changed;
      addUnique(blocked.blockedBy, input.taskId);
    }
    if (changed) updatedFields.push("blocks");
  }
  if (input.addBlockedBy) {
    let changed = false;
    for (const blockerId of input.addBlockedBy) {
      const blocker = state.tasks.find(
        (candidate) => candidate.id === blockerId,
      )!;
      changed = addUnique(task.blockedBy, blockerId) || changed;
      addUnique(blocker.blocks, input.taskId);
    }
    if (changed) updatedFields.push("blockedBy");
  }

  return {
    success: true,
    taskId: input.taskId,
    updatedFields,
    statusChange:
      input.status !== undefined && input.status !== priorStatus
        ? { from: priorStatus, to: input.status }
        : undefined,
  };
}

export function openBlockers(state: TaskState, task: TaskItem): string[] {
  const completed = new Set(
    state.tasks
      .filter((candidate) => candidate.status === "completed")
      .map((candidate) => candidate.id),
  );
  return task.blockedBy.filter((id) => !completed.has(id));
}

export function taskCounts(tasks: readonly TaskItem[]) {
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.status === "completed").length,
    inProgress: tasks.filter((task) => task.status === "in_progress").length,
    pending: tasks.filter((task) => task.status === "pending").length,
  };
}

// Model-controlled task labels are rendered directly in the terminal. Strip
// complete ANSI/OSC sequences and any remaining control bytes before styling.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/gu;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(CONTROL_PATTERN, "");
}

export function displayLabel(value: string, fallback = "(untitled)"): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim() || fallback;
}

export function taskDisplayLabel(task: TaskItem): string {
  const value =
    task.status === "in_progress" && task.activeForm
      ? task.activeForm
      : task.subject;
  return displayLabel(value);
}

function compareTaskIds(left: TaskItem, right: TaskItem): number {
  const leftId = Number.parseInt(left.id, 10);
  const rightId = Number.parseInt(right.id, 10);
  if (Number.isFinite(leftId) && Number.isFinite(rightId))
    return leftId - rightId;
  return left.id.localeCompare(right.id);
}

function footerTaskOrder(
  tasks: readonly TaskItem[],
  state: TaskState,
  maxVisible: number,
): TaskItem[] {
  if (tasks.length <= maxVisible) return [...tasks].sort(compareTaskIds);

  const active = tasks
    .filter((task) => task.status === "in_progress")
    .sort(compareTaskIds);
  const pending = tasks
    .filter((task) => task.status === "pending")
    .sort((left, right) => {
      const leftBlocked = openBlockers(state, left).length > 0;
      const rightBlocked = openBlockers(state, right).length > 0;
      if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1;
      return compareTaskIds(left, right);
    });
  const completed = tasks
    .filter((task) => task.status === "completed")
    .sort(compareTaskIds);
  return [...active, ...pending, ...completed];
}

export function formatFooter(
  tasks: readonly TaskItem[],
  maxVisible = 5,
): string {
  const counts = taskCounts(tasks);
  const progress =
    counts.inProgress > 0 ? `, ${counts.inProgress} in progress` : "";
  const lines = [
    `  ${counts.total} tasks (${counts.completed} done${progress}, ${counts.pending} open)`,
  ];
  if (tasks.length === 0 || maxVisible <= 0) return lines.join("\n");

  const state: TaskState = { version: 2, tasks: [...tasks], nextId: 1 };
  const ordered = footerTaskOrder(tasks, state, maxVisible);
  const visible = ordered.slice(0, maxVisible);
  const hidden = ordered.slice(maxVisible);

  for (const task of visible) {
    const icon =
      task.status === "completed"
        ? "✔"
        : task.status === "in_progress"
          ? "◼"
          : "◻";
    const blockers = openBlockers(state, task);
    const blocked =
      blockers.length > 0
        ? ` › blocked by ${blockers
            .sort((left, right) => Number(left) - Number(right))
            .map((id) => `#${id}`)
            .join(", ")}`
        : "";
    lines.push(`  ${icon} ${taskDisplayLabel(task)}${blocked}`);
  }

  if (hidden.length > 0) {
    const hiddenCounts = taskCounts(hidden);
    const parts: string[] = [];
    if (hiddenCounts.inProgress > 0)
      parts.push(`${hiddenCounts.inProgress} in progress`);
    if (hiddenCounts.pending > 0) parts.push(`${hiddenCounts.pending} pending`);
    if (hiddenCounts.completed > 0)
      parts.push(`${hiddenCounts.completed} completed`);
    lines.push(`   … +${parts.join(", ")}`);
  }

  return lines.join("\n");
}
