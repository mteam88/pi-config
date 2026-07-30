import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_DELIVERY_OPTIONS,
  deliverSettledResult,
} from "./src/result-delivery.ts";

test("completion messages use steering delivery and wake an idle parent", () => {
  assert.deepEqual(COMPLETION_DELIVERY_OPTIONS, {
    deliverAs: "steer",
    triggerTurn: true,
  });
});

test("an unconsumed result is delivered immediately", () => {
  const delivered: string[] = [];

  const didDeliver = deliverSettledResult("sa-1", false, (id) =>
    delivered.push(id),
  );

  assert.equal(didDeliver, true);
  assert.deepEqual(delivered, ["sa-1"]);
});

test("a result consumed by an active wait is not delivered", () => {
  const delivered: string[] = [];

  const didDeliver = deliverSettledResult("sa-1", true, (id) =>
    delivered.push(id),
  );

  assert.equal(didDeliver, false);
  assert.deepEqual(delivered, []);
});
