import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvestigationContext } from "./types";

/** Read the investigation context from the process environment. */
export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): InvestigationContext {
  const trigger = env.TRIGGER?.trim();
  if (!trigger) {
    throw new Error(
      "TRIGGER is required (the alarm name or incident title). " +
        "Pass it via CodeBuild environment-variables-override.",
    );
  }

  const windowEnd = env.WINDOW_END?.trim() || new Date().toISOString();
  const windowStart =
    env.WINDOW_START?.trim() ||
    new Date(new Date(windowEnd).getTime() - 60 * 60 * 1000).toISOString();

  const logGroups = (env.LOG_GROUPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    trigger,
    region: env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "us-east-1",
    logGroups,
    service: env.SERVICE?.trim() || undefined,
    windowStart,
    windowEnd,
    rawPayload: env.RAW_PAYLOAD?.trim() || undefined,
  };
}

/** Poirot's persona, method, and rules — passed to Claude Code as the system prompt. */
export function readSystemPrompt(repoRoot: string): string {
  return readFileSync(join(repoRoot, "system-prompt.md"), "utf8").trim();
}

/** Build the case facts handed to Claude Code as the print-mode prompt. */
export function buildUserPrompt(ctx: InvestigationContext): string {
  const logGroupsLine =
    ctx.logGroups.length > 0
      ? ctx.logGroups.map((g) => `  - ${g}`).join("\n")
      : "  (none supplied — discover the relevant log groups with `aws logs describe-log-groups`)";

  const facts = [
    "# The case",
    "",
    `Trigger: ${ctx.trigger}`,
    `Region (start here): ${ctx.region}`,
    `Service: ${ctx.service ?? "(unknown — determine it from the evidence)"}`,
    `Window of interest: ${ctx.windowStart} → ${ctx.windowEnd}`,
    "Candidate log groups:",
    logGroupsLine,
  ];

  if (ctx.rawPayload) {
    facts.push("", "Raw alarm / incident payload:", "```json", ctx.rawPayload, "```");
  }

  facts.push(
    "",
    "Investigate using the AWS CLI (read-only). Begin now and finish with your report.",
  );

  return `${facts.join("\n")}\n`;
}
