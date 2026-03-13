#!/usr/bin/env node

/** Interactive CLI for running Claude Code in a Daytona sandbox. */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Maison, StreamEvent } from "./sandbox.js";

interface CliOptions {
  prompt?: string;
  instructions?: string;
  snapshot: string;
  debug: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: string;
}

function printContentBlock(block: ContentBlock): void {
  switch (block.type) {
    case "thinking":
      if (block.thinking) {
        process.stdout.write(`\n[thinking] ${block.thinking}\n`);
      }
      break;
    case "text":
      if (block.text) {
        process.stdout.write(block.text);
      }
      break;
    case "tool_use":
      process.stdout.write(
        `\n[tool_use] ${block.name ?? "unknown"}` +
          (block.input ? `: ${JSON.stringify(block.input)}` : "") +
          "\n"
      );
      break;
    case "tool_result": {
      const text = typeof block.content === "string" ? block.content : "";
      if (text) {
        process.stdout.write(`\n[tool_result] ${text.slice(0, 500)}\n`);
      }
      break;
    }
  }
}

function printEvent(event: StreamEvent, debug: boolean): void {
  if (debug) {
    process.stdout.write(
      `\n[DEBUG ${event.type}] ${JSON.stringify(event.data)}\n`
    );
  }
  if (event.type === "preview_url") {
    const { port, url } = event.data as { port: number; url: string };
    process.stdout.write(`\n[preview] Port ${port} → ${url}\n`);
    return;
  }
  if (event.type === "stderr") {
    process.stdout.write(`\n[stderr] ${event.content}\n`);
    return;
  }

  // Claude Code stream-json wraps content in assistant events with
  // message.content as an array of typed blocks.
  if (event.type === "assistant") {
    const msg = event.data.message as Record<string, unknown> | undefined;
    const blocks = msg?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks as ContentBlock[]) {
        printContentBlock(block);
      }
      return;
    }
  }

  // tool_result events appear at the top level too.
  if (event.type === "tool_result") {
    const output =
      (event.data.content as string) ??
      (event.data.output as string) ??
      "";
    if (output) {
      process.stdout.write(`\n[tool_result] ${output.slice(0, 500)}\n`);
    }
    return;
  }

  // Fallback: print any plain text content.
  const content = event.content;
  if (content) {
    process.stdout.write(content);
  }
}

async function run(opts: CliOptions): Promise<void> {
  process.stdout.write("Creating sandbox...\n");
  const sandbox = await Maison.createSandboxForClaude({
    snapshot: opts.snapshot,
  });
  process.stdout.write("Sandbox ready.\n\n");

  let isFirstMessage = true;
  try {
    // One-shot mode: run a single prompt and exit.
    if (opts.prompt) {
      for await (const event of sandbox.stream(opts.prompt, {
        instructions: opts.instructions,
      })) {
        printEvent(event, opts.debug);
      }
      process.stdout.write("\n");
      return;
    }

    // Interactive mode: read-eval-print loop.
    process.stdout.write(
      "Type a message to send to Claude. Type 'quit' to exit.\n\n"
    );

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        let userInput: string;
        try {
          userInput = (await rl.question("You: ")).trim();
        } catch {
          // EOF or Ctrl+C
          process.stdout.write("\n");
          break;
        }
        if (!userInput) continue;
        if (userInput.toLowerCase() === "quit") break;

        process.stdout.write("Claude: ");
        for await (const event of sandbox.stream(userInput, {
          instructions: opts.instructions,
          continueConversation: !isFirstMessage,
        })) {
          printEvent(event, opts.debug);
        }
        process.stdout.write("\n\n");
        isFirstMessage = false;
      }
    } finally {
      rl.close();
    }
  } finally {
    process.stdout.write("Deleting sandbox...\n");
    await sandbox.close();
    process.stdout.write("Done.\n");
  }
}

const program = new Command();
program
  .name("maison-cli")
  .description("Run Claude Code in a Daytona sandbox.")
  .option(
    "-p, --prompt <prompt>",
    "Run a single prompt and exit (non-interactive mode)."
  )
  .option(
    "--instructions <instructions>",
    "Custom instructions appended to Claude's system prompt."
  )
  .option(
    "--snapshot <snapshot>",
    "Daytona snapshot image.",
    "daytona-small"
  )
  .option("--debug", "Print raw event data for debugging.", false)
  .action(async (opts: CliOptions) => {
    try {
      await run(opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") {
        process.exit(130);
      }
      throw err;
    }
  });

program.parse();
