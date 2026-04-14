# OpenClaw Lark Plugin — Demo Server

A self-contained [Bun](https://bun.sh) HTTP server that demonstrates production-like management of the `@larksuite/openclaw-lark` channel plugin.

## Architecture overview

```
ChannelRegistry  ←──  HTTP API  (CRUD bindings)
      ↓
ChannelRuntimeManager  ─→  LoadedPlugin (one per binding)
                                 ↓
                          Feishu WebSocket gateway
                                 ↓
                           A2A remote agent
```

**`ChannelRegistry`** stores agent-ID → channel-binding mappings in memory (with Feishu app credentials). This is the source of truth for which agents are connected and how.

**`ChannelRuntimeManager`** reads the registry and manages one `LoadedPlugin` instance per binding. On `start()` it calls `loadPlugin()` with the binding config and starts the Feishu WebSocket gateway.

**HTTP API** provides all the operations that the `openclaw` CLI previously handled: registering bindings, starting/stopping gateways, probing credentials, and triggering the OAuth / onboarding flow.

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- The parent plugin must be built first (`pnpm build` in the repo root)

## Quick Start

```bash
# 1. Build the parent plugin (from repo root)
pnpm install && pnpm build

# 2. Install demo dependencies
cd demo && pnpm install

# 3a. Start the server (no bindings yet)
bun run server.ts

# 3b. Auto-register a Feishu binding from env vars
FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=xxx \
A2A_AGENT_URL=http://localhost:4000 \
bun run server.ts

# 3c. Mock A2A agent (for local testing without a real LLM backend)
MOCK_A2A_PORT=4000 bun run mock-a2a-agent.ts &
A2A_AGENT_URL=http://localhost:4000 bun run server.ts
```

The server starts on `http://localhost:3000` (override with `PORT` env var).

## Environment Variables

When all three env vars below are set, a **default** binding is registered and the gateway is started automatically.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `FEISHU_APP_ID` | _(none)_ | Feishu App ID for the default binding |
| `FEISHU_APP_SECRET` | _(none)_ | Feishu App Secret for the default binding |
| `A2A_AGENT_URL` | _(none)_ | A2A agent URL for the default binding |
| `FEISHU_VERIFICATION_TOKEN` | _(none)_ | Verification token (webhook mode) |
| `FEISHU_ENCRYPT_KEY` | _(none)_ | Encrypt key (webhook mode) |
| `FEISHU_DOMAIN` | `feishu` | `feishu` or `lark` |
| `FEISHU_DM_POLICY` | `open` | `open` / `pairing` / `allowlist` / `disabled` |
| `FEISHU_REQUIRE_MENTION` | `false` | Require @mention in groups |
| `MOCK_A2A_PORT` | `4000` | Port for the bundled mock A2A agent |

## API Reference

### General

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health + registry summary |
| GET | `/plugin` | Registration info for the first loaded plugin |
| POST | `/message` | Echo bot: simulate an inbound message |
| GET | `/history` | Echo bot conversation history |
| POST | `/clear` | Clear echo bot history |
| GET | `/a2a/status` | Probe a remote A2A agent (`?url=` or first binding) |
| POST | `/a2a/run` | Dispatch a task directly to a remote A2A agent |

### Binding management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/bindings` | List all registered bindings + runtime status |
| POST | `/bindings/feishu` | Create or replace a Feishu binding |
| DELETE | `/bindings/feishu/:agentId` | Remove binding and stop its gateway |

### Per-agent operations

Replace what `openclaw gateway` and `openclaw feishu` CLI commands do:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/bindings/feishu/:agentId/status` | Runtime status for one agent |
| POST | `/bindings/feishu/:agentId/start` | Start the Feishu WebSocket gateway |
| POST | `/bindings/feishu/:agentId/stop` | Stop the Feishu WebSocket gateway |
| POST | `/bindings/feishu/:agentId/restart` | Restart the gateway (picks up config changes) |
| POST | `/bindings/feishu/:agentId/probe` | Test Feishu credentials (calls bot API) |
| POST | `/bindings/feishu/:agentId/auth` | Trigger OAuth / onboarding for a user |

## Examples

### Register a Feishu binding and start its gateway

```bash
curl -X POST http://localhost:3000/bindings/feishu \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "my-agent",
    "a2aAgentUrl": "http://localhost:4000",
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "dmPolicy": "open"
  }'
```

### List all bindings with status

```bash
curl http://localhost:3000/bindings
```

### Probe credentials

```bash
curl -X POST http://localhost:3000/bindings/feishu/my-agent/probe
```

### Trigger OAuth / onboarding for a user (replaces `openclaw feishu auth`)

```bash
curl -X POST http://localhost:3000/bindings/feishu/my-agent/auth \
  -H "Content-Type: application/json" \
  -d '{"userOpenId": "ou_xxxxx"}'
```

### Restart gateway after config change

```bash
# 1. Update the binding (PUT semantics — replace then restart)
curl -X POST http://localhost:3000/bindings/feishu \
  -H "Content-Type: application/json" \
  -d '{"agentId":"my-agent","a2aAgentUrl":"http://localhost:4000","appId":"cli_xxx","appSecret":"new_secret"}'

# 2. Or just restart without changing config
curl -X POST http://localhost:3000/bindings/feishu/my-agent/restart
```

### Echo bot (for local testing)

```bash
curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, Feishu!"}'
```

## File layout

```
demo/
├── server.ts                       # Bun HTTP server entry point
├── mock-a2a-agent.ts               # Minimal mock A2A agent for local testing
├── lib/
│   ├── channel-registry.ts         # In-memory binding store  ★
│   ├── channel-runtime-manager.ts  # LoadedPlugin lifecycle manager  ★
│   ├── plugin-loader.ts            # Imports & registers the Lark channel plugin
│   ├── a2a-plugin-runtime.ts       # A2A-backed PluginRuntime implementation
│   ├── mock-sdk.ts                 # Fully-implemented mock of openclaw/plugin-sdk
│   └── echo-bot.ts                 # Simple echo bot for local message testing
└── package.json
```

### `lib/a2a-plugin-runtime.ts` — what it implements

| Namespace | Implementation |
|-----------|----------------|
| `subagent.run()` | `A2AClient.sendTask()` — submits to remote A2A agent |
| `subagent.waitForRun()` | Polls `A2AClient.getTask()` until terminal state |
| `subagent.getSessionMessages()` | Returns task history from A2A |
| `subagent.deleteSession()` | `A2AClient.cancelTask()` for all session tasks |
| `channel.reply.dispatchReplyFromConfig` | Full Feishu ↔ A2A dispatch loop |
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
