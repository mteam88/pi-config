import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  cloneTaskState,
  createTask,
  displayLabel,
  emptyTaskState,
  formatFooter,
  getTask,
  normalizeTaskState,
  openBlockers,
  sanitizeTerminalText,
  TASK_STATUSES,
  taskCounts,
  taskDisplayLabel,
  updateTask,
  type TaskItem,
  type TaskState,
  type TaskUpdateResult,
} from "./core.ts";
import {
  TASK_CREATE_PROMPT,
  TASK_GET_PROMPT,
  TASK_LIST_PROMPT,
  TASK_UPDATE_PROMPT,
} from "./prompts.ts";

const CREATE_TOOL = "TaskCreate";
const GET_TOOL = "TaskGet";
const LIST_TOOL = "TaskList";
const UPDATE_TOOL = "TaskUpdate";
const STATE_FIELD = "__taskProgressState";
// Sort before transient subagent/workflow statuses in both Pi footer renderers.
const STATUS_KEY = "00-tasks";
const DEFAULT_MAX_VISIBLE_TASKS = 5;

const TASK_ID_SCHEMA = {
  pattern: "^[1-9]\\d*$",
  description: "Numeric identifier of the target task",
} as const;

const TaskCreateParams = Type.Object(
  {
    subject: Type.String({
      maxLength: 240,
      description: "Short action-oriented task name",
    }),
    description: Type.String({
      maxLength: 4_000,
      description: "Scope and expected outcome of the work",
    }),
    activeForm: Type.Optional(
      Type.String({
        maxLength: 240,
        description: "Optional progress label shown while the task is active",
      }),
    ),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        maxProperties: 32,
        description: "Small structured annotations for the task",
      }),
    ),
  },
  { additionalProperties: false },
);

const TaskGetParams = Type.Object(
  {
    taskId: Type.String(TASK_ID_SCHEMA),
  },
  { additionalProperties: false },
);

const TaskUpdateParams = Type.Object(
  {
    taskId: Type.String(TASK_ID_SCHEMA),
    subject: Type.Optional(
      Type.String({
        maxLength: 240,
        description: "Replacement task name",
      }),
    ),
    description: Type.Optional(
      Type.String({
        maxLength: 4_000,
        description: "Replacement scope or expected outcome",
      }),
    ),
    activeForm: Type.Optional(
      Type.String({
        maxLength: 240,
        description: "Replacement progress label for active work",
      }),
    ),
    status: Type.Optional(
      StringEnum([...TASK_STATUSES, "deleted"] as const, {
        description: "Lifecycle state to apply, or deleted to remove the task",
      }),
    ),
    addBlocks: Type.Optional(
      Type.Array(Type.String(TASK_ID_SCHEMA), {
        maxItems: 32,
        uniqueItems: true,
        description: "Tasks that must wait for this one",
      }),
    ),
    addBlockedBy: Type.Optional(
      Type.Array(Type.String(TASK_ID_SCHEMA), {
        maxItems: 32,
        uniqueItems: true,
        description: "Tasks that must finish before this one can start",
      }),
    ),
    owner: Type.Optional(
      Type.String({
        maxLength: 240,
        description: "Replacement assignee label",
      }),
    ),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        maxProperties: 32,
        description:
          "Annotations to merge; a null value removes its existing key",
      }),
    ),
  },
  { additionalProperties: false },
);

const TaskListParams = Type.Object({}, { additionalProperties: false });

interface TaskGetDetails {
  task: {
    id: string;
    subject: string;
    description: string;
    activeForm?: string;
    status: TaskItem["status"];
    owner?: string;
    blocks: string[];
    blockedBy: string[];
    metadata?: Record<string, unknown>;
  } | null;
}

function numericTaskOrder(a: TaskItem, b: TaskItem): number {
  const numeric = Number(a.id) - Number(b.id);
  return Number.isFinite(numeric) && numeric !== 0
    ? numeric
    : a.id.localeCompare(b.id);
}

