# OpenClaw Lark Plugin — Demo Server

A self-contained [Bun](https://bun.sh) HTTP server that loads the `@larksuite/openclaw-lark` channel plugin and wires it to a mock **Echo Bot**.

This demo shows how to:

1. **Load a channel plugin** outside the official OpenClaw runtime by providing a lightweight mock of `OpenClawPluginApi`
2. **Inspect registration results** — channels, tools, hooks and commands the plugin registered
3. **Simulate inbound messages** and get echo replies through a simple REST API

## Prerequisites

- [Bun](https://bun.sh) v1.0+ (or Node.js 22+ with `--experimental-strip-types`)
- The parent plugin must be built first (`pnpm build` in the repo root)

## Quick Start

```bash
# 1. Build the parent plugin (from repo root)
pnpm install
pnpm build

# 2. Install demo dependencies
cd demo
bun install

# 3. Start the server
bun run server.ts
```

The server starts on `http://localhost:3000` (override with `PORT` env var).

## API Endpoints

| Method | Path       | Description                              |
|--------|-----------|------------------------------------------|
| GET    | `/`       | Health check & plugin info               |
| GET    | `/plugin` | Detailed plugin registration info        |
| POST   | `/message`| Send a simulated inbound message         |
| GET    | `/history`| Get echo bot conversation history        |
| POST   | `/clear`  | Clear conversation history               |

### Example: Send a message

```bash
curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, Feishu!"}'
```

Response:

```json
{
  "inbound": {
    "messageId": "msg_1234567890",
    "chatId": "demo_chat_001",
    "senderId": "user_001",
    "text": "Hello, Feishu!",
    "chatType": "p2p"
  },
  "reply": {
    "messageId": "echo_1_1234567890",
    "chatId": "demo_chat_001",
    "text": "🤖 Echo: Hello, Feishu!"
  }
}
```

### Example: Custom sender & chat

```bash
curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hi from group!",
    "chatId": "group_chat_42",
    "senderId": "ou_abc123",
    "chatType": "group"
  }'
```

## Architecture

```
demo/
├── server.ts              # Bun HTTP server entry point
├── lib/
│   ├── mock-sdk.ts        # Lightweight mock of openclaw/plugin-sdk
│   ├── plugin-loader.ts   # Imports & registers the Lark channel plugin
│   └── echo-bot.ts        # Simple echo bot that replies to messages
├── package.json
├── tsconfig.json
└── README.md
```

### Plugin Loader Flow

```
server.ts
  └─ plugin-loader.ts
       ├─ Creates a mock OpenClawPluginApi (mock-sdk.ts)
       ├─ Imports ../../dist/index.mjs (built Lark plugin)
       ├─ Calls plugin.register(mockApi)
       └─ Collects: channels, tools, hooks, commands
```

The mock SDK implements just enough of the `OpenClawPluginApi` interface for the plugin's `register()` method to succeed. Methods not needed for registration are stubbed as no-ops with console warnings.

### Echo Bot

The Echo Bot is intentionally minimal — it receives `InboundMessagePayload` objects and returns `EchoBotReply` with the text prefixed by `🤖 Echo:`. It maintains an in-memory conversation history for debugging.

To replace it with a real LLM agent, swap out the `bot.handleMessage()` call in `server.ts` with your own agent dispatch logic.
