import assert from "node:assert/strict";
import test from "node:test";
import { createWaitInterrupts } from "./src/wait-interrupt.ts";

test("a steering event interrupts every currently active wait", () => {
  const interrupts = createWaitInterrupts();
  const first = interrupts.open();
  const second = interrupts.open();

  interrupts.interrupt();

  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(interrupts.size(), 0);
});

test("a steering event does not poison later waits", () => {
  const interrupts = createWaitInterrupts();
  interrupts.interrupt();

  const later = interrupts.open();

  assert.equal(later.signal.aborted, false);
  later.dispose();
  assert.equal(interrupts.size(), 0);
});

test("disposing a wait unregisters it", () => {
  const interrupts = createWaitInterrupts();
  const wait = interrupts.open();
  wait.dispose();

  interrupts.interrupt();

  assert.equal(wait.signal.aborted, false);
});