class TaskListComponent {
  private readonly state: TaskState;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly onRender: () => void;
  private readonly maxVisible: number;
  private selected: number;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    state: TaskState,
    theme: Theme,
    onClose: () => void,
    onRender: () => void,
    maxVisible: number,
  ) {
    this.state = state;
    this.theme = theme;
    this.onClose = onClose;
    this.onRender = onRender;
    this.maxVisible = maxVisible;
    this.state.tasks.sort(numericTaskOrder);
    const active = state.tasks.findIndex(
      (task) => task.status === "in_progress",
    );
    const pending = state.tasks.findIndex((task) => task.status === "pending");
    this.selected = Math.max(0, active >= 0 ? active : pending);
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrlAlt("t"))
    ) {
      this.onClose();
      return;
    }
    if (this.state.tasks.length === 0) return;

    const previous = this.selected;
    if (matchesKey(data, Key.up))
      this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down))
      this.selected = Math.min(this.state.tasks.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.pageUp))
      this.selected = Math.max(0, this.selected - this.maxVisible);
    else if (matchesKey(data, Key.pageDown))
      this.selected = Math.min(
        this.state.tasks.length - 1,
        this.selected + this.maxVisible,
      );

    if (this.selected !== previous) {
      this.invalidate();
      this.onRender();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const tasks = this.state.tasks;
    const counts = taskCounts(tasks);
    const activeSummary =
      counts.inProgress > 0 ? `, ${counts.inProgress} in progress` : "";
    const lines = [
      truncateToWidth(
        ` ${this.theme.fg("accent", this.theme.bold(`${counts.total} tasks`))} ${this.theme.fg("muted", `(${counts.completed} done${activeSummary}, ${counts.pending} open)`)}`,
        width,
      ),
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
    ];

    if (tasks.length === 0) {
      lines.push(
        truncateToWidth(
          ` ${this.theme.fg("dim", "No tasks in this session")}`,
          width,
        ),
      );
    } else {
      const maxStart = Math.max(0, tasks.length - this.maxVisible);
      const start = Math.min(
        maxStart,
        Math.max(0, this.selected - Math.floor(this.maxVisible / 2)),
      );
      const end = Math.min(tasks.length, start + this.maxVisible);
      if (start > 0)
        lines.push(
          truncateToWidth(` ${this.theme.fg("dim", `↑ ${start} more`)}`, width),
        );

      for (let index = start; index < end; index += 1) {
        const task = tasks[index]!;
        const selected = index === this.selected;
        const pointer = selected ? this.theme.fg("accent", "›") : " ";
        const icon =
          task.status === "completed"
            ? this.theme.fg("success", "✔")
            : task.status === "in_progress"
              ? this.theme.fg("accent", "◼")
              : this.theme.fg("text", "◻");
        const owner =
          width >= 60 && task.owner ? ` (@${displayLabel(task.owner)})` : "";
        const blockers = openBlockers(this.state, task);
        const blocked =
          blockers.length > 0
            ? ` › blocked by ${blockers.map((id) => `#${id}`).join(", ")}`
            : "";
        const label = `${taskDisplayLabel(task)}${owner}${blocked}`;
        const styled =
          task.status === "completed"
            ? this.theme.fg("dim", this.theme.strikethrough(label))
            : task.status === "in_progress"
              ? this.theme.fg("accent", this.theme.bold(label))
              : blockers.length > 0
                ? this.theme.fg("dim", label)
                : selected
                  ? this.theme.fg("text", label)
                  : this.theme.fg("muted", label);
        lines.push(truncateToWidth(`${pointer} ${icon} ${styled}`, width));
      }

      if (end < tasks.length) {
        lines.push(
          truncateToWidth(
            ` ${this.theme.fg("dim", `↓ ${tasks.length - end} more`)}`,
            width,
          ),
        );
      }
    }

    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
    lines.push(
      truncateToWidth(
        ` ${this.theme.fg("dim", "↑↓ navigate · esc close")}`,
        width,
      ),
    );
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function renderTaskUpdate(result: TaskUpdateResult): string {
  if (!result.success)
    return result.error || `Task #${result.taskId} not found`;
  return `Updated task #${result.taskId} ${result.updatedFields.join(", ")}`;
}

export default function taskProgress(pi: ExtensionAPI) {
  let state = emptyTaskState();

  function restore(ctx: ExtensionContext): void {
    state = emptyTaskState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult")
        continue;
      if (
        entry.message.toolName !== CREATE_TOOL &&
        entry.message.toolName !== UPDATE_TOOL
      )
        continue;
      // Validation, policy, cancellation, and execution failures never mutated
      // task state, so they cannot supersede the latest successful snapshot.
      if (entry.message.isError) continue;
      const details = entry.message.details;
      const restored =
        details && typeof details === "object"
          ? normalizeTaskState(
              (details as Record<string, unknown>)[STATE_FIELD],
            )
          : undefined;
      // The latest task mutation is authoritative. A malformed snapshot must
      // fail closed instead of reviving older state from earlier in the branch.
      state = restored ?? emptyTaskState();
    }
  }

  function persistedDetails<T extends object>(
    details: T,
  ): T & Record<typeof STATE_FIELD, TaskState> {
    return Object.assign(details, { [STATE_FIELD]: cloneTaskState(state) });
  }

  function updateFooter(ctx: ExtensionContext): void {
    const lines = formatFooter(state.tasks).split("\n");
    const styled = lines.map((line, index) => {
      const indent = line.startsWith("  ") ? "  " : "";
      const content = line.slice(indent.length);
      if (index === 0 || content.startsWith(" …"))
        return ctx.ui.theme.fg("dim", line);

      const label = content.slice(2);
      if (content.startsWith("✔ "))
        return (
          indent +
          ctx.ui.theme.fg("success", "✔ ") +
          ctx.ui.theme.fg("dim", ctx.ui.theme.strikethrough(label))
        );
      if (content.startsWith("◼ "))
        return (
          indent +
          ctx.ui.theme.fg("accent", "◼ ") +
          ctx.ui.theme.fg("text", ctx.ui.theme.bold(label))
        );
      if (content.includes(" › blocked by "))
        return (
          indent + ctx.ui.theme.fg("text", "◻ ") + ctx.ui.theme.fg("dim", label)
        );
      return indent + ctx.ui.theme.fg("text", content);
    });
    ctx.ui.setStatus(STATUS_KEY, styled.join("\n"));
  }

  async function showTasks(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The task panel requires interactive mode", "error");
      return;
    }
    const snapshot = cloneTaskState(state);
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const heightBudget = Math.max(
          1,
          Math.floor(tui.terminal.rows * 0.9) - 6,
        );
        return new TaskListComponent(
          snapshot,
          theme,
          () => done(),
          () => tui.requestRender(),
          Math.min(DEFAULT_MAX_VISIBLE_TASKS, heightBudget),
        );
      },
      {
        overlay: true,
        overlayOptions: {
          width: "70%",
          maxHeight: "90%",
          anchor: "center",
          margin: 1,
        },
      },
    );
  }

  pi.registerTool({
    name: CREATE_TOOL,
    label: CREATE_TOOL,
    description: TASK_CREATE_PROMPT,
    parameters: TaskCreateParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const task = createTask(state, params);
      updateFooter(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Task #${task.id} created successfully: ${displayLabel(task.subject)}`,
          },
        ],
        details: persistedDetails({
          task: { id: task.id, subject: task.subject },
        }),
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("TaskCreate ")) +
          theme.fg("muted", displayLabel(args.subject)),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const content = result.content[0];
      return new Text(
        theme.fg("success", content?.type === "text" ? content.text : ""),
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof TaskGetParams, TaskGetDetails>({
    name: GET_TOOL,
    label: GET_TOOL,
    description: TASK_GET_PROMPT,
    parameters: TaskGetParams,
    async execute(_id, params) {
      const task = getTask(state, params.taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: "Task not found" }],
          details: { task: null },
        };
      }
      const blockers = openBlockers(state, task);
      const lines = [
        `Task #${task.id}: ${displayLabel(task.subject)}`,
        `Status: ${task.status}`,
        `Description: ${sanitizeTerminalText(task.description)}`,
      ];
      if (task.activeForm)
        lines.push(`Active label: ${displayLabel(task.activeForm)}`);
      if (task.owner) lines.push(`Owner: ${displayLabel(task.owner)}`);
      if (blockers.length > 0)
        lines.push(`Blocked by: ${blockers.map((id) => `#${id}`).join(", ")}`);
      if (task.blocks.length > 0)
        lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
      if (task.metadata)
        lines.push(
          `Metadata: ${sanitizeTerminalText(JSON.stringify(task.metadata))}`,
        );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          task: {
            id: task.id,
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm,
            status: task.status,
            owner: task.owner,
            blocks: task.blocks,
            blockedBy: blockers,
            metadata: task.metadata,
          },
        },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("TaskGet ")) +
          theme.fg("accent", `#${args.taskId}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: UPDATE_TOOL,
    label: UPDATE_TOOL,
    description: TASK_UPDATE_PROMPT,
    parameters: TaskUpdateParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const result = updateTask(state, params);
      updateFooter(ctx);
      return {
        content: [{ type: "text", text: renderTaskUpdate(result) }],
        details: persistedDetails(result),
      };
    },
    renderCall(args, theme) {
      const action = args.status ? ` → ${args.status}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("TaskUpdate ")) +
          theme.fg("accent", `#${args.taskId}`) +
          theme.fg("muted", action),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const content = result.content[0];
      return new Text(
        theme.fg("muted", content?.type === "text" ? content.text : ""),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: LIST_TOOL,
    label: LIST_TOOL,
    description: TASK_LIST_PROMPT,
    parameters: TaskListParams,
    async execute() {
      const completed = new Set(
        state.tasks
          .filter((task) => task.status === "completed")
          .map((task) => task.id),
      );
      const tasks = [...state.tasks].sort(numericTaskOrder).map((task) => ({
        id: task.id,
        subject: task.subject,
        status: task.status,
        owner: task.owner,
        blockedBy: task.blockedBy.filter((id) => !completed.has(id)),
      }));
      const text =
        tasks.length === 0
          ? "No tasks found"
          : tasks
              .map((task) => {
                const owner = task.owner
                  ? ` (${displayLabel(task.owner)})`
                  : "";
                const blocked =
                  task.blockedBy.length > 0
                    ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]`
                    : "";
                return `#${task.id} [${task.status}] ${displayLabel(task.subject)}${owner}${blocked}`;
              })
              .join("\n");
      return { content: [{ type: "text", text }], details: { tasks } };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("TaskList")), 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current session task list",
    handler: async (_args, ctx) => showTasks(ctx),
  });
  pi.registerShortcut(Key.ctrlAlt("t"), {
    description: "Show the current session task list",
    handler: async (ctx) => showTasks(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    updateFooter(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    updateFooter(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
