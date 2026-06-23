import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOverrides } from "../infra/lambda/trigger";
import { extractReportFromEvents, extractAssistantText } from "../src/claude";
import { sanitizeSubject } from "../src/investigate";

test("buildOverrides: maps a CloudWatch alarm payload to env overrides", () => {
  const alarm = JSON.stringify({
    AlarmName: "checkout-5xx",
    StateChangeTime: "2026-06-23T14:02:00.000Z",
    Trigger: {
      Dimensions: [
        { name: "FunctionName", value: "checkout-api" },
        { name: "LogGroupName", value: "/aws/lambda/checkout-api" },
      ],
    },
  });
  const env = Object.fromEntries(buildOverrides(alarm).map((e) => [e.name, e.value]));
  assert.equal(env.TRIGGER, "checkout-5xx");
  assert.equal(env.SERVICE, "checkout-api");
  assert.equal(env.LOG_GROUPS, "/aws/lambda/checkout-api");
  assert.equal(env.WINDOW_END, "2026-06-23T14:02:00.000Z");
  assert.ok(env.RAW_PAYLOAD.includes("checkout-5xx"));
});

test("buildOverrides: falls back to a manual trigger for non-JSON messages", () => {
  const env = Object.fromEntries(buildOverrides("just some text").map((e) => [e.name, e.value]));
  assert.equal(env.TRIGGER, "Manual incident");
  assert.equal(env.SERVICE, undefined);
  assert.equal(env.LOG_GROUPS, undefined);
  assert.equal(env.RAW_PAYLOAD, "just some text");
});

test("buildOverrides: caps RAW_PAYLOAD at 4000 chars", () => {
  const big = "x".repeat(5000);
  const env = Object.fromEntries(buildOverrides(big).map((e) => [e.name, e.value]));
  assert.equal(env.RAW_PAYLOAD.length, 4000);
});

test("extractReportFromEvents: prefers the terminal result event", () => {
  const { report, isError } = extractReportFromEvents([
    { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
    { type: "result", subtype: "success", is_error: false, result: "Final report." },
  ]);
  assert.equal(report, "Final report.");
  assert.equal(isError, false);
});

test("extractReportFromEvents: falls back to the last assistant text", () => {
  const { report } = extractReportFromEvents([
    { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "second" }] } },
  ]);
  assert.equal(report, "second");
});

test("extractReportFromEvents: surfaces is_error from the result event", () => {
  const { isError } = extractReportFromEvents([
    { type: "result", is_error: true, result: "" },
  ]);
  assert.equal(isError, true);
});

test("extractAssistantText: joins multiple text blocks, ignores non-text", () => {
  const text = extractAssistantText({
    message: { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] },
  });
  assert.equal(text, "ab");
});

test("sanitizeSubject: strips newlines/control chars and prefixes", () => {
  assert.equal(sanitizeSubject("checkout\n5xx\tspike"), "Poirot: checkout 5xx spike");
});

test("sanitizeSubject: clamps to 100 characters", () => {
  const subject = sanitizeSubject("x".repeat(200));
  assert.ok(subject.length <= 100);
});

test("sanitizeSubject: handles an empty trigger", () => {
  assert.equal(sanitizeSubject(""), "Poirot:");
});
