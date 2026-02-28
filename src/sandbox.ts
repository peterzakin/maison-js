import { Daytona } from "@daytonaio/sdk";
import type { Sandbox } from "@daytonaio/sdk";
import { randomUUID } from "node:crypto";

/**
 * Shell-quote a string for safe use in a shell command.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * A single event from Claude Code's stream-json output.
 */
export class StreamEvent {
  type: string;
  data: Record<string, unknown>;

  constructor(type: string, data: Record<string, unknown> = {}) {
    this.type = type;
    this.data = data;
  }

  /** Best-effort extraction of text content from the event. */
  get content(): string {
    for (const key of ["content", "text", "result"]) {
      const val = this.data[key];
      if (typeof val === "string") return val;
    }
    const msg = this.data["message"];
    if (msg && typeof msg === "object" && msg !== null) {
      const msgObj = msg as Record<string, unknown>;
      for (const key of ["content", "text"]) {
        const val = msgObj[key];
        if (typeof val === "string") return val;
      }
    }
    return "";
  }
}

export interface StreamOptions {
  /** Custom instructions appended to Claude Code's system prompt. */
  instructions?: string;
  /** Continue the most recent conversation so Claude retains prior context. */
  continueConversation?: boolean;
  /** Seconds between file polls for new output (default 0.3). */
  pollInterval?: number;
}

/**
 * A Daytona sandbox with Claude Code installed and ready to use.
 */
export class MaisonSandbox {
  private _sandbox: Sandbox;
  private _daytona: Daytona;
  private _anthropicApiKey: string;
  private _sessionId: string | null = null;
  private _claudeVerified = false;

  constructor(sandbox: Sandbox, daytona: Daytona, anthropicApiKey: string) {
    this._sandbox = sandbox;
    this._daytona = daytona;
    this._anthropicApiKey = anthropicApiKey;
  }

  /** Create a persistent session for running Claude Code commands. */
  private async _ensureSession(): Promise<string> {
    if (this._sessionId === null) {
      this._sessionId = `maison-${randomUUID().slice(0, 8)}`;
      await this._sandbox.process.createSession(this._sessionId);
    }
    return this._sessionId;
  }

  /** Read a text file from the sandbox filesystem. */
  private async _readSandboxFile(path: string): Promise<string> {
    const data: Buffer = await this._sandbox.fs.downloadFile(path);
    return data.toString("utf-8");
  }

  /** Check that the `claude` binary is accessible in the session. */
  private async _verifyClaudeAvailable(sessionId: string): Promise<void> {
    const resp = await this._sandbox.process.executeSessionCommand(sessionId, {
      command: "which claude",
      runAsync: false,
    });
    if (resp.exitCode !== 0) {
      throw new Error(
        `claude binary not found in session PATH. ` +
          `stdout=${JSON.stringify(resp.output)} stderr=${JSON.stringify(resp.output)}`
      );
    }
  }

