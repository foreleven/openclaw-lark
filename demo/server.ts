/**
 * Demo Bun Server
 *
 * A self-contained HTTP server that:
 *   1. Loads the `@larksuite/openclaw-lark` channel plugin via the plugin loader
 *   2. Runs an Echo Bot that replies to simulated channel messages
 *   3. Optionally wires up an A2A-backed plugin runtime for real sub-agent calls
 *   4. Exposes REST endpoints for testing the full message round-trip
 *
 * Usage:
 *   bun run server.ts                                # start on default port 3000
 *   PORT=8080 bun run server.ts                      # custom port
 *   A2A_AGENT_URL=http://localhost:4000 bun run server.ts  # enable A2A runtime
 *
 * Endpoints:
 *   GET  /                → health check & plugin info
 *   GET  /plugin          → detailed plugin registration info
 *   POST /message         → send a simulated inbound message (JSON body)
 *   GET  /history         → retrieve echo bot conversation history
 *   POST /clear           → clear conversation history
 *   GET  /a2a/status      → A2A runtime connection status
 *   POST /a2a/run         → dispatch a sub-agent task via the A2A runtime
 */

import { loadPlugin, type LoadedPlugin } from './lib/plugin-loader.ts';
import { EchoBot, type InboundMessagePayload } from './lib/echo-bot.ts';
import { createA2APluginRuntime } from './lib/a2a-plugin-runtime.ts';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const A2A_AGENT_URL = process.env['A2A_AGENT_URL'] ?? '';
const bot = new EchoBot();

let plugin: LoadedPlugin | null = null;
let pluginError: string | null = null;

try {
  plugin = await loadPlugin({ a2aAgentUrl: A2A_AGENT_URL || undefined });
} catch (err) {
  // Log full error to console for debugging, but only expose the message
  // to HTTP responses (avoid stack-trace leakage).
  console.error('[server] plugin load failed:', err);
  pluginError = err instanceof Error ? err.message : 'Plugin load failed';
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

  return json({ error: 'Not Found' }, 404);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.info([
  '',
  '  ╔═══════════════════════════════════════╗',
  '  ║  OpenClaw Lark Plugin — Demo Server  ║',
  '  ╚═══════════════════════════════════════╝',
  `  Plugin loaded : ${plugin ? '✅ yes' : '❌ no'}`,
  `  Echo bot      : ✅ ready`,
  `  A2A runtime   : ${plugin?.a2aEnabled ? `✅ ${A2A_AGENT_URL}` : '⚠️  not configured (set A2A_AGENT_URL)'}`,
  `  Server        : http://localhost:${PORT}`,
  '',
  `  Try it: curl http://localhost:${PORT}/`,
  `          curl -X POST http://localhost:${PORT}/message -H 'Content-Type: application/json' -d '{"text":"Hello!"}'`,
  '',
].join('\n'));

export default server;
