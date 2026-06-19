import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { contextFromEnv, buildUserPrompt, readSystemPrompt } from "./prompt";
import { runClaude } from "./claude";

/**
 * Find the repo root by walking up from this file until we see the marker file,
 * so it works whether we run via ts-node (src/) or compiled (dist/src/).
 */
function findRepoRoot(): string {
  let dir = __dirname;
  const root = parse(dir).root;
  while (dir !== root) {
    if (existsSync(join(dir, "system-prompt.md"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate repo root (system-prompt.md not found)");
}

const REPO_ROOT = findRepoRoot();

async function notify(topicArn: string, ctx: { trigger: string }, report: string): Promise<void> {
  const sns = new SNSClient({});
  const subject = `Poirot: ${ctx.trigger}`.slice(0, 100);
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: subject,
      Message: report,
    }),
  );
  console.log(`Published report to ${topicArn}`);
}

async function main(): Promise<void> {
  const ctx = contextFromEnv();
  // Investigator (read-only) profile Claude Code uses for its AWS CLI calls.
  // The runner itself keeps the default build-role credentials for SNS publish.
  const awsProfile = process.env.INVESTIGATOR_PROFILE?.trim() || "investigator";
  const maxTurns = Number(process.env.CLAUDE_MAX_TURNS) || 40;
  const model = process.env.CLAUDE_MODEL?.trim() || undefined;

  console.log(`===== Poirot is on the case: ${ctx.trigger} =====`);
  const systemPrompt = readSystemPrompt(REPO_ROOT);
  const userPrompt = buildUserPrompt(ctx);

  const { report, exitCode, isError } = await runClaude({
    userPrompt,
    systemPrompt,
    cwd: REPO_ROOT,
    awsProfile,
    maxTurns,
    model,
  });

  if (!report) {
    console.error(
      "❌ Claude Code produced no final report. Check the raw event stream above; " +
        `it exited with code ${exitCode}.`,
    );
    process.exitCode = exitCode || 1;
    return;
  }

  console.log("\n===== Poirot's report =====");
  console.log(report);
  console.log("===== End report =====");

  const topicArn = process.env.REPORT_SNS_TOPIC_ARN?.trim();
  if (topicArn) {
    try {
      await notify(topicArn, ctx, report);
    } catch (err) {
      // A failed notification should not fail the investigation itself.
      console.error(`⚠️  Failed to publish report to SNS: ${(err as Error).message}`);
    }
  }

  process.exitCode = isError ? 1 : exitCode;
}

main().catch((err) => {
  console.error(`❌ Investigation failed: ${(err as Error).stack ?? err}`);
  process.exitCode = 1;
});
