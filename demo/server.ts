/**
 * Demo Bun Server
 *
 * A self-contained HTTP server that:
 *   1. Loads the `@larksuite/openclaw-lark` channel plugin via the plugin loader
 *   2. Runs an Echo Bot that replies to simulated channel messages
 *   3. Exposes REST endpoints for testing the full message round-trip
 *
 * Usage:
 *   bun run server.ts            # start on default port 3000
 *   PORT=8080 bun run server.ts  # custom port
 *
 * Endpoints:
 *   GET  /                → health check & plugin info
 *   GET  /plugin          → detailed plugin registration info
 *   POST /message         → send a simulated inbound message (JSON body)
 *   GET  /history         → retrieve echo bot conversation history
 *   POST /clear           → clear conversation history
 */

import { loadPlugin, type LoadedPlugin } from './lib/plugin-loader.ts';
import { EchoBot, type InboundMessagePayload } from './lib/echo-bot.ts';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const bot = new EchoBot();

let plugin: LoadedPlugin | null = null;
let pluginError: string | null = null;

try {
  plugin = await loadPlugin();
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

  return json({ error: 'Not Found' }, 404);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.info(`
╔══════════════════════════════════════════════════════════╗
║           OpenClaw Lark Plugin — Demo Server             ║
╠══════════════════════════════════════════════════════════╣
║  Plugin loaded : ${plugin ? '✅ yes' : '❌ no '}                                   ║
║  Echo bot      : ✅ ready                                ║
║  Server        : http://localhost:${String(PORT).padEnd(5, ' ')}                    ║
╠══════════════════════════════════════════════════════════╣
║  Try it:                                                 ║
║  curl http://localhost:${String(PORT).padEnd(5, ' ')}                              ║
║  curl -X POST http://localhost:${String(PORT).padEnd(5, ' ')}/message \\            ║
║       -H "Content-Type: application/json" \\              ║
║       -d '{"text":"Hello!"}'                             ║
╚══════════════════════════════════════════════════════════╝
`);

export default server;
