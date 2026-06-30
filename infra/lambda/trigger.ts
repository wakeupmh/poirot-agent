import {
  CodeBuildClient,
  StartBuildCommand,
  ListBuildsForProjectCommand,
  BatchGetBuildsCommand,
  type Build,
  type EnvironmentVariable,
} from "@aws-sdk/client-codebuild";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { SNSEvent } from "aws-lambda";

const codebuild = new CodeBuildClient({});

/**
 * Shape of the CloudWatch alarm notification delivered over SNS.
 * Only the fields Poirot actually uses are typed.
 */
interface CloudWatchAlarm {
  AlarmName?: string;
  AlarmDescription?: string;
  NewStateReason?: string;
  Region?: string;
  StateChangeTime?: string;
  Trigger?: {
    Namespace?: string;
    MetricName?: string;
    /** Seconds per evaluation period. */
    Period?: number;
    /** How many periods make up one evaluation. */
    EvaluationPeriods?: number;
    /** Periods that must breach to fire (>= EvaluationPeriods). */
    DatapointsToAlarm?: number;
    Dimensions?: Array<{ name: string; value: string }>;
  };
}

function dimension(alarm: CloudWatchAlarm, ...names: string[]): string | undefined {
  const dims = alarm.Trigger?.Dimensions ?? [];
  for (const name of names) {
    const hit = dims.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.value;
  }
  return undefined;
}

/** Default look-back window when the alarm does not carry one. */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Extract the investigation window from the alarm payload. CloudWatch exposes
 * Trigger.Period and Trigger.EvaluationPeriods on every alarm; using them keeps
 * Poirot's look-back tight (e.g. a 2-of-3 × 5-min alarm produces a 15-min
 * window instead of the old hardcoded 1h) and saves Claude turn budget.
 */
function windowFromAlarm(alarm: CloudWatchAlarm): { start?: string; end?: string } {
  const endTs = alarm.StateChangeTime ? Date.parse(alarm.StateChangeTime) : undefined;
  if (Number.isNaN(endTs)) return {};
  if (endTs === undefined) return {};
  let widthMs = DEFAULT_WINDOW_MS;
  const period = alarm.Trigger?.Period;
  const evaluationPeriods = alarm.Trigger?.EvaluationPeriods;
  if (period && evaluationPeriods && period > 0 && evaluationPeriods > 0) {
    widthMs = period * evaluationPeriods * 1000;
  }
  return {
    start: new Date(endTs - widthMs).toISOString(),
    end: new Date(endTs).toISOString(),
  };
}

export interface Overrides {
  envVars: EnvironmentVariable[];
  trigger: string;
  service?: string;
  metricName?: string;
  logGroup?: string;
  windowStart?: string;
  windowEnd?: string;
}

/**
 * Build the StartBuild environment-variables override from the SNS message.
 * The message is normally a JSON-encoded CloudWatch alarm notification; if it
 * is anything else we degrade gracefully and treat the raw text as a manual
 * trigger, so an operator can dispatch Poirot by publishing plain text to the
 * AlarmTopic.
 */
export function buildOverrides(message: string): Overrides {
  let alarm: CloudWatchAlarm = {};
  try {
    alarm = JSON.parse(message) as CloudWatchAlarm;
  } catch {
    // Not an alarm payload — treat the raw message as the trigger.
  }

  const trigger = alarm.AlarmName ?? "Manual incident";
  const service = dimension(alarm, "ServiceName", "Service", "FunctionName");
  const functionName = dimension(alarm, "FunctionName");
  const metricName = alarm.Trigger?.MetricName;
  const logGroup = dimension(alarm, "LogGroup", "LogGroupName")
    ?? (functionName ? `/aws/lambda/${functionName}` : undefined);
  const { start, end } = windowFromAlarm(alarm);

  const env: EnvironmentVariable[] = [{ name: "TRIGGER", value: trigger }];
  if (start) env.push({ name: "WINDOW_START", value: start });
  if (end) env.push({ name: "WINDOW_END", value: end });
  if (logGroup) env.push({ name: "LOG_GROUPS", value: logGroup });
  if (service) env.push({ name: "SERVICE", value: service });
  if (metricName) env.push({ name: "METRIC_NAME", value: metricName });
  env.push({ name: "RAW_PAYLOAD", value: message.slice(0, 4000) });

  return {
    envVars: env,
    trigger,
    service,
    metricName,
    logGroup,
    windowStart: start,
    windowEnd: end,
  };
}

const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CIRCUIT_BREAKER_MAX_PER_HOUR = 3;

export interface RecentBuild {
  startTime?: Date;
  envVars?: EnvironmentVariable[];
}

export type DedupDecision =
  | { kind: "dispatch" }
  | { kind: "suppressed-duplicate"; reason: string }
  | { kind: "circuit-open"; reason: string };

/**
 * Pure decision function over the recent CodeBuilds for this project: decide
 * whether to dispatch Poirot, suppress a near-duplicate, or open the circuit
 * breaker for a chronically firing service. Exported + pure so it is unit
 * tested without spawning CodeBuild.
 *
 * Dedup is keyed on (SERVICE, METRIC_NAME) — two distinct metric alarms for
 * the same service (Errors vs Throttles) are *not* treated as duplicates of
 * each other, since they are usually distinct investigations.
 */
