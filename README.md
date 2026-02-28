# Maison

Run [Claude Code](https://code.claude.com) with `--dangerously-skip-permissions` safely inside a [Daytona](https://www.daytona.io) sandbox.

## Install

```bash
npm install
npm run build
```

Requires Node.js 18 or later.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DAYTONA_API_KEY` | Yes | Your [Daytona API key](https://www.daytona.io/docs/en/getting-started/) (read by the Daytona SDK) |
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key (or pass it directly via `anthropicApiKey`) |

These variables are read by their respective SDKs, not by Maison directly. The Daytona SDK also supports optional `DAYTONA_API_URL` and `DAYTONA_TARGET` variables for custom deployments.

## CLI

After building, the `maison-cli` command is available. It spins up a Daytona sandbox, installs Claude Code, and connects you to it.

### Interactive mode

Run `maison-cli` with no arguments to start a multi-turn chat session. Claude retains context across messages, and the sandbox is automatically deleted when you type `quit` or press Ctrl+C.

```bash
npx maison-cli
```

### One-shot mode

Pass `-p` to run a single prompt and exit:

```bash
npx maison-cli -p "Write a hello world program in Python"
```

### Options

| Flag | Description |
|---|---|
| `-p`, `--prompt` | Run a single prompt and exit |
| `--instructions` | Custom instructions appended to Claude's system prompt |
| `--snapshot` | Daytona sandbox image (default: `daytona-small`) |
| `--debug` | Print raw event data for debugging |

## Quick start

Spin up a sandbox, give Claude a task, then iterate on it with multi-turn follow-ups — all inside an isolated environment where Claude has full permissions:

```typescript
import { Maison, StreamEvent } from "maison";

async function main() {
  // 1. Create an isolated sandbox with Claude Code installed
  const sandbox = await Maison.createSandboxForClaude();

  try {
    // 2. First turn — give Claude a task
    for await (const event of sandbox.stream(
      "Create a Python FastAPI app with a /health endpoint and a /items CRUD endpoint. " +
        "Include a requirements.txt.",
      { instructions: "Use type hints everywhere. Keep it production-ready." }
    )) {
      if (event.type === "text") {
        process.stdout.write(event.content);
      }
    }
    console.log();

    // 3. Follow-up turns — Claude remembers everything from above
    for await (const event of sandbox.stream(
      "Add pytest tests for both endpoints and make sure they pass.",
      { continueConversation: true }
    )) {
      if (event.type === "text") {
        process.stdout.write(event.content);
      }
    }
    console.log();

    // 4. Pull files out of the sandbox
    const appCode = await sandbox.readFile("/home/daytona/main.py");
    console.log(appCode);
  } finally {
    // 5. Clean up — deletes the sandbox
    await sandbox.close();
  }
}

main();
```

Each `stream()` call yields `StreamEvent` objects in real time. Set `continueConversation: true` on follow-up turns so Claude retains the full context from earlier messages.

## API

### `Maison.createSandboxForClaude(options?) -> Promise<MaisonSandbox>`

Creates a Daytona sandbox and installs Claude Code.

| Parameter | Default | Description |
|---|---|---|
| `anthropicApiKey` | `$ANTHROPIC_API_KEY` | Anthropic API key |
| `snapshot` | `"daytona-small"` | Daytona snapshot image |
| `name` | `undefined` | Optional sandbox name |

**Throws:** `Error` if no Anthropic API key is provided or found in `$ANTHROPIC_API_KEY`. `Error` if Node.js or Claude Code installation fails in the sandbox.

### `MaisonSandbox.stream(prompt, options?) -> AsyncGenerator<StreamEvent>`

Runs Claude Code with the given prompt and yields `StreamEvent` objects as they arrive. Includes thinking tokens, text deltas, tool use, and the final result.

| Parameter | Default | Description |
|---|---|---|
| `prompt` | *(required)* | The task or question for Claude Code |
| `options.instructions` | `undefined` | Custom instructions appended to Claude Code's system prompt |
| `options.continueConversation` | `false` | Continue the most recent conversation so Claude retains prior context |
| `options.pollInterval` | `0.3` | Seconds between file polls for new output |

**Throws:** `Error` if the `claude` binary is not found in the sandbox (checked on first call).

### `MaisonSandbox.readFile(path) -> Promise<string>`

Reads a file from the sandbox filesystem.

### `MaisonSandbox.close() -> Promise<void>`

Deletes the sandbox and frees resources.

### `StreamEvent`

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Event type: `"thinking"`, `"text"`, `"tool_use"`, `"result"`, or `"stderr"` |
| `data` | `Record<string, unknown>` | Raw JSON event from Claude Code |
| `content` | `string` | Convenience getter that extracts text content |

A `"stderr"` event is emitted at the end of a `stream()` call if Claude Code wrote anything to stderr.

## Multi-turn conversations

Use `continueConversation: true` to send follow-up messages that retain full context from earlier turns:

```typescript
const sandbox = await Maison.createSandboxForClaude();

// First message — starts a new conversation
for await (const event of sandbox.stream("Create a Python Flask app with a /health endpoint")) {
  if (event.type === "text") {
    process.stdout.write(event.content);
  }
}

// Second message — continues the same conversation
for await (const event of sandbox.stream(
  "Now add a /users endpoint with GET and POST",
  { continueConversation: true }
)) {
  if (event.type === "text") {
    process.stdout.write(event.content);
  }
}
```

See [`examples/multi_turn.ts`](examples/multi_turn.ts) for a complete interactive chat loop.

## How it works

1. `createSandboxForClaude()` spins up an isolated Daytona sandbox, installs Node.js (if needed), and installs Claude Code globally via npm.
2. `stream()` creates a persistent Daytona session (reused across calls for multi-turn) and runs `claude --dangerously-skip-permissions -p <prompt> --output-format stream-json --verbose` with output redirected to temporary files.
3. Maison polls the output file for new NDJSON lines at a configurable interval (default 0.3 s), parsing each line into a `StreamEvent`. A completion marker file signals the end of the stream.
4. Because Claude runs inside the sandbox, it has full permissions without risking your host machine.

## License

MIT
