/**
 * Demo Bun Server
 *
 * A self-contained HTTP server that:
 *   1. Loads the `@larksuite/openclaw-lark` channel plugin via the plugin loader
 *   2. Runs an Echo Bot that replies to simulated channel messages
 *   3. Optionally wires up an A2A-backed plugin runtime for real sub-agent calls
 *   4. Exposes REST endpoints for testing the full message round-trip
 *   5. Can start the Feishu WebSocket gateway so real Feishu messages are
 *      forwarded to the A2A agent and replies sent back via Feishu
 *
 * Usage:
 *   bun run server.ts                                # start on default port 3000
 *   PORT=8080 bun run server.ts                      # custom port
 *   A2A_AGENT_URL=http://localhost:4000 bun run server.ts  # enable A2A runtime
 *
 *   # Full Feishu ↔ A2A bridge (gateway auto-starts when all 3 vars are set):
 *   FEISHU_APP_ID=cli_xxx \
 *   FEISHU_APP_SECRET=xxx \
 *   A2A_AGENT_URL=http://localhost:4000 \
 *   bun run server.ts
 *
 * Endpoints:
 *   GET  /                → health check & plugin info
 *   GET  /plugin          → detailed plugin registration info
 *   POST /message         → send a simulated inbound message (JSON body)
 *   GET  /history         → retrieve echo bot conversation history
 *   POST /clear           → clear conversation history
 *   GET  /a2a/status      → A2A runtime connection status
 *   POST /a2a/run         → dispatch a sub-agent task via the A2A runtime
 *   GET  /gateway/status  → Feishu WebSocket gateway status
 *   POST /gateway/start   → start the Feishu WebSocket gateway
 *   DELETE /gateway/stop  → stop the Feishu WebSocket gateway
 */

import { loadPlugin, type LoadedPlugin } from './lib/plugin-loader.ts';
import { EchoBot, type InboundMessagePayload } from './lib/echo-bot.ts';
import { createA2APluginRuntime } from './lib/a2a-plugin-runtime.ts';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const A2A_AGENT_URL = process.env['A2A_AGENT_URL'] ?? '';

// Feishu credentials (optional) — when set the gateway auto-starts
const FEISHU_APP_ID = process.env['FEISHU_APP_ID'] ?? '';
const FEISHU_APP_SECRET = process.env['FEISHU_APP_SECRET'] ?? '';
const FEISHU_VERIFICATION_TOKEN = process.env['FEISHU_VERIFICATION_TOKEN'] ?? '';
const FEISHU_ENCRYPT_KEY = process.env['FEISHU_ENCRYPT_KEY'] ?? '';
const FEISHU_DOMAIN = (process.env['FEISHU_DOMAIN'] ?? 'feishu') as 'feishu' | 'lark';
const FEISHU_REQUIRE_MENTION = process.env['FEISHU_REQUIRE_MENTION'] === 'true';
const FEISHU_DM_POLICY = (process.env['FEISHU_DM_POLICY'] ?? 'open') as 'open' | 'pairing' | 'allowlist' | 'disabled';

const hasFeishuCredentials = !!(FEISHU_APP_ID && FEISHU_APP_SECRET);

const bot = new EchoBot();

let plugin: LoadedPlugin | null = null;
let pluginError: string | null = null;

try {
  plugin = await loadPlugin({
    a2aAgentUrl: A2A_AGENT_URL || undefined,
    feishuAccount: hasFeishuCredentials
      ? {
          appId: FEISHU_APP_ID,
          appSecret: FEISHU_APP_SECRET,
          verificationToken: FEISHU_VERIFICATION_TOKEN || undefined,
          encryptKey: FEISHU_ENCRYPT_KEY || undefined,
          connectionMode: 'websocket',
          dmPolicy: FEISHU_DM_POLICY,
          requireMention: FEISHU_REQUIRE_MENTION,
        }
      : undefined,
  });
} catch (err) {
  // Log full error to console for debugging, but only expose the message
  // to HTTP responses (avoid stack-trace leakage).
  console.error('[server] plugin load failed:', err);
  pluginError = err instanceof Error ? err.message : 'Plugin load failed';
}