export function decideDispatch(
  current: { service?: string; metricName?: string },
  recent: ReadonlyArray<RecentBuild>,
  now: number,
): DedupDecision {
  const { service, metricName } = current;
  if (!service) return { kind: "dispatch" };

  let hourCount = 0;
  let dedupHit = false;
  for (const b of recent) {
    const startedAt = b.startTime?.getTime();
    if (startedAt === undefined || startedAt > now) continue;
    const age = now - startedAt;
    if (age >= CIRCUIT_BREAKER_WINDOW_MS) continue;
    const envVars = b.envVars ?? [];
    const buildService = envVars.find((e) => e.name === "SERVICE")?.value;
    if (buildService !== service) continue;

    hourCount++;
    if (age < DEDUP_WINDOW_MS) {
      const buildMetric = envVars.find((e) => e.name === "METRIC_NAME")?.value;
      const sameMetric = metricName ? buildMetric === metricName : true;
      if (sameMetric) dedupHit = true;
    }
  }

  if (hourCount >= CIRCUIT_BREAKER_MAX_PER_HOUR) {
    return {
      kind: "circuit-open",
      reason: `SERVICE=${service} already investigated ${hourCount}× in the last hour`,
    };
  }
  if (dedupHit) {
    return {
      kind: "suppressed-duplicate",
      reason: `SERVICE=${service}${metricName ? ` METRIC_NAME=${metricName}` : ""}`,
    };
  }
  return { kind: "dispatch" };
}

/**
 * Pull the N most recent build records for this CodeBuild project so the
 * dispatcher can dedup and apply the circuit breaker against them. Returns
 * only the fields decideDispatch needs.
 */
async function recentBuilds(projectName: string, limit: number): Promise<RecentBuild[]> {
  const listRes = await codebuild.send(
    new ListBuildsForProjectCommand({ projectName, sortOrder: "DESCENDING" }),
  );
  const ids = (listRes.ids ?? []).slice(0, limit);
  if (ids.length === 0) return [];
  const batchRes = await codebuild.send(new BatchGetBuildsCommand({ ids }));
  return (batchRes.builds ?? []).map((b: Build) => ({
    startTime: b.startTime,
    envVars: b.environment?.environmentVariables ?? [],
  }));
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const projectName = process.env.PROJECT_NAME;
  if (!projectName) throw new Error("PROJECT_NAME env var is required");
  const reportTopicArn = process.env.REPORT_SNS_TOPIC_ARN?.trim();

  const sns = new SNSClient({});
  const notify = async (subject: string, message: string): Promise<void> => {
    if (!reportTopicArn) return;
    try {
      await sns.send(
        new PublishCommand({
          TopicArn: reportTopicArn,
          Subject: subject.slice(0, 100),
          Message: message,
        }),
      );
    } catch (err) {
      // A failed ack must never block a real dispatch.
      console.warn(`Ack to reports topic failed: ${(err as Error).message}`);
    }
  };

  for (const record of event.Records) {
    const overrides = buildOverrides(record.Sns.Message);

    let recent: RecentBuild[] = [];
    if (overrides.service) {
      try {
        recent = await recentBuilds(projectName, 30);
      } catch (err) {
        // If dedup can't run, we'd rather over-dispatch than miss a real alarm.
        console.warn(`Recent-builds lookup failed (proceeding with build): ${(err as Error).message}`);
      }
    }

    const decision = decideDispatch(overrides, recent, Date.now());

    if (decision.kind === "circuit-open") {
      console.log(`Circuit open — suppressing Poirot dispatch: ${decision.reason}`);
      await notify(
        "Poirot: circuit open",
        `Suppressing dispatch because ${decision.reason}. ` +
          `The alarm will Reaper for now; investigate the underlying service. ` +
          `Trigger: ${overrides.trigger}`,
      );
      continue;
    }
    if (decision.kind === "suppressed-duplicate") {
      console.log(`Suppressing duplicate Poirot dispatch: ${decision.reason}`);
      await notify(
        "Poirot: duplicate suppressed",
        `An alarm for ${decision.reason} duplicated a Poirot investigation ` +
          `started within the last ${DEDUP_WINDOW_MS / 60000} minutes — see that ` +
          `report instead. Trigger: ${overrides.trigger}`,
      );
      continue;
    }

    await notify(
      `Poirot investigating: ${overrides.trigger}`.slice(0, 100),
      `Poirot is investigating "${overrides.trigger}"` +
        (overrides.service ? ` (SERVICE=${overrides.service}${overrides.metricName ? ` ${overrides.metricName}` : ""})` : "") +
        " — a report will follow.",
    );
    console.log(`Dispatching Poirot for: ${overrides.trigger}`);
    const res = await codebuild.send(
      new StartBuildCommand({
        projectName,
        environmentVariablesOverride: overrides.envVars,
      }),
    );
    console.log(`Started build ${res.build?.id}`);
  }
};