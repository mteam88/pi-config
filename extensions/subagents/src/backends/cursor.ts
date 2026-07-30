import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

type Json = Record<string, unknown>;

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const preview = (value: unknown) => {
  try {
    return JSON.stringify(value)?.slice(0, 1024);
  } catch {
    return undefined;
  }
};
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4096);

export const CURSOR_DIAGNOSTIC_LIMIT = 4096;
const DIAGNOSTIC_TRUNCATION_MARKER = "\n... stderr truncated ...\n";

export const appendBoundedDiagnostic = (
  current: string,
  chunk: string,
  limit = CURSOR_DIAGNOSTIC_LIMIT,
) => {
  const combined = current + chunk;
  if (combined.length <= limit) return combined;
  if (limit <= DIAGNOSTIC_TRUNCATION_MARKER.length)
    return combined.slice(0, limit);
  const contentLimit = limit - DIAGNOSTIC_TRUNCATION_MARKER.length;
  const headLength = Math.ceil(contentLimit / 2);
  const tailLength = contentLimit - headLength;
  return (
    combined.slice(0, headLength) +
    DIAGNOSTIC_TRUNCATION_MARKER +
    combined.slice(-tailLength)
  );
};

export type CursorAssistantTextState = {
  answer: string;
  segmentAnswer: string;
};

export const updateCursorAssistantText = (
  state: CursorAssistantTextState,
  message: Json,
) => {
  const type = text(message.type);
  if (type === "tool_call") {
    state.segmentAnswer = "";
    return;
  }
  if (type !== "assistant") return;

  const content = record(message.message)?.content;
  const chunk = Array.isArray(content)
    ? content
        .map(record)
        .filter((part) => part?.type === "text")
        .map((part) => text(part?.text) ?? "")
        .join("")
    : "";
  if (!chunk || chunk === state.segmentAnswer) return;

  const delta = chunk.startsWith(state.segmentAnswer)
    ? chunk.slice(state.segmentAnswer.length)
    : chunk;
  state.segmentAnswer += delta;
  state.answer += delta;
  return delta || undefined;
};

const cursorToolName = (value: string) => value.replace(/ToolCall$/, "");
const ERROR_TOOL_RESULT_CASES = new Set([
  "failure",
  "rejected",
  "permissionDenied",
  "spawnError",
]);
const SUCCESS_TOOL_RESULT_CASES = new Set(["success"]);

export const parseCursorToolCall = (message: Json) => {
  const call = record(message.tool_call);
  const wrapped = record(call?.tool);
  const wrappedCase = text(wrapped?.case);
  const legacyEntry = Object.entries(call ?? {}).find(([key]) =>
    key.endsWith("ToolCall"),
  );
  const detail = wrappedCase
    ? record(wrapped?.value)
    : record(legacyEntry?.[1]);
  const result = detail?.result;
  const resultRecord = record(result);
  const resultCase =
    text(resultRecord?.case) ??
    Object.keys(resultRecord ?? {}).find(
      (key) =>
        SUCCESS_TOOL_RESULT_CASES.has(key) || ERROR_TOOL_RESULT_CASES.has(key),
    );
  const subtype = text(message.subtype);
  const isError = resultCase
    ? ERROR_TOOL_RESULT_CASES.has(resultCase)
      ? true
      : SUCCESS_TOOL_RESULT_CASES.has(resultCase)
        ? false
        : subtype !== "completed"
    : subtype !== "completed";

  return {
    id: text(message.call_id) ?? "cursor-tool",
    name: cursorToolName(wrappedCase ?? legacyEntry?.[0] ?? "tool"),
    argsPreview: preview(detail?.args),
    outputPreview: preview(result),
    isError,
  };
};

export const resolveCursorSessionPath = (
  sessionId: string,
  homeDirectory = os.homedir(),
) => {
  const projectsRoot = path.join(homeDirectory, ".cursor", "projects");
  try {
    for (const workspace of fs.readdirSync(projectsRoot)) {
      const candidate = path.join(
        projectsRoot,
        workspace,
        "agent-transcripts",
        sessionId,
        `${sessionId}.jsonl`,
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}

  const chatsRoot = path.join(homeDirectory, ".cursor", "chats");
  try {
    for (const workspace of fs.readdirSync(chatsRoot)) {
      const candidate = path.join(chatsRoot, workspace, sessionId);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
};

let binary: string | undefined;
const cursorBinary = () => {
  if (binary) return binary;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, "agent");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return (binary = candidate);
    } catch {}
  }
};

const stop = (child: ChildProcessWithoutNullStreams) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    try {
      process.platform === "win32" || !child.pid
        ? child.kill("SIGTERM")
        : process.kill(-child.pid, "SIGTERM");
    } catch {
      resolve();
    }
  });

const makeCursorSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const agent = cursorBinary();
    if (!agent)
      return yield* new SpawnError({ message: "Cursor agent was not found." });

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);
    const state = {
      closed: false,
      active: false,
      interrupted: false,
      serial: 0,
      child: undefined as ChildProcessWithoutNullStreams | undefined,
      answer: "",
      segmentAnswer: "",
      thinking: "",
      stderr: "",
      meta: {
        ...task.resume,
        backend: "cursor",
        modelLabel: task.model ?? task.resume?.modelLabel ?? "auto",
      } satisfies SubagentMeta as SubagentMeta,
    };

    const settle = (serial: number, outcome: RunOutcome) => {
      if (!state.active || serial !== state.serial) return;
      state.active = false;
      state.child = undefined;
      emit({ _tag: "RunSettled", outcome });
    };

    const refreshSessionMeta = (sessionId: string) => {
      const sessionFilePath = resolveCursorSessionPath(sessionId);
      if (
        sessionId === state.meta.nativeSessionId &&
        sessionFilePath === state.meta.sessionFilePath
      )
        return;
      state.meta = {
        ...state.meta,
        nativeSessionId: sessionId,
        sessionFilePath,
      };
      emit({ _tag: "MetaChanged", meta: state.meta });
    };

    const start = (prompt: string) => {
      const serial = ++state.serial;
      state.active = true;
      state.interrupted = false;
      state.answer = "";
      state.segmentAnswer = "";
      state.thinking = "";
      state.stderr = "";
      emit({ _tag: "UserMessage", text: prompt });
      emit({ _tag: "RunStarted" });
      const args = [
        "--print",
        "--force",
        "--trust",
        "--workspace",
        task.cwd,
        "--model",
        task.model ?? "auto",
        "--stream-partial-output",
        "--output-format",
        "stream-json",
        ...(state.meta.nativeSessionId
          ? ["--resume", state.meta.nativeSessionId]
          : []),
        prompt,
      ];
      const child = spawn(agent, args, {
        cwd: task.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      state.child = child;

      const handle = (line: string) => {
        let message: Json | undefined;
        try {
          message = record(JSON.parse(line));
        } catch {
          return;
        }
        const type = text(message?.type);
        const subtype = text(message?.subtype);
        const assistantDelta = message
          ? updateCursorAssistantText(state, message)
          : undefined;
        const sessionId = text(message?.session_id);
        if (sessionId && sessionId !== state.meta.nativeSessionId)
          refreshSessionMeta(sessionId);
        if (type === "result" && state.meta.nativeSessionId)
          refreshSessionMeta(state.meta.nativeSessionId);
        if (type === "system") {
          const modelLabel = text(message?.model);
          if (modelLabel) {
            state.meta = { ...state.meta, modelLabel };
            emit({ _tag: "MetaChanged", meta: state.meta });
          }
        } else if (type === "thinking" && subtype === "delta") {
          const delta = text(message?.text) ?? "";
          state.thinking += delta;
          if (delta) emit({ _tag: "AssistantDelta", kind: "thinking", delta });
        } else if (type === "assistant") {
          if (assistantDelta)
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: assistantDelta,
            });
        } else if (type === "tool_call") {
          const tool = parseCursorToolCall(message ?? {});
          if (subtype === "started") {
            emit({
              _tag: "ToolStart",
              toolId: tool.id,
              name: tool.name,
              argsPreview: tool.argsPreview,
            });
          } else {
            emit({
              _tag: "ToolEnd",
              toolId: tool.id,
              name: tool.name,
              isError: tool.isError,
              outputPreview: tool.outputPreview,
            });
          }
        } else if (type === "result") {
          const usage = record(message?.usage);
          // Aggregate tokens consumed; Cursor does not expose reliable occupancy.
          const tokens = [
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
          ]
            .map((key) => usage?.[key])
            .filter((value): value is number => typeof value === "number")
            .reduce((sum, value) => sum + value, 0);
          if (tokens) emit({ _tag: "UsageChanged", tokens });
          const result = text(message?.result) ?? state.answer;
          const parts: TranscriptPart[] = [
            ...(state.thinking
              ? [{ type: "thinking" as const, text: state.thinking }]
              : []),
            ...(result ? [{ type: "text" as const, text: result }] : []),
          ];
          if (parts.length) emit({ _tag: "AssistantMessage", parts });
          settle(
            serial,
            state.interrupted
              ? { _tag: "Interrupted", partialText: result || undefined }
              : subtype === "success" && message?.is_error !== true
                ? { _tag: "Completed", finalText: result }
                : {
                    _tag: "Failed",
                    errorText: result || state.stderr || "Cursor run failed",
                    partialText: state.answer || undefined,
                  },
          );
        }
      };

      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handle(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        state.stderr = appendBoundedDiagnostic(state.stderr, chunk);
      });
      child.once("error", (error) =>
        settle(serial, { _tag: "Failed", errorText: errorText(error) }),
      );
      child.once("exit", (code, signal) => {
        if (buffer.trim()) handle(buffer);
        if (state.active && serial === state.serial)
          settle(
            serial,
            state.interrupted
              ? {
                  _tag: "Interrupted",
                  partialText: state.answer || undefined,
                }
              : {
                  _tag: "Failed",
                  errorText:
                    state.stderr ||
                    `Cursor exited (${signal ?? `code ${code ?? "unknown"}`})`,
                  partialText: state.answer || undefined,
                },
          );
      });
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (state.active) {
          state.interrupted = true;
          if (state.child) await stop(state.child);
          settle(state.serial, {
            _tag: "Interrupted",
            partialText: state.answer || undefined,
          });
        }
        state.closed = true;
        Queue.endUnsafe(events);
      }),
    );

    emit({ _tag: "MetaChanged", meta: state.meta });
    start(task.prompt);
    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (message) =>
        Effect.suspend(() => {
          if (state.closed)
            return new SendError({ message: "Cursor session is closed." });
          if (state.active)
            return new SendError({
              message: "Cursor does not support steering an active run.",
            });
          return Effect.sync(() => start(message));
        }),
      interrupt: Effect.promise(async () => {
        if (!state.active || !state.child) return;
        state.interrupted = true;
        await stop(state.child);
      }),
    } satisfies SubagentSession;
  });

export const cursorBackend: SubagentBackend = {
  name: "cursor",
  capabilities: {
    steering: false,
    modelSelection: true,
    reasoningEffort: false,
  },
  available: Effect.sync(() => cursorBinary() !== undefined),
  spawn: makeCursorSession,
};
