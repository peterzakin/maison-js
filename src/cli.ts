#!/usr/bin/env node

/** Interactive CLI for running Claude Code in a Daytona sandbox. */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { Maison, StreamEvent } from "./sandbox.js";

interface CliOptions {
  prompt?: string;
  instructions?: string;
  snapshot: string;
  debug: boolean;
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
    stderr.write(`\n[stderr] ${event.content}\n`);
    return;
  }
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
