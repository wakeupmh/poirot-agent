import { spawn } from "node:child_process";

export interface ClaudeRunOptions {
  /** The case facts handed to Claude Code as the print-mode prompt. */
  userPrompt: string;
  /** Poirot's persona/method/rules, passed via --append-system-prompt. */
  systemPrompt: string;
  /** Working directory Claude Code runs in. */
  cwd: string;
  /**
   * AWS profile Claude Code's Bash/AWS CLI calls should use. This is the
   * read-only investigator profile — scoped down so Claude cannot mutate
   * anything even if it tries. The runner itself keeps the default credentials.
   */
  awsProfile: string;
  /** Cap on agent turns. */
  maxTurns: number;
  /** Optional model override; omit to use the account default. */
  model?: string;
}

export interface ClaudeRunResult {
  /** The agent's final result text — Poirot's report. */
  report: string;
  /** Claude Code's process exit code. */
  exitCode: number;
  /** Whether Claude Code reported the run itself as an error. */
  isError: boolean;
}

/** Pull human-readable text out of an assistant event's message, defensively. */
function extractAssistantText(event: Record<string, unknown>): string | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") return b.text;
      }
      return "";
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("") : undefined;
}

/**
 * Run Claude Code headless (`claude -p ... --output-format stream-json`) and
 * return the agent's final report. Auth comes from CLAUDE_CODE_OAUTH_TOKEN in
 * the environment, so usage is billed against the Claude subscription. Each
 * stdout line is a JSON event; we tee raw lines to the build log and prefer the
 * terminal `result` event, falling back to the last assistant message.
 */
export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      opts.userPrompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "Bash",
      "--max-turns",
      String(opts.maxTurns),
      "--append-system-prompt",
      opts.systemPrompt,
    ];
    if (opts.model) args.push("--model", opts.model);

    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: { ...process.env, AWS_PROFILE: opts.awsProfile },
      stdio: ["ignore", "pipe", "inherit"],
    });

    let buffer = "";
    let resultText = "";
    let lastAssistantText = "";
    let isError = false;

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Tee the raw event to the build log for full traceability.
      console.log(trimmed);

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // non-JSON noise; already logged above
      }

      const type = typeof event.type === "string" ? event.type : "";
      if (type === "assistant") {
        const text = extractAssistantText(event);
        if (text && text.trim()) lastAssistantText = text.trim();
      } else if (type === "result") {
        if (typeof event.result === "string") resultText = event.result.trim();
        if (event.is_error === true) isError = true;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      resolve({
        report: resultText || lastAssistantText,
        exitCode: code ?? 0,
        isError,
      });
    });
  });
}
