# OpenClaw Lark Plugin — Demo Server

A self-contained [Bun](https://bun.sh) HTTP server that loads the `@larksuite/openclaw-lark` channel plugin and wires it to a mock **Echo Bot** and an optional **A2A-backed plugin runtime**.

This demo shows how to:

1. **Load a channel plugin** outside the official OpenClaw runtime by providing a lightweight mock of `OpenClawPluginApi`
2. **Inspect registration results** — channels, tools, hooks and commands the plugin registered
3. **Simulate inbound messages** and get echo replies through a simple REST API
4. **Delegate sub-agent calls to a remote A2A agent** using the `a2a-plugin-runtime`

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- The parent plugin must be built first (`pnpm build` in the repo root)

## Quick Start

```bash
# 1. Build the parent plugin (from repo root)
pnpm install && pnpm build

# 2. Install demo dependencies
cd demo && pnpm install

# 3a. Start the server without A2A (echo bot only)
bun run server.ts

# 3b. Start with A2A runtime + bundled mock agent
MOCK_A2A_PORT=4000 bun run mock-a2a-agent.ts &
A2A_AGENT_URL=http://localhost:4000 bun run server.ts
```

The server starts on `http://localhost:3000` (override with `PORT` env var).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `A2A_AGENT_URL` | _(none)_ | URL of a remote A2A-compatible agent; enables the full A2A runtime |
| `MOCK_A2A_PORT` | `4000` | Port for the bundled mock A2A agent |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check, plugin info & A2A status |
| GET | `/plugin` | Detailed plugin registration info |
| POST | `/message` | Send a simulated inbound channel message |
| GET | `/history` | Get echo bot conversation history |
| POST | `/clear` | Clear conversation history |
| GET | `/a2a/status` | A2A runtime connection status & agent card |
| POST | `/a2a/run` | Dispatch a sub-agent task via the A2A runtime |

### Example: Echo bot message

```bash
curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, Feishu!"}'
```

### Example: A2A sub-agent run

```bash
# requires A2A_AGENT_URL to be set
curl -X POST http://localhost:3000/a2a/run \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 2+2?", "sessionKey": "my-session"}'
```

Response:
```json
{
  "runId": "9ef4eeb1-...",
  "sessionKey": "my-session",
  "status": "ok",
  "messages": [
    { "role": "user",  "content": "What is 2+2?" },
    { "role": "agent", "content": "4" }
  ]
}
```

## Architecture

```
demo/
├── server.ts                  # Bun HTTP server entry point
├── mock-a2a-agent.ts          # Minimal mock A2A agent for local testing
├── lib/
│   ├── a2a-plugin-runtime.ts  # A2A-backed PluginRuntime implementation ★
│   ├── mock-sdk.ts            # Lightweight mock of openclaw/plugin-sdk
│   ├── plugin-loader.ts       # Imports & registers the Lark channel plugin
│   └── echo-bot.ts            # Simple echo bot for local message testing
└── package.json
```

### A2A Plugin Runtime (`lib/a2a-plugin-runtime.ts`)

Replaces no-op stubs with real implementations:

| Namespace | Implementation |
|-----------|----------------|
| `subagent.run()` | `A2AClient.sendTask()` — submits to remote A2A agent |
| `subagent.waitForRun()` | Polls `A2AClient.getTask()` until terminal state |
| `subagent.getSessionMessages()` | Returns task history from A2A |
| `subagent.deleteSession()` | `A2AClient.cancelTask()` for all session tasks |
| `channel.text.*` | In-process text chunking & command detection |
| `channel.routing.*` | Deterministic session-key builder |
| `channel.session.*` | In-memory session metadata store |
| `channel.pairing.*` | In-memory allow-from store |
| `channel.activity.*` | In-memory activity log |
| `channel.media.*` | HTTP fetch + file system save |
| `channel.debounce.*` | setTimeout-based debouncer |
| `runtime.agent.*` | File system workspace paths |
| `runtime.system.runCommandWithTimeout` | `child_process.spawn` wrapper |
| `runtime.a2a` | Direct `A2AClient` / `A2ACardResolver` access |
