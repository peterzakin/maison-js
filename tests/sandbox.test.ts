/** Tests for sandbox module – unit tests and live integration tests. */

import { describe, it, expect, vi } from "vitest";
import { MaisonSandbox, StreamEvent } from "../src/sandbox.js";

// ---------------------------------------------------------------------------
// Unit tests – StreamEvent.content extraction
// ---------------------------------------------------------------------------

describe("StreamEvent.content", () => {
  it("extracts from content key", () => {
    const e = new StreamEvent("text", { content: "hello" });
    expect(e.content).toBe("hello");
  });

  it("extracts from text key", () => {
    const e = new StreamEvent("text", { text: "world" });
    expect(e.content).toBe("world");
  });

  it("extracts from result key", () => {
    const e = new StreamEvent("result", { result: "done" });
    expect(e.content).toBe("done");
  });

  it("extracts from nested message", () => {
    const e = new StreamEvent("text", {
      message: { content: "nested" },
    });
    expect(e.content).toBe("nested");
  });

  it("returns empty string when missing", () => {
    const e = new StreamEvent("unknown", { foo: "bar" });
    expect(e.content).toBe("");
  });

  it("prefers top-level over nested", () => {
    const e = new StreamEvent("text", {
      content: "top",
      message: { content: "nested" },
    });
    expect(e.content).toBe("top");
  });

  it("skips non-string values", () => {
    const e = new StreamEvent("text", { content: 42, text: "fallback" });
    expect(e.content).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// Helpers for mocking the Daytona sandbox filesystem + process
// ---------------------------------------------------------------------------

interface FakeSessionExecResponse {
  cmdId: string;
  exitCode: number | null;
  output: string;
}

class FakeFS {
  files: Record<string, string> = {};

  async downloadFile(path: string): Promise<Buffer> {
    if (!(path in this.files)) {
      throw new Error(`FileNotFoundError: ${path}`);
    }
    return Buffer.from(this.files[path], "utf-8");
  }
}

class FakeProcess {
  private _fs: FakeFS;
  private _outLines: string[];
  private _errText: string;
  private _exitCode: number;
  createdSessions: string[] = [];
  executedCommands: string[] = [];

  constructor(
    fs: FakeFS,
    outLines: string[],
    errText = "",
    exitCode = 0
  ) {
    this._fs = fs;
    this._outLines = outLines;
    this._errText = errText;
    this._exitCode = exitCode;
  }

  async createSession(sessionId: string): Promise<void> {
    this.createdSessions.push(sessionId);
  }

  async executeSessionCommand(
    _sessionId: string,
    req: { command: string; runAsync?: boolean }
  ): Promise<FakeSessionExecResponse> {
    this.executedCommands.push(req.command);

    // Pre-flight check
    if (req.command.includes("which claude")) {
      return {
        cmdId: "verify-cmd",
        exitCode: 0,
        output: "/usr/local/bin/claude\n",
      };
    }

    // For the actual claude command, write output files immediately.
    // The Python tests relied on asyncio.sleep(0) for interleaving,
    // but Node microtask scheduling differs, so we write synchronously
    // to keep the tests deterministic.
    this._writeOutputFiles(req.command);
    return { cmdId: "cmd-123", exitCode: null, output: "" };
  }

  private _writeOutputFiles(command: string): void {
    const outMatch = command.match(/> (\/tmp\/maison-\S+\.jsonl)/);
    const errMatch = command.match(/2> (\/tmp\/maison-\S+\.err)/);
    const doneMatch = command.match(/> (\/tmp\/maison-\S+\.done)/);
    if (!outMatch || !errMatch || !doneMatch) return;

    const outPath = outMatch[1];
    const errPath = errMatch[1];
    const donePath = doneMatch[1];

    let content = "";
    for (const line of this._outLines) {
      content += line;
      this._fs.files[outPath] = content;
    }

    this._fs.files[errPath] = this._errText;
    this._fs.files[donePath] = String(this._exitCode);
  }
}

function makeSandbox(
  outLines: string[],
  errText = "",
  exitCode = 0,
  extraSandboxProps: Record<string, unknown> = {}
): MaisonSandbox {
  const fs = new FakeFS();
  const process = new FakeProcess(fs, outLines, errText, exitCode);
  const fakeSandbox = { process, fs, ...extraSandboxProps } as any;
  const fakeDaytona = { delete: vi.fn() } as any;
  return new MaisonSandbox(fakeSandbox, fakeDaytona, "sk-test-key");
}

// Helper to collect all events from a stream
async function collectEvents(
  gen: AsyncGenerator<StreamEvent>
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Unit tests – file-polling stream()
// ---------------------------------------------------------------------------

describe("stream()", () => {
  it("yields parsed NDJSON events", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "Hello" }) + "\n",
      JSON.stringify({ type: "text", content: " world" }) + "\n",
      JSON.stringify({ type: "result", result: "done" }) + "\n",
    ];
    const sb = makeSandbox(lines);

    const events = await collectEvents(
      sb.stream("hi", { pollInterval: 0.01 })
    );

    const textEvents = events.filter((e) => e.type !== "stderr");
    expect(textEvents).toHaveLength(3);
    expect(textEvents[0].type).toBe("text");
    expect(textEvents[0].content).toBe("Hello");
    expect(textEvents[1].content).toBe(" world");
    expect(textEvents[2].type).toBe("result");
    expect(textEvents[2].content).toBe("done");
  });

  it("handles multiple lines in one chunk", async () => {
    const combined =
      JSON.stringify({ type: "text", content: "a" }) +
      "\n" +
      JSON.stringify({ type: "text", content: "b" }) +
      "\n";
    const sb = makeSandbox([combined]);

    const events = await collectEvents(
      sb.stream("hi", { pollInterval: 0.01 })
    );
    const textEvents = events.filter((e) => e.type !== "stderr");
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].content).toBe("a");
    expect(textEvents[1].content).toBe("b");
  });

  it("skips malformed JSON", async () => {
    const lines = [
      "this is not json\n",
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const sb = makeSandbox(lines);

    const events = await collectEvents(
      sb.stream("hi", { pollInterval: 0.01 })
    );
    const textEvents = events.filter((e) => e.type !== "stderr");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].content).toBe("ok");
  });

  it("surfaces stderr as events", async () => {
    const stdout = [
      JSON.stringify({ type: "text", content: "hi" }) + "\n",
    ];
    const sb = makeSandbox(stdout, "Error: something went wrong");

    const events = await collectEvents(
      sb.stream("hi", { pollInterval: 0.01 })
    );
    const stderrEvents = events.filter((e) => e.type === "stderr");
    expect(stderrEvents).toHaveLength(1);
    expect(stderrEvents[0].content).toContain("something went wrong");
  });

  it("completes with no output", async () => {
    const sb = makeSandbox([]);

    const events = await collectEvents(
      sb.stream("hi", { pollInterval: 0.01 })
    );
    const textEvents = events.filter((e) => e.type !== "stderr");
    expect(textEvents).toEqual([]);
  });

  it("raises RuntimeError when claude binary not found", async () => {
    const fs = new FakeFS();
    const process = new FakeProcess(fs, []);

    // Override executeSessionCommand to fail the which check
    const original = process.executeSessionCommand.bind(process);
    process.executeSessionCommand = async (sessionId, req) => {
      if (req.command.includes("which claude")) {
        return {
          cmdId: "verify-cmd",
          exitCode: 1,
          output: "not found",
        };
      }
      return original(sessionId, req);
    };

    const fakeSandbox = { process, fs } as any;
    const fakeDaytona = { delete: vi.fn() } as any;
    const sb = new MaisonSandbox(fakeSandbox, fakeDaytona, "sk-test-key");

    await expect(
      collectEvents(sb.stream("hi", { pollInterval: 0.01 }))
    ).rejects.toThrow("claude binary not found");
  });

  it("reuses session across calls", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const sb = makeSandbox(lines);

    // First call
    await collectEvents(sb.stream("first", { pollInterval: 0.01 }));
    const sessionId1 = (sb as any)._sessionId;

    // Reset fake output for second call
    (sb as any)._sandbox.process._outLines = [...lines];
    await collectEvents(
      sb.stream("second", {
        continueConversation: true,
        pollInterval: 0.01,
      })
    );
    const sessionId2 = (sb as any)._sessionId;

    expect(sessionId1).toBe(sessionId2);
    expect(sessionId1).not.toBeNull();
  });

  it("includes --continue flag when continueConversation is true", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const sb = makeSandbox(lines);

    // First call (no continue)
    await collectEvents(sb.stream("first", { pollInterval: 0.01 }));
    const cmd1 = (sb as any)._sandbox.process.executedCommands.at(-1) as string;
    expect(cmd1).not.toContain("--continue");

    // Second call with continue
    (sb as any)._sandbox.process._outLines = [...lines];
    await collectEvents(
      sb.stream("second", {
        continueConversation: true,
        pollInterval: 0.01,
      })
    );
    const cmd2 = (sb as any)._sandbox.process.executedCommands.at(-1) as string;
    expect(cmd2).toContain("--continue");
  });

  it("includes instructions via --append-system-prompt", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const sb = makeSandbox(lines);

    await collectEvents(
      sb.stream("hi", {
        instructions: "Be concise",
        pollInterval: 0.01,
      })
    );
    const cmd = (sb as any)._sandbox.process.executedCommands.at(-1) as string;
    expect(cmd).toContain("--append-system-prompt");
    expect(cmd).toContain("Be concise");
  });

  it("redirects to temp files in command", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const sb = makeSandbox(lines);

    await collectEvents(sb.stream("hi", { pollInterval: 0.01 }));
    const cmd = (sb as any)._sandbox.process.executedCommands.at(-1) as string;
    expect(cmd).toContain("> /tmp/maison-");
    expect(cmd).toContain("2> /tmp/maison-");
    expect(cmd).toContain("echo $? > /tmp/maison-");
  });

  it("includes port exposure instructions by default", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const sb = makeSandbox(lines, "", 0, {
      getPreviewLink: vi.fn(),
    });

    await collectEvents(sb.stream("hi", { pollInterval: 0.01 }));
    const cmd = (sb as any)._sandbox.process.executedCommands.at(-1) as string;
    expect(cmd).toContain("maison-exposed-ports");
    expect(cmd).toContain("--append-system-prompt");
  });

  it("omits port exposure instructions when exposePreviewUrls is false", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const sb = makeSandbox(lines);

    await collectEvents(
      sb.stream("hi", { pollInterval: 0.01, exposePreviewUrls: false })
    );
    const cmd = (sb as any)._sandbox.process.executedCommands.at(-1) as string;
    expect(cmd).not.toContain("maison-exposed-ports");
  });

  it("emits preview_url events for exposed ports", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const fs = new FakeFS();
    const process = new FakeProcess(fs, lines);

    // Pre-populate the exposed-ports file (simulating Claude writing it).
    fs.files["/tmp/maison-exposed-ports"] = "3000\n";

    const getPreviewLink = vi.fn().mockResolvedValue({
      sandboxId: "test-sandbox",
      url: "https://3000-test-sandbox.daytona.example.com",
      token: "tok",
    });

    const fakeSandbox = { process, fs, getPreviewLink } as any;
    const fakeDaytona = { delete: vi.fn() } as any;
    const sb = new MaisonSandbox(fakeSandbox, fakeDaytona, "sk-test-key");

    const events = await collectEvents(
      sb.stream("start a server", { pollInterval: 0.01 })
    );
    const previewEvents = events.filter((e) => e.type === "preview_url");

    expect(previewEvents).toHaveLength(1);
    expect(previewEvents[0].data.port).toBe(3000);
    expect(previewEvents[0].data.url).toBe(
      "https://3000-test-sandbox.daytona.example.com"
    );
    expect(getPreviewLink).toHaveBeenCalledWith(3000);
  });

  it("does not emit duplicate preview_url events for the same port", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const fs = new FakeFS();
    const process = new FakeProcess(fs, lines);

    // Same port listed multiple times.
    fs.files["/tmp/maison-exposed-ports"] = "3000\n3000\n";

    const getPreviewLink = vi.fn().mockResolvedValue({
      sandboxId: "test-sandbox",
      url: "https://3000-test-sandbox.daytona.example.com",
      token: "tok",
    });

    const fakeSandbox = { process, fs, getPreviewLink } as any;
    const fakeDaytona = { delete: vi.fn() } as any;
    const sb = new MaisonSandbox(fakeSandbox, fakeDaytona, "sk-test-key");

    const events = await collectEvents(
      sb.stream("start a server", { pollInterval: 0.01 })
    );
    const previewEvents = events.filter((e) => e.type === "preview_url");
    expect(previewEvents).toHaveLength(1);
  });

  it("emits preview_url events for multiple different ports", async () => {
    const lines = [
      JSON.stringify({ type: "text", content: "ok" }) + "\n",
    ];
    const fs = new FakeFS();
    const process = new FakeProcess(fs, lines);

    fs.files["/tmp/maison-exposed-ports"] = "3000\n8080\n";

    const getPreviewLink = vi.fn().mockImplementation(async (port: number) => ({
      sandboxId: "test-sandbox",
      url: `https://${port}-test-sandbox.daytona.example.com`,
      token: "tok",
    }));

    const fakeSandbox = { process, fs, getPreviewLink } as any;
    const fakeDaytona = { delete: vi.fn() } as any;
    const sb = new MaisonSandbox(fakeSandbox, fakeDaytona, "sk-test-key");

    const events = await collectEvents(
      sb.stream("start servers", { pollInterval: 0.01 })
    );
    const previewEvents = events.filter((e) => e.type === "preview_url");

    expect(previewEvents).toHaveLength(2);
    expect(previewEvents[0].data.port).toBe(3000);
    expect(previewEvents[1].data.port).toBe(8080);
  });
});