  /**
   * Run Claude Code with the given prompt and yield events as they arrive.
   *
   * Thinking tokens, text deltas, tool-use events, and the final result
   * are all surfaced as StreamEvent instances.
   */
  async *stream(
    prompt: string,
    options: StreamOptions = {}
  ): AsyncGenerator<StreamEvent> {
    const {
      instructions,
      continueConversation = false,
      pollInterval = 0.3,
    } = options;

    const sessionId = await this._ensureSession();

    // On first call, verify claude is reachable inside the session.
    if (!this._claudeVerified) {
      await this._verifyClaudeAvailable(sessionId);
      this._claudeVerified = true;
    }

    const runId = randomUUID().slice(0, 8);
    const outFile = `/tmp/maison-${runId}.jsonl`;
    const errFile = `/tmp/maison-${runId}.err`;
    const doneFile = `/tmp/maison-${runId}.done`;

    const escapedPrompt = shellQuote(prompt);
    let optionalFlags = "";
    if (instructions) {
      optionalFlags += ` --append-system-prompt ${shellQuote(instructions)}`;
    }
    if (continueConversation) {
      optionalFlags += " --continue";
    }

    const cmd =
      `ANTHROPIC_API_KEY=${shellQuote(this._anthropicApiKey)} ` +
      `claude --dangerously-skip-permissions ` +
      `-p ${escapedPrompt} ` +
      `--output-format stream-json ` +
      `--verbose` +
      `${optionalFlags} ` +
      `< /dev/null ` +
      `> ${outFile} 2> ${errFile}; ` +
      `echo $? > ${doneFile}`;

    await this._sandbox.process.executeSessionCommand(sessionId, {
      command: cmd,
      runAsync: true,
    });

    // Poll the output file for new NDJSON lines.
    let offset = 0;
    let partialLine = "";

    while (true) {
      // Read current file contents.
      let content = "";
      try {
        content = await this._readSandboxFile(outFile);
      } catch {
        // File doesn't exist yet.
      }

      if (content.length > offset) {
        const newData = content.slice(offset);
        offset = content.length;

        let text = partialLine + newData;
        partialLine = "";

        while (text.includes("\n")) {
          const idx = text.indexOf("\n");
          const line = text.slice(0, idx);
          text = text.slice(idx + 1);
          const stripped = line.trim();
          if (stripped) {
            try {
              const raw = JSON.parse(stripped) as Record<string, unknown>;
              yield new StreamEvent(
                (raw.type as string) ?? "unknown",
                raw
              );
            } catch {
              // Skip malformed JSON lines.
            }
          }
        }

        // Keep any trailing incomplete line for next iteration.
        if (text) {
          partialLine = text;
        }
      }

      // Check if the command has finished.
      try {
        const doneContent = await this._readSandboxFile(doneFile);
        if (doneContent.trim()) {
          // Process any remaining partial line.
          if (partialLine.trim()) {
            try {
              const raw = JSON.parse(partialLine.trim()) as Record<
                string,
                unknown
              >;
              yield new StreamEvent(
                (raw.type as string) ?? "unknown",
                raw
              );
            } catch {
              // Skip malformed JSON.
            }
          }

          // Surface stderr if present.
          try {
            const errContent = await this._readSandboxFile(errFile);
            const errText = errContent.trim();
            if (errText) {
              yield new StreamEvent("stderr", {
                type: "stderr",
                content: errText,
              });
            }
          } catch {
            // No stderr file.
          }

          break;
        }
      } catch {
        // done_file doesn't exist yet.
      }

      await new Promise((resolve) =>
        setTimeout(resolve, pollInterval * 1000)
      );
    }
  }

  /** Read a file from the sandbox filesystem. */
  async readFile(path: string): Promise<string> {
    return this._readSandboxFile(path);
  }

  /** Delete the sandbox and release resources. */
  async close(): Promise<void> {
    await this._daytona.delete(this._sandbox);
  }
}

export interface CreateSandboxOptions {
  /** Anthropic API key for Claude. Falls back to ANTHROPIC_API_KEY env var. */
  anthropicApiKey?: string;
  /** Daytona sandbox snapshot image (default: "daytona-small"). */
  snapshot?: string;
  /** Optional human-readable sandbox name. */
  name?: string;
}

/**
 * Create sandboxed environments for running Claude Code safely.
 */
export class Maison {
  /**
   * Spin up a Daytona sandbox with Claude Code pre-installed.
   *
   * @throws {Error} If no Anthropic API key is available.
   * @throws {Error} If Claude Code installation fails.
   */
  static async createSandboxForClaude(
    options: CreateSandboxOptions = {}
  ): Promise<MaisonSandbox> {
    const {
      anthropicApiKey,
      snapshot = "daytona-small",
      name,
    } = options;

    const apiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      throw new Error(
        "An Anthropic API key is required. " +
          "Pass anthropicApiKey or set ANTHROPIC_API_KEY."
      );
    }

    const daytona = new Daytona();

    const params: Record<string, unknown> = { snapshot };
    if (name) params.name = name;

    const sandbox = await daytona.create(params);

    // Install Node.js if not already present.
    const nodeCheck = await sandbox.process.executeCommand("node --version");
    if (nodeCheck.exitCode !== 0) {
      const nodeInstall = await sandbox.process.executeCommand(
        "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - " +
          "&& apt-get install -y nodejs"
      );
      if (nodeInstall.exitCode !== 0) {
        await daytona.delete(sandbox);
        throw new Error(
          `Failed to install Node.js: ${nodeInstall.result}`
        );
      }
    }

    const result = await sandbox.process.executeCommand(
      "sudo chown -R $(whoami) $(npm prefix -g) " +
        "&& npm install -g @anthropic-ai/claude-code"
    );
    if (result.exitCode !== 0) {
      await daytona.delete(sandbox);
      throw new Error(
        `Failed to install Claude Code: ${result.result}`
      );
    }

    return new MaisonSandbox(sandbox, daytona, apiKey);
  }
}