// Auto-start the Feishu gateway when all required credentials are available
if (plugin && hasFeishuCredentials && A2A_AGENT_URL) {
  try {
    await plugin.startGateway();
    console.info('[server] Feishu WebSocket gateway started (auto-start)');
  } catch (err) {
    console.error('[server] Failed to auto-start Feishu gateway:', err);
  }
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // GET / — health check
  if (pathname === '/' && req.method === 'GET') {
    const channelPlugin = plugin?.channel?.plugin;
    return json({
      status: 'ok',
      pluginLoaded: plugin !== null,
      pluginError,
      a2aEnabled: plugin?.a2aEnabled ?? false,
      a2aAgentUrl: A2A_AGENT_URL || null,
      feishuCredentials: hasFeishuCredentials,
      gatewayRunning: plugin?.gatewayRunning ?? false,
      channel: channelPlugin
        ? {
            id: channelPlugin.id,
            meta: channelPlugin.meta,
            capabilities: channelPlugin.capabilities,
          }
        : null,
      endpoints: {
        'GET /': 'Health check & plugin info',
        'GET /plugin': 'Detailed plugin registration info',
        'POST /message': 'Send a simulated inbound message',
        'GET /history': 'Get echo bot conversation history',
        'POST /clear': 'Clear conversation history',
        'GET /a2a/status': 'A2A runtime connection status',
        'POST /a2a/run': 'Dispatch a sub-agent task via the A2A runtime',
        'GET /gateway/status': 'Feishu WebSocket gateway status',
        'POST /gateway/start': 'Start the Feishu WebSocket gateway',
        'DELETE /gateway/stop': 'Stop the Feishu WebSocket gateway',
      },
    });
  }

  // GET /plugin — detailed registration info
  if (pathname === '/plugin' && req.method === 'GET') {
    if (!plugin) {
      return json({ error: 'Plugin not loaded', reason: pluginError }, 500);
    }
    const reg = plugin.registration;
    return json({
      channels: reg.channels.map((c) => ({
        id: c.plugin.id,
        meta: c.plugin.meta,
        capabilities: c.plugin.capabilities,
      })),
      toolCount: reg.tools.length,
      hookNames: [...reg.hooks.keys()],
      commandCount: reg.commands.length,
    });
  }

  // POST /message — simulate an inbound channel message
  if (pathname === '/message' && req.method === 'POST') {
    let body: InboundMessagePayload;
    try {
      body = (await req.json()) as InboundMessagePayload;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.text) {
      return json({ error: 'Missing required field: text' }, 400);
    }

    // Apply defaults
    const payload: InboundMessagePayload = {
      messageId: body.messageId || `msg_${Date.now()}`,
      chatId: body.chatId || 'demo_chat_001',
      senderId: body.senderId || 'user_001',
      text: body.text,
      chatType: body.chatType || 'p2p',
    };

    // Fire registered hooks if any listeners exist
    if (plugin) {
      await plugin.emitHook('message_received', { message: payload }, { sessionKey: payload.chatId });
    }

    // Echo bot processes the message
    const reply = bot.handleMessage(payload);

    return json({
      inbound: payload,
      reply,
    });
  }

  // GET /history — conversation log
  if (pathname === '/history' && req.method === 'GET') {
    return json({ history: bot.getHistory() });
  }

  // POST /clear — reset conversation
  if (pathname === '/clear' && req.method === 'POST') {
    bot.clearHistory();
    return json({ status: 'cleared' });
  }

  // ---------------------------------------------------------------------------
  // A2A endpoints
  // ---------------------------------------------------------------------------

  // GET /a2a/status — A2A runtime connection status
  if (pathname === '/a2a/status' && req.method === 'GET') {
    if (!A2A_AGENT_URL) {
      return json({
        enabled: false,
        message: 'Set A2A_AGENT_URL env var to enable the A2A runtime',
      });
    }

    // Probe the agent card
    try {
      const a2aRuntime = createA2APluginRuntime({ agentUrl: A2A_AGENT_URL });
      const a2aExt = a2aRuntime['a2a'] as { getAgentCard: () => Promise<unknown> };
      const card = await a2aExt.getAgentCard();
      return json({ enabled: true, agentUrl: A2A_AGENT_URL, agentCard: card });
    } catch (err) {
      return json({
        enabled: false,
        agentUrl: A2A_AGENT_URL,
        error: err instanceof Error ? err.message : String(err),
      }, 503);
    }
  }

  // POST /a2a/run — dispatch a sub-agent task
  if (pathname === '/a2a/run' && req.method === 'POST') {
    if (!A2A_AGENT_URL) {
      return json(
        { error: 'A2A runtime not configured. Set A2A_AGENT_URL env var.' },
        501,
      );
    }

    let body: { message: string; sessionKey?: string; wait?: boolean; timeoutMs?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.message) {
      return json({ error: 'Missing required field: message' }, 400);
    }

    const a2aRuntime = createA2APluginRuntime({ agentUrl: A2A_AGENT_URL });
    const subagent = a2aRuntime['subagent'] as {
      run: (p: { sessionKey: string; message: string }) => Promise<{ runId: string }>;
      waitForRun: (p: { runId: string; timeoutMs?: number }) => Promise<{ status: string; error?: string }>;
      getSessionMessages: (p: { sessionKey: string }) => Promise<{ messages: unknown[] }>;
    };

    const sessionKey = body.sessionKey || `demo_session_${Date.now()}`;

    try {
      const runResult = await subagent.run({ sessionKey, message: body.message });

      if (body.wait !== false) {
        const waitResult = await subagent.waitForRun({
          runId: runResult.runId,
          timeoutMs: body.timeoutMs,
        });
        const messages = await subagent.getSessionMessages({ sessionKey });
        return json({ runId: runResult.runId, sessionKey, ...waitResult, messages: messages.messages });
      }

      return json({ runId: runResult.runId, sessionKey, status: 'submitted' });
    } catch (err) {
      return json({
        error: 'A2A agent call failed',
        reason: err instanceof Error ? err.message : String(err),
      }, 502);
    }
  }

  // ---------------------------------------------------------------------------
  // Gateway endpoints
  // ---------------------------------------------------------------------------

  // GET /gateway/status — Feishu WebSocket gateway status
  if (pathname === '/gateway/status' && req.method === 'GET') {
    return json({
      running: plugin?.gatewayRunning ?? false,
      feishuCredentials: hasFeishuCredentials,
      a2aEnabled: plugin?.a2aEnabled ?? false,
      feishuAppId: FEISHU_APP_ID || null,
      feishuDomain: FEISHU_DOMAIN,
      requireMention: FEISHU_REQUIRE_MENTION,
      dmPolicy: FEISHU_DM_POLICY,
      message: !hasFeishuCredentials
        ? 'Set FEISHU_APP_ID and FEISHU_APP_SECRET env vars to enable the gateway'
        : !A2A_AGENT_URL
          ? 'Set A2A_AGENT_URL env var to route messages to an A2A agent'
          : plugin?.gatewayRunning
            ? 'Gateway is running — Feishu messages are being forwarded to the A2A agent'
            : 'Gateway is stopped',
    });
  }

  // POST /gateway/start — start the Feishu WebSocket gateway
  if (pathname === '/gateway/start' && req.method === 'POST') {
    if (!plugin) {
      return json({ error: 'Plugin not loaded', reason: pluginError }, 500);
    }
    if (!hasFeishuCredentials) {
      return json(
        { error: 'Feishu credentials not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET env vars.' },
        501,
      );
    }
    if (plugin.gatewayRunning) {
      return json({ status: 'already_running', message: 'Feishu gateway is already running' });
    }
    try {
      await plugin.startGateway();
      return json({ status: 'started', message: 'Feishu WebSocket gateway started' });
    } catch (err) {
      return json({
        error: 'Failed to start gateway',
        reason: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  }

  // DELETE /gateway/stop — stop the Feishu WebSocket gateway
  if (pathname === '/gateway/stop' && req.method === 'DELETE') {
    if (!plugin) {
      return json({ error: 'Plugin not loaded', reason: pluginError }, 500);
    }
    if (!plugin.gatewayRunning) {
      return json({ status: 'not_running', message: 'Feishu gateway is not running' });
    }
    plugin.stopGateway();
    return json({ status: 'stopped', message: 'Feishu WebSocket gateway stopped' });
  }

  return json({ error: 'Not Found' }, 404);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

const feishuStatus = hasFeishuCredentials
  ? `✅ ${FEISHU_APP_ID} (${FEISHU_DOMAIN})`
  : '⚠️  not configured (set FEISHU_APP_ID + FEISHU_APP_SECRET)';

const gatewayStatus = plugin?.gatewayRunning
  ? '✅ running'
  : hasFeishuCredentials && !A2A_AGENT_URL
    ? '⚠️  set A2A_AGENT_URL to auto-start'
    : '⚠️  not started';

console.info([
  '',
  '  ╔═══════════════════════════════════════╗',
  '  ║  OpenClaw Lark Plugin — Demo Server  ║',
  '  ╚═══════════════════════════════════════╝',
  `  Plugin loaded : ${plugin ? '✅ yes' : '❌ no'}`,
  `  Echo bot      : ✅ ready`,
  `  Feishu creds  : ${feishuStatus}`,
  `  A2A runtime   : ${plugin?.a2aEnabled ? `✅ ${A2A_AGENT_URL}` : '⚠️  not configured (set A2A_AGENT_URL)'}`,
  `  Gateway       : ${gatewayStatus}`,
  `  Server        : http://localhost:${PORT}`,
  '',
  `  Try it: curl http://localhost:${PORT}/`,
  `          curl -X POST http://localhost:${PORT}/message -H 'Content-Type: application/json' -d '{"text":"Hello!"}'`,
  `          curl http://localhost:${PORT}/gateway/status`,
  '',
].join('\n'));

export default server;
