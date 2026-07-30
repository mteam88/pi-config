import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  appendBoundedDiagnostic,
  parseCursorToolCall,
  resolveCursorSessionPath,
  updateCursorAssistantText,
  type CursorAssistantTextState,
} from "./src/backends/cursor.ts";

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

test("Cursor assistant dedupe resets at tool-call boundaries", () => {
  const state: CursorAssistantTextState = {
    answer: "",
    segmentAnswer: "",
  };
  const messages = [
    assistant("first "),
    assistant("segment"),
    assistant("first segment"),
    {
      type: "tool_call",
      subtype: "started",
      call_id: "call-1",
      tool_call: { shellToolCall: { args: { command: "true" } } },
    },
    {
      type: "tool_call",
      subtype: "completed",
      call_id: "call-1",
      tool_call: { shellToolCall: { result: { exitCode: 0 } } },
    },
    assistant("second "),
    assistant("segment"),
    assistant("second segment"),
  ];

  const liveDeltas = messages.flatMap((message) => {
    const delta = updateCursorAssistantText(state, message);
    return delta ? [delta] : [];
  });

  assert.deepEqual(liveDeltas, ["first ", "segment", "second ", "segment"]);
  assert.equal(liveDeltas.join(""), "first segmentsecond segment");
  assert.equal(state.answer, "first segmentsecond segment");
});

test("Cursor assistant accepts a full event without partial deltas", () => {
  const state: CursorAssistantTextState = {
    answer: "",
    segmentAnswer: "",
  };

  assert.equal(
    updateCursorAssistantText(state, assistant("one complete message")),
    "one complete message",
  );
  assert.equal(state.answer, "one complete message");
});

test("Cursor stderr diagnostics retain their head and tail within the bound", () => {
  const limit = 256;
  const reason = "Cannot use this model: unavailable-model\n";
  const tail = "\nAvailable models: model-a, model-b, model-c\n";
  const chunks = [reason, "x".repeat(2_000), tail];
  let diagnostic = "";

  for (const chunk of chunks)
    diagnostic = appendBoundedDiagnostic(diagnostic, chunk, limit);

  assert.ok(diagnostic.length <= limit);
  assert.ok(diagnostic.startsWith(reason));
  assert.ok(diagnostic.endsWith(tail));
  assert.match(diagnostic, /stderr truncated/);
});

test("Cursor tool parser supports wrapped success and failure results", () => {
  const started = parseCursorToolCall({
    type: "tool_call",
    subtype: "started",
    call_id: "read-1",
    tool_call: {
      tool: {
        case: "readToolCall",
        value: { args: { path: "/tmp/input.txt" } },
      },
    },
  });
  const succeeded = parseCursorToolCall({
    type: "tool_call",
    subtype: "completed",
    call_id: "read-1",
    tool_call: {
      tool: {
        case: "readToolCall",
        value: {
          result: {
            case: "success",
            value: { contents: "file contents" },
          },
        },
      },
    },
  });
  const failed = parseCursorToolCall({
    type: "tool_call",
    subtype: "completed",
    call_id: "read-2",
    tool_call: {
      tool: {
        case: "readToolCall",
        value: {
          result: {
            case: "permissionDenied",
            value: { path: "/root/secret" },
          },
        },
      },
    },
  });

  assert.equal(started.name, "read");
  assert.match(started.argsPreview ?? "", /input\.txt/);
  assert.equal(succeeded.isError, false);
  assert.match(succeeded.outputPreview ?? "", /file contents/);
  assert.equal(failed.isError, true);
  assert.match(failed.outputPreview ?? "", /permissionDenied/);
});

test("Cursor tool parser retains legacy flattened tool calls", () => {
  const tool = parseCursorToolCall({
    type: "tool_call",
    subtype: "completed",
    call_id: "shell-1",
    tool_call: {
      shellToolCall: {
        args: { command: "false" },
        result: { failure: { exitCode: 1 } },
      },
    },
  });

  assert.equal(tool.name, "shell");
  assert.match(tool.argsPreview ?? "", /false/);
  assert.equal(tool.isError, true);
  assert.match(tool.outputPreview ?? "", /exitCode/);
});

test("Cursor transcript resolution prefers the late project transcript", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-backend-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessionId = "session-123";
  const chatPath = path.join(home, ".cursor", "chats", "workspace", sessionId);
  fs.mkdirSync(chatPath, { recursive: true });

  assert.equal(resolveCursorSessionPath(sessionId, home), chatPath);

  const transcriptPath = path.join(
    home,
    ".cursor",
    "projects",
    "workspace",
    "agent-transcripts",
    sessionId,
    `${sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "");

  assert.equal(resolveCursorSessionPath(sessionId, home), transcriptPath);
});
