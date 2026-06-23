import {
  CodeBuildClient,
  StartBuildCommand,
  type EnvironmentVariable,
} from "@aws-sdk/client-codebuild";
import type { SNSEvent } from "aws-lambda";

const codebuild = new CodeBuildClient({});

/** Shape of a CloudWatch alarm notification delivered over SNS. */
interface CloudWatchAlarm {
  AlarmName?: string;
  AlarmDescription?: string;
  NewStateReason?: string;
  Region?: string;
  StateChangeTime?: string;
  Trigger?: {
    Namespace?: string;
    MetricName?: string;
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

export function buildOverrides(message: string): EnvironmentVariable[] {
  let alarm: CloudWatchAlarm = {};
  try {
    alarm = JSON.parse(message) as CloudWatchAlarm;
  } catch {
    // Not an alarm payload — treat the raw message as the trigger.
  }

  const trigger = alarm.AlarmName ?? "Manual incident";
  const logGroup = dimension(alarm, "LogGroup", "LogGroupName");
  const service = dimension(alarm, "ServiceName", "Service", "FunctionName");

  const env: EnvironmentVariable[] = [{ name: "TRIGGER", value: trigger }];
  if (logGroup) env.push({ name: "LOG_GROUPS", value: logGroup });
  if (service) env.push({ name: "SERVICE", value: service });
  if (alarm.StateChangeTime) {
    env.push({ name: "WINDOW_END", value: new Date(alarm.StateChangeTime).toISOString() });
  }
  env.push({ name: "RAW_PAYLOAD", value: message.slice(0, 4000) });
  return env;
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const projectName = process.env.PROJECT_NAME;
  if (!projectName) throw new Error("PROJECT_NAME env var is required");

  for (const record of event.Records) {
    const message = record.Sns.Message;
    const environmentVariablesOverride = buildOverrides(message);
    const trigger = environmentVariablesOverride.find((e) => e.name === "TRIGGER")?.value;
    console.log(`Dispatching Poirot for: ${trigger}`);

    const res = await codebuild.send(
      new StartBuildCommand({ projectName, environmentVariablesOverride }),
    );
    console.log(`Started build ${res.build?.id}`);
  }
};
