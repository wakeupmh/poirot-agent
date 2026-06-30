import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOverrides,
  decideDispatch,
  type RecentBuild,
} from "../infra/lambda/trigger";
import { extractReportFromEvents, extractAssistantText } from "../src/claude";
import { sanitizeSubject } from "../src/investigate";

const envFor = (message: string): Record<string, string> =>
  Object.fromEntries(buildOverrides(message).envVars.map((e) => [e.name, e.value]));

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
  const env = envFor(alarm);
  assert.equal(env.TRIGGER, "checkout-5xx");
  assert.equal(env.SERVICE, "checkout-api");
  assert.equal(env.LOG_GROUPS, "/aws/lambda/checkout-api");
  assert.equal(env.WINDOW_END, "2026-06-23T14:02:00.000Z");
  // No Trigger.Period → fall back to 1h look-back.
  assert.equal(env.WINDOW_START, "2026-06-23T13:02:00.000Z");
  assert.ok(env.RAW_PAYLOAD.includes("checkout-5xx"));
});

test("buildOverrides: derives LOG_GROUPS from FunctionName when no LogGroup dimension", () => {
  const alarm = JSON.stringify({
    AlarmName: "payment-webhook-errors",
    Trigger: {
      Dimensions: [
        { name: "FunctionName", value: "joblee-payment-dev-pagarmeWebhook" },
      ],
    },
  });
  const env = envFor(alarm);
  assert.equal(env.SERVICE, "joblee-payment-dev-pagarmeWebhook");
  assert.equal(env.LOG_GROUPS, "/aws/lambda/joblee-payment-dev-pagarmeWebhook");
});

test("buildOverrides: computes WINDOW_START from Trigger.Period * EvaluationPeriods", () => {
  // 300s period × 3 evaluation periods = 900s = 15-min window.
  const alarm = JSON.stringify({
    AlarmName: "create-checkout-errors",
    StateChangeTime: "2026-06-29T12:00:00.000Z",
    Trigger: {
      MetricName: "Errors",
      Period: 300,
      EvaluationPeriods: 3,
      Dimensions: [{ name: "FunctionName", value: "payment-svc-createCheckout" }],
    },
  });
  const overrides = buildOverrides(alarm);
  assert.equal(overrides.windowStart, "2026-06-29T11:45:00.000Z");
  assert.equal(overrides.windowEnd, "2026-06-29T12:00:00.000Z");
  assert.equal(overrides.envVars.find((e) => e.name === "METRIC_NAME")?.value, "Errors");
});

test("buildOverrides: falls back to a manual trigger for non-JSON messages", () => {
  const env = envFor("just some text");
  assert.equal(env.TRIGGER, "Manual incident");
  assert.equal(env.SERVICE, undefined);
  assert.equal(env.LOG_GROUPS, undefined);
  assert.equal(env.RAW_PAYLOAD, "just some text");
});

test("buildOverrides: caps RAW_PAYLOAD at 4000 chars", () => {
  const big = "x".repeat(5000);
  const env = envFor(big);
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

// ---------------------------------------------------------------------------
// decideDispatch — dedup + circuit breaker
// ---------------------------------------------------------------------------

const makeBuild = (
  ageMinutes: number,
  now: number,
  service?: string,
  metricName?: string,
): RecentBuild => ({
  startTime: new Date(now - ageMinutes * 60_000),
  envVars: [
    ...(service ? [{ name: "SERVICE" as const, value: service }] : []),
    ...(metricName ? [{ name: "METRIC_NAME" as const, value: metricName }] : []),
  ],
});

test("decideDispatch: dispatches when no service is known", () => {
  const now = Date.now();
  assert.equal(decideDispatch({}, [], now).kind, "dispatch");
});

test("decideDispatch: dispatches when there are no recent builds", () => {
  const now = Date.now();
  const d = decideDispatch({ service: "foo", metricName: "Errors" }, [], now);
  assert.equal(d.kind, "dispatch");
});

test("decideDispatch: suppresses when same SERVICE + METRIC_NAME within dedup window", () => {
  const now = Date.now();
  const recent: RecentBuild[] = [makeBuild(3, now, "foo", "Errors")];
  const d = decideDispatch({ service: "foo", metricName: "Errors" }, recent, now);
  assert.equal(d.kind, "suppressed-duplicate");
});

test("decideDispatch: does NOT suppress when same SERVICE but different METRIC_NAME", () => {
  const now = Date.now();
  const recent: RecentBuild[] = [makeBuild(3, now, "foo", "Errors")];
  const d = decideDispatch({ service: "foo", metricName: "Throttles" }, recent, now);
  assert.equal(d.kind, "dispatch");
});

test("decideDispatch: suppresses on matching SERVICE when neither build nor alarm has METRIC_NAME", () => {
  const now = Date.now();
  const recent: RecentBuild[] = [makeBuild(4, now, "foo")];
  const d = decideDispatch({ service: "foo" }, recent, now);
  assert.equal(d.kind, "suppressed-duplicate");
});

test("decideDispatch: opens the circuit when >=3 builds for the same SERVICE in the last hour", () => {
  const now = Date.now();
  const recent: RecentBuild[] = [
    makeBuild(5, now, "foo", "Errors"),
    makeBuild(20, now, "foo", "Errors"),
    makeBuild(40, now, "foo", "Throttles"),
  ];
  const d = decideDispatch({ service: "foo", metricName: "Errors" }, recent, now);
  assert.equal(d.kind, "circuit-open");
});

test("decideDispatch: ignores builds older than 1 hour", () => {
  const now = Date.now();
  const recent: RecentBuild[] = [makeBuild(70, now, "foo", "Errors")];
  const d = decideDispatch({ service: "foo", metricName: "Errors" }, recent, now);
  assert.equal(d.kind, "dispatch");
});

test("decideDispatch: ignores same-window builds that are not for the same SERVICE", () => {
  const now = Date.now();
  const recent: RecentBuild[] = [makeBuild(3, now, "bar", "Errors")];
  const d = decideDispatch({ service: "foo", metricName: "Errors" }, recent, now);
  assert.equal(d.kind, "dispatch");
});

test("decideDispatch: dedup but not circuit when 1 build newer than dedup window but older builds also exist", () => {
  const now = Date.now();
  // One inside dedup window (dup), plus one outside (>10 min): circuit breaker
  // needs >=3 to open, so this is still only a suppressed-duplicate.
  const recent: RecentBuild[] = [
    makeBuild(3, now, "foo", "Errors"),
    makeBuild(20, now, "foo", "Errors"),
  ];
  const d = decideDispatch({ service: "foo", metricName: "Errors" }, recent, now);
  assert.equal(d.kind, "suppressed-duplicate");
});