// ---------------------------------------------------------------------------
// Unit tests – getPreviewUrl()
// ---------------------------------------------------------------------------

describe("getPreviewUrl()", () => {
  it("returns the url string from getPreviewLink", async () => {
    const getPreviewLink = vi.fn().mockResolvedValue({
      sandboxId: "test-sandbox",
      url: "https://3000-test-sandbox.daytona.example.com",
      token: "tok",
    });

    const fakeSandbox = {
      process: { createSession: vi.fn(), executeSessionCommand: vi.fn() },
      fs: { downloadFile: vi.fn() },
      getPreviewLink,
    } as any;
    const fakeDaytona = { delete: vi.fn() } as any;
    const sb = new MaisonSandbox(fakeSandbox, fakeDaytona, "sk-test-key");

    const url = await sb.getPreviewUrl(3000);
    expect(url).toBe("https://3000-test-sandbox.daytona.example.com");
    expect(getPreviewLink).toHaveBeenCalledWith(3000);
  });
});

// ---------------------------------------------------------------------------
// Integration test – requires live Daytona + Anthropic credentials
// ---------------------------------------------------------------------------

const LIVE_TEST =
  process.env.ANTHROPIC_API_KEY && process.env.DAYTONA_API_KEY;

describe.skipIf(!LIVE_TEST)("live integration", () => {
  it("creates sandbox, streams, and receives events", async () => {
    const { Maison } = await import("../src/sandbox.js");

    const sandbox = await Maison.createSandboxForClaude();
    try {
      const events: StreamEvent[] = [];
      for await (const event of sandbox.stream("Say exactly: hello test")) {
        events.push(event);
        console.log(`[${event.type}] ${JSON.stringify(event.data)}`);
      }

      expect(events.length).toBeGreaterThan(0);

      const textEvents = events.filter((e) => e.type !== "stderr");
      const stderrEvents = events.filter((e) => e.type === "stderr");

      if (stderrEvents.length > 0) {
        const stderrText = stderrEvents.map((e) => e.content).join(" ");
        console.log(`stderr: ${stderrText}`);
      }

      const allContent = textEvents.map((e) => e.content).join("");
      expect(allContent.length).toBeGreaterThan(0);
      console.log(`\nClaude response: ${allContent}`);
    } finally {
      await sandbox.close();
    }
  }, 120_000);

  it("exposes preview URL for an HTTP server on port 3000", async () => {
    const { Maison } = await import("../src/sandbox.js");

    const sandbox = await Maison.createSandboxForClaude();
    try {
      const events: StreamEvent[] = [];
      const prompt =
        "Create a file called server.js with a simple Node.js HTTP server " +
        "that listens on port 3000 and responds with '<html><body>hello from sandbox</body></html>'. " +
        "Use only the built-in node:http module (no npm install needed). " +
        "Then start it in the background with `node server.js &` and " +
        "make sure to write port 3000 to the exposed ports file as instructed.";

      for await (const event of sandbox.stream(prompt, {
        pollInterval: 1,
      })) {
        events.push(event);
        console.log(`[${event.type}] ${JSON.stringify(event.data)}`);
      }

      // Verify a preview_url event was emitted for port 3000.
      const previewEvents = events.filter((e) => e.type === "preview_url");
      console.log(`\nPreview events: ${JSON.stringify(previewEvents.map((e) => e.data))}`);
      expect(previewEvents.length).toBeGreaterThan(0);

      const previewUrl = previewEvents.find(
        (e) => e.data.port === 3000
      );
      expect(previewUrl).toBeDefined();
      expect(previewUrl!.data.url).toBeTruthy();
      console.log(`\nPreview URL: ${previewUrl!.data.url}`);

      // Fetch the preview URL and verify we get HTML back.
      const url = previewUrl!.data.url as string;
      const response = await fetch(url);
      console.log(`\nFetch status: ${response.status}`);
      expect(response.ok).toBe(true);

      const body = await response.text();
      console.log(`\nResponse body length: ${body.length}`);
      expect(body.length).toBeGreaterThan(0);
      expect(body.toLowerCase()).toContain("html");
    } finally {
      await sandbox.close();
    }
  }, 300_000);
});
