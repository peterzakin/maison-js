/**
 * Multi-turn conversation with Claude Code in a sandbox.
 *
 * Demonstrates how to build an app that collects user input and sends
 * multiple sequential messages to Claude, with Claude retaining full
 * context from earlier turns.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Maison, StreamEvent } from "../src/index.js";

async function main(): Promise<void> {
  const sandbox = await Maison.createSandboxForClaude();

  console.log("Connected to sandbox. Type your messages below.");
  console.log("Type 'quit' to exit.\n");

  const rl = createInterface({ input: stdin, output: stdout });
  let isFirstMessage = true;

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (await rl.question("You: ")).trim();
      } catch {
        break;
      }
      if (!userInput) continue;
      if (userInput.toLowerCase() === "quit") break;

      process.stdout.write("Claude: ");
      for await (const event of sandbox.stream(userInput, {
        // First message starts a new conversation;
        // subsequent messages continue it so Claude has full context.
        continueConversation: !isFirstMessage,
      })) {
        if (event.type === "text") {
          process.stdout.write(event.content);
        }
      }
      process.stdout.write("\n\n");

      isFirstMessage = false;
    }
  } finally {
    rl.close();
    await sandbox.close();
    console.log("Sandbox closed.");
  }
}

main();
