import { spawn } from "node:child_process";

export interface PiRunOptions {
  /** The full prompt (system instructions + case facts) handed to pi. */
  prompt: string;
  /** Working directory pi runs in. */
  cwd: string;
  /**
   * AWS profile pi's bash/AWS CLI calls should use. This is the read-only
   * investigator profile — scoped down so pi cannot mutate anything even if it
   * tries. The runner itself keeps the default credentials for its own work.
   */
  awsProfile: string;
  /** Extra env to layer on top of process.env for the pi child. */
  env?: NodeJS.ProcessEnv;
}

export interface PiRunResult {
  /** The agent's final assistant message — Poirot's report. */
  report: string;
  /** pi's process exit code. */
  exitCode: number;
}

/** Pull human-readable text out of a pi event's message payload, defensively. */
function extractText(event: Record<string, unknown>): string | undefined {
  // Common shape: { type: "message_end", message: { role, content: [...] } }
  const message = (event.message ?? event) as Record<string, unknown> | undefined;
  if (!message) return undefined;

  if (message.role && message.role !== "assistant") return undefined;

  const content = message.content ?? event.content ?? event.text;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (typeof b.text === "string") return b.text;
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("");
  }

  return undefined;
}

/**
 * Run pi headless in JSON event-stream mode and return the agent's final
 * message. Each stdout line is a JSON event; we tee raw lines to the build log
 * (so nothing is lost) and track the last assistant message as the report.
 */
export function runPi(opts: PiRunOptions): Promise<PiRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      ["--mode", "json", "--approve", opts.prompt],
      {
        cwd: opts.cwd,
        env: { ...process.env, AWS_PROFILE: opts.awsProfile, ...opts.env },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    let buffer = "";
    let lastAssistantText = "";

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
      // message_end carries a completed assistant turn; keep the latest one.
      if (type === "message_end" || type === "message" || type === "assistant_message") {
        const text = extractText(event);
        if (text && text.trim()) lastAssistantText = text.trim();
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
      resolve({ report: lastAssistantText, exitCode: code ?? 0 });
    });
  });
}
