/**
 * OpenClaw Lark — Bun HTTP Server
 *
 * Architecture
 * ────────────
 * • ChannelRegistry  — in-memory service that stores agent-ID → channel-binding
 *                      mappings (including Feishu app credentials).
 * • ChannelRuntimeManager — reads the registry, manages one LoadedPlugin
 *                      instance per binding, and starts/stops each gateway.
 * • HTTP API         — CRUD for bindings + login/auth operations that
 *                      replace the openclaw CLI commands.
 *
 * Quick start (no Feishu creds):
 *   bun run server.ts
 *   curl http://localhost:3000/
 *   curl -X POST http://localhost:3000/message -d '{"text":"hi"}'
 *
 * Auto-register a Feishu binding from env vars on startup:
 *   FEISHU_APP_ID=cli_xxx \
 *   FEISHU_APP_SECRET=xxx \
 *   A2A_AGENT_URL=http://localhost:4000 \
 *   bun run server.ts
 *
 * Or register dynamically:
 *   curl -X POST http://localhost:3000/bindings/feishu \
 *     -H 'Content-Type: application/json' \
 *     -d '{"agentId":"my-agent","a2aAgentUrl":"http://localhost:4000",
 *          "appId":"cli_xxx","appSecret":"xxx"}'
 *
 * Endpoints
 * ─────────
 *   GET  /                              health + registry summary
 *   GET  /plugin                        first loaded plugin registration info
 *   POST /message                       echo bot: simulate inbound message
 *   GET  /history                       echo bot history
 *   POST /clear                         clear echo bot history
 *
 *   GET  /bindings                      list all bindings + runtime status
 *   POST /bindings/feishu               create/replace Feishu binding
 *   DELETE /bindings/feishu/:agentId    remove binding (stops gateway)
 *   GET  /bindings/feishu/:agentId/status     runtime status for one agent
 *   POST /bindings/feishu/:agentId/start      start Feishu gateway
 *   POST /bindings/feishu/:agentId/stop       stop Feishu gateway
 *   POST /bindings/feishu/:agentId/restart    restart Feishu gateway
 *   POST /bindings/feishu/:agentId/probe      test Feishu credentials
 *   POST /bindings/feishu/:agentId/auth       trigger OAuth / onboarding
 *
 *   GET  /a2a/status                    probe a remote A2A agent
 *   POST /a2a/run                       dispatch task to remote A2A agent
 */

import { EchoBot, type InboundMessagePayload } from './lib/echo-bot.ts';
import { createA2APluginRuntime } from './lib/a2a-plugin-runtime.ts';
import { ChannelRegistry, type FeishuChannelConfig } from './lib/channel-registry.ts';
import { ChannelRuntimeManager } from './lib/channel-runtime-manager.ts';
import { FeishuSetupService, buildSetupPage, DEFAULT_SETUP_AGENT_ID } from './lib/feishu-setup.ts';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;

// Optional "default binding" assembled from env vars at startup.
const ENV_A2A_AGENT_URL = process.env['A2A_AGENT_URL'] ?? '';
const ENV_FEISHU_APP_ID = process.env['FEISHU_APP_ID'] ?? '';
const ENV_FEISHU_APP_SECRET = process.env['FEISHU_APP_SECRET'] ?? '';
const ENV_FEISHU_VERIFICATION_TOKEN = process.env['FEISHU_VERIFICATION_TOKEN'] ?? '';
const ENV_FEISHU_ENCRYPT_KEY = process.env['FEISHU_ENCRYPT_KEY'] ?? '';
const ENV_FEISHU_DOMAIN = (process.env['FEISHU_DOMAIN'] ?? 'feishu') as 'feishu' | 'lark';
const ENV_FEISHU_REQUIRE_MENTION = process.env['FEISHU_REQUIRE_MENTION'] === 'true';
const ENV_FEISHU_DM_POLICY = (process.env['FEISHU_DM_POLICY'] ?? 'open') as
  'open' | 'pairing' | 'allowlist' | 'disabled';

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const bot = new EchoBot();
const registry = new ChannelRegistry();
const manager = new ChannelRuntimeManager(registry);
const setup = new FeishuSetupService(registry, manager);

// Auto-register a default binding from env vars when all three required vars
// are set: FEISHU_APP_ID, FEISHU_APP_SECRET, and A2A_AGENT_URL.
if (ENV_FEISHU_APP_ID && ENV_FEISHU_APP_SECRET && ENV_A2A_AGENT_URL) {
  registry.register({
    agentId: 'default',
    a2aAgentUrl: ENV_A2A_AGENT_URL,
    channelId: 'feishu',
    config: {
      appId: ENV_FEISHU_APP_ID,
      appSecret: ENV_FEISHU_APP_SECRET,
      verificationToken: ENV_FEISHU_VERIFICATION_TOKEN || undefined,
      encryptKey: ENV_FEISHU_ENCRYPT_KEY || undefined,
      connectionMode: 'websocket',
      dmPolicy: ENV_FEISHU_DM_POLICY,
      requireMention: ENV_FEISHU_REQUIRE_MENTION,
      domain: ENV_FEISHU_DOMAIN,
    },
  });
  console.info('[server] default binding registered from env vars (agentId: "default")');

  // Auto-start the gateway for the default binding
  try {
    await manager.start('default');
    console.info('[server] default Feishu gateway started (auto-start)');
  } catch (err) {
    console.error('[server] failed to auto-start default gateway:', err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function safeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'An error occurred';
  const msg = err.message.split('\n')[0] ?? '';
  return msg.replace(/\/[^\s:]+|[A-Z]:\\[^\s:]*/g, '[path]').trim() || 'An error occurred';
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname, method } = { pathname: url.pathname, method: req.method };

  // ──────────────────────────────────────────────────────────────────────────
  // GET / — health + registry summary
  // ──────────────────────────────────────────────────────────────────────────
  if (pathname === '/' && method === 'GET') {
    const bindings = registry.list();
    const entries = manager.listEntries();
    return json({
      status: 'ok',
      bindingCount: bindings.length,
      runningCount: entries.filter((e) => e.plugin.gatewayRunning).length,
      endpoints: {
        'GET  /': 'Health + registry summary',
        'GET  /plugin': 'First loaded plugin registration info',
        'POST /message': 'Echo bot — simulate inbound message',
        'GET  /history': 'Echo bot history',
        'POST /clear': 'Clear echo bot history',
        'GET  /bindings': 'List all bindings + status',
        'POST /bindings/feishu': 'Create/replace Feishu binding',
        'DELETE /bindings/feishu/:agentId': 'Remove binding + stop gateway',
        'GET  /bindings/feishu/:agentId/status': 'Status for one agent',
        'POST /bindings/feishu/:agentId/start': 'Start Feishu gateway',
        'POST /bindings/feishu/:agentId/stop': 'Stop Feishu gateway',
        'POST /bindings/feishu/:agentId/restart': 'Restart Feishu gateway',
        'POST /bindings/feishu/:agentId/probe': 'Test Feishu credentials',
        'POST /bindings/feishu/:agentId/auth': 'Trigger OAuth / onboarding',
        'GET  /a2a/status': 'Probe remote A2A agent (query: ?url=)',
        'POST /a2a/run': 'Dispatch task to remote A2A agent',
        'GET  /setup/feishu': 'Feishu bot setup page (QR code scan to bind)',
        'POST /setup/feishu/start': 'Start Feishu QR device-flow session',
        'GET  /setup/feishu/status/:sessionId': 'Poll QR session status',
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /plugin — first loaded plugin's registration info
  // ──────────────────────────────────────────────────────────────────────────
  if (pathname === '/plugin' && method === 'GET') {
    const entry = manager.listEntries()[0];
    if (!entry) {
      return json({
        error: 'No plugin loaded yet',
        hint: 'POST /bindings/feishu to register an agent binding first',
      }, 404);
    }
    const reg = entry.plugin.registration;
    return json({
      agentId: entry.binding.agentId,
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

  // ──────────────────────────────────────────────────────────────────────────
  // Echo bot
  // ──────────────────────────────────────────────────────────────────────────

  // POST /message
  if (pathname === '/message' && method === 'POST') {
    let body: InboundMessagePayload;
    try {
      body = (await req.json()) as InboundMessagePayload;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.text) return json({ error: 'Missing required field: text' }, 400);

    const payload: InboundMessagePayload = {
      messageId: body.messageId || `msg_${Date.now()}`,
      chatId: body.chatId || 'demo_chat_001',
      senderId: body.senderId || 'user_001',
      text: body.text,
      chatType: body.chatType || 'p2p',
    };

    // Fire hooks on all loaded plugins
    for (const entry of manager.listEntries()) {
      await entry.plugin.emitHook(
        'message_received',
        { message: payload },
        { sessionKey: payload.chatId },
      ).catch((err: unknown) => {
        console.error(`[server] emitHook error for agent "${entry.binding.agentId}":`, err);
      });
    }

    return json({ inbound: payload, reply: bot.handleMessage(payload) });
  }

  // GET /history
  if (pathname === '/history' && method === 'GET') {
    return json({ history: bot.getHistory() });
  }

  // POST /clear
  if (pathname === '/clear' && method === 'POST') {
    bot.clearHistory();
    return json({ status: 'cleared' });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Binding management — /bindings/feishu[/:agentId[/action]]
  // ──────────────────────────────────────────────────────────────────────────

  // GET /bindings — list all bindings with runtime status
  if (pathname === '/bindings' && method === 'GET') {
    const bindings = registry.list().map((b) => ({
      ...b,
      config: { ...b.config, appSecret: '[redacted]' },
      status: manager.getStatus(b.agentId),
    }));
    return json({ bindings });
  }

  // POST /bindings/feishu — create or replace a Feishu binding
  if (pathname === '/bindings/feishu' && method === 'POST') {
    let body: { agentId: string; a2aAgentUrl: string } & FeishuChannelConfig;
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { agentId, a2aAgentUrl, ...channelCfg } = body;

    if (!agentId?.trim()) return json({ error: 'Missing required field: agentId' }, 400);
    if (!a2aAgentUrl?.trim()) return json({ error: 'Missing required field: a2aAgentUrl' }, 400);
    if (!channelCfg.appId?.trim()) return json({ error: 'Missing required field: appId' }, 400);
    if (!channelCfg.appSecret?.trim()) return json({ error: 'Missing required field: appSecret' }, 400);

    // If already running, stop first so the new config takes effect
    if (manager.isRunning(agentId)) {
      manager.stop(agentId);
    }

    const binding = registry.register({
      agentId,
      a2aAgentUrl,
      channelId: 'feishu',
      config: channelCfg as FeishuChannelConfig,
    });

    // Automatically start the gateway for the new binding
    try {
      await manager.start(agentId);
    } catch (err) {
      console.error(`[server] gateway start failed for agent "${agentId}":`, err);
      return json({
        binding: { ...binding, config: { ...binding.config, appSecret: '[redacted]' } },
        started: false,
        error: safeErrorMessage(err),
      }, 207);
    }

    return json({
      binding: { ...binding, config: { ...binding.config, appSecret: '[redacted]' } },
      started: true,
      status: manager.getStatus(agentId),
    }, 201);
  }

  // Routes that require /:agentId segment: /bindings/feishu/:agentId[/action]
  const feishuBindingMatch = pathname.match(/^\/bindings\/feishu\/([^/]+)(\/[^/]+)?$/);
  if (feishuBindingMatch) {
    const agentId = decodeURIComponent(feishuBindingMatch[1]!);
    const action = feishuBindingMatch[2]; // e.g. "/start", "/stop", "/status", etc.

    // DELETE /bindings/feishu/:agentId — remove binding
    if (!action && method === 'DELETE') {
      manager.stop(agentId);
      const existed = registry.unregister(agentId);
      if (!existed) return json({ error: `No binding found for agentId "${agentId}"` }, 404);
      return json({ status: 'removed', agentId });
    }

    // All remaining actions require the binding to exist
    if (!action && method !== 'DELETE') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const binding = registry.get(agentId);
    if (!binding) {
      return json({ error: `No binding found for agentId "${agentId}"` }, 404);
    }

    // GET /bindings/feishu/:agentId/status
    if (action === '/status' && method === 'GET') {
      return json(manager.getStatus(agentId));
    }

    // POST /bindings/feishu/:agentId/start
    if (action === '/start' && method === 'POST') {
      if (manager.isRunning(agentId)) {
        return json({ status: 'already_running', agentId });
      }
      try {
        await manager.start(agentId);
        return json({ status: 'started', agentId, ...manager.getStatus(agentId) });
      } catch (err) {
        return json({ error: 'Failed to start gateway', reason: safeErrorMessage(err) }, 500);
      }
    }

    // POST /bindings/feishu/:agentId/stop
    if (action === '/stop' && method === 'POST') {
      if (!manager.isRunning(agentId)) {
        return json({ status: 'not_running', agentId });
      }
      manager.stop(agentId);
      return json({ status: 'stopped', agentId });
    }

    // POST /bindings/feishu/:agentId/restart
    if (action === '/restart' && method === 'POST') {
      try {
        await manager.restart(agentId);
        return json({ status: 'restarted', agentId, ...manager.getStatus(agentId) });
      } catch (err) {
        return json({ error: 'Failed to restart gateway', reason: safeErrorMessage(err) }, 500);
      }
    }

    // POST /bindings/feishu/:agentId/probe — test Feishu credentials
    if (action === '/probe' && method === 'POST') {
      try {
        // Import probeFeishu from the built plugin dist
        const { probeFeishu } = await import('@larksuite/openclaw-lark');
        const result = await (probeFeishu as (creds: { appId: string; appSecret: string }) => Promise<{ ok: boolean; error?: string }>)({
          appId: binding.config.appId,
          appSecret: binding.config.appSecret,
        });
        return json({ agentId, probe: result });
      } catch (err) {
        return json({
          agentId,
          probe: { ok: false, error: safeErrorMessage(err) },
        });
      }
    }

    // POST /bindings/feishu/:agentId/auth — trigger OAuth / onboarding
    if (action === '/auth' && method === 'POST') {
      let body: { userOpenId?: string; accountId?: string; locale?: string };
      try {
        body = req.headers.get('content-length') !== '0' && req.headers.get('content-type')?.includes('json')
          ? (await req.json()) as typeof body
          : {};
      } catch {
        body = {};
      }

      const entry = manager.getEntry(agentId);
      if (!entry) {
        return json({
          error: `Agent "${agentId}" is not currently running. Start it first via POST /bindings/feishu/${agentId}/start`,
        }, 409);
      }

      if (!body.userOpenId) {
        return json({
          error: 'Missing required field: userOpenId',
          hint: 'Provide the Feishu open_id of the user who should receive the OAuth authorization request.',
        }, 400);
      }

      try {
        // runFeishuAuth requires an AsyncLocalStorage ticket (getTicket()).
        // We provide a synthetic one so the function can identify the sender.
        const { runFeishuAuth } = await import('../src/commands/auth.ts');
        const { withTicket } = await import('../src/core/lark-ticket.ts');

        const locale = (body.locale ?? 'zh_cn') as 'zh_cn' | 'en_us';
        const resolvedAccountId = body.accountId ?? 'default';

        const result = await withTicket(
          {
            messageId: `http_auth_${Date.now()}`,
            chatId: 'http',
            accountId: resolvedAccountId,
            // startTime: timestamp when this HTTP request initiated the auth flow
            startTime: Date.now(),
            senderOpenId: body.userOpenId,
          },
          () => runFeishuAuth(entry.feishuCfg, locale),
        ) as string;

        return json({ agentId, accountId: resolvedAccountId, userOpenId: body.userOpenId, message: result });
      } catch (err) {
        console.error(`[server] auth error for agent "${agentId}":`, err);
        return json({
          error: 'Auth flow failed',
          reason: safeErrorMessage(err),
        }, 500);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // A2A direct access (for testing / introspection)
  // ──────────────────────────────────────────────────────────────────────────

  // GET /a2a/status?url=http://...  or uses first binding's a2aAgentUrl
  if (pathname === '/a2a/status' && method === 'GET') {
    const agentUrl =
      url.searchParams.get('url') ||
      registry.list()[0]?.a2aAgentUrl ||
      ENV_A2A_AGENT_URL;

    if (!agentUrl) {
      return json({
        enabled: false,
        message: 'Provide ?url= param or register a binding first',
      });
    }
    try {
      const runtime = createA2APluginRuntime({ agentUrl });
      const card = await runtime.a2a.getAgentCard();
      return json({ enabled: true, agentUrl, agentCard: card });
    } catch (err) {
      return json({ enabled: false, agentUrl, error: safeErrorMessage(err) }, 503);
    }
  }

  // POST /a2a/run
  if (pathname === '/a2a/run' && method === 'POST') {
    let body: {
      message: string;
      agentUrl?: string;
      sessionKey?: string;
      wait?: boolean;
      timeoutMs?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const agentUrl =
      body.agentUrl ||
      registry.list()[0]?.a2aAgentUrl ||
      ENV_A2A_AGENT_URL;

    if (!agentUrl) {
      return json(
        { error: 'No A2A agent URL. Pass "agentUrl" in body or register a binding.' },
        501,
      );
    }
    if (!body.message) return json({ error: 'Missing required field: message' }, 400);

    const runtime = createA2APluginRuntime({ agentUrl });
    const subagent = runtime.subagent as {
      run: (p: { sessionKey: string; message: string }) => Promise<{ runId: string }>;
      waitForRun: (p: { runId: string; timeoutMs?: number }) => Promise<{ status: string; error?: string }>;
      getSessionMessages: (p: { sessionKey: string }) => Promise<{ messages: unknown[] }>;
    };

    const sessionKey = body.sessionKey || `demo_session_${Date.now()}`;
    try {
      const { runId } = await subagent.run({ sessionKey, message: body.message });
      if (body.wait !== false) {
        const waitResult = await subagent.waitForRun({ runId, timeoutMs: body.timeoutMs });
        const { messages } = await subagent.getSessionMessages({ sessionKey });
        return json({ runId, sessionKey, ...waitResult, messages });
      }
      return json({ runId, sessionKey, status: 'submitted' });
    } catch (err) {
      return json({ error: 'A2A agent call failed', reason: safeErrorMessage(err) }, 502);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Feishu QR code setup flow
  // ──────────────────────────────────────────────────────────────────────────

  // GET /setup/feishu — Setup HTML page (QR code scan to bind agentId="1")
  if (pathname === '/setup/feishu' && method === 'GET') {
    const binding = registry.get(DEFAULT_SETUP_AGENT_ID);
    const alreadyRegistered = !!binding;
    const registeredStatus = alreadyRegistered ? JSON.stringify(manager.getStatus(DEFAULT_SETUP_AGENT_ID)) : undefined;
    const html = buildSetupPage({
      defaultAppId: binding?.config.appId || ENV_FEISHU_APP_ID || '',
      defaultA2aAgentUrl: binding?.a2aAgentUrl || ENV_A2A_AGENT_URL || '',
      alreadyRegistered,
      registeredStatus,
    });
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // POST /setup/feishu/start — Initiate Feishu device-flow QR session
  if (pathname === '/setup/feishu/start' && method === 'POST') {
    let body: {
      appId?: string;
      appSecret?: string;
      brand?: 'feishu' | 'lark';
      a2aAgentUrl?: string;
      scope?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const appId = body.appId?.trim() || ENV_FEISHU_APP_ID;
    const appSecret = body.appSecret?.trim() || ENV_FEISHU_APP_SECRET;

    if (!appId) return json({ error: 'Missing required field: appId' }, 400);
    if (!appSecret) return json({ error: 'Missing required field: appSecret' }, 400);

    try {
      const session = await setup.startQrFlow({
        appId,
        appSecret,
        brand: body.brand ?? (ENV_FEISHU_DOMAIN as 'feishu' | 'lark'),
        a2aAgentUrl: body.a2aAgentUrl || ENV_A2A_AGENT_URL || undefined,
        scope: body.scope,
      });
      return json({
        sessionId: session.sessionId,
        agentId: session.agentId,
        userCode: session.userCode,
        verificationUri: session.verificationUri,
        verificationUriComplete: session.verificationUriComplete,
        expiresAt: session.expiresAt,
        interval: 5,
      }, 201);
    } catch (err) {
      console.error('[server] setup QR flow failed:', err);
      return json({ error: 'Failed to start QR setup flow', reason: safeErrorMessage(err) }, 500);
    }
  }

  // GET /setup/feishu/status/:sessionId — Poll for QR session status
  const setupStatusMatch = pathname.match(/^\/setup\/feishu\/status\/([^/]+)$/);
  if (setupStatusMatch && method === 'GET') {
    const sessionId = decodeURIComponent(setupStatusMatch[1]!);
    const session = setup.getSession(sessionId);
    if (!session) {
      return json({ error: `No QR session found for sessionId "${sessionId}"` }, 404);
    }
    return json({
      sessionId: session.sessionId,
      agentId: session.agentId,
      status: session.status,
      errorMessage: session.errorMessage,
      expiresAt: session.expiresAt,
      // Include binding status if authorized
      bindingStatus: session.status === 'authorized' ? manager.getStatus(session.agentId) : null,
    });
  }

  return json({ error: 'Not Found' }, 404);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({ port: PORT, fetch: handleRequest });

// Periodically clean up expired QR sessions (every 30 minutes).
setInterval(() => setup.cleanupExpired(), 30 * 60 * 1000);

const bindingCount = registry.size;
const runningCount = manager.listEntries().filter((e) => e.plugin.gatewayRunning).length;

console.info([
  '',
  '  ╔═══════════════════════════════════════════╗',
  '  ║  OpenClaw Lark Plugin — Demo Server v2   ║',
  '  ╚═══════════════════════════════════════════╝',
  `  Echo bot     : ✅ ready`,
  `  Bindings     : ${bindingCount} registered, ${runningCount} gateway(s) running`,
  `  Server       : http://localhost:${PORT}`,
  '',
  `  Quick start:`,
  `    curl http://localhost:${PORT}/`,
  `    # QR code bot setup (scan with Feishu app):`,
  `    open http://localhost:${PORT}/setup/feishu`,
  `    # Or register via API:`,
  `    curl -X POST http://localhost:${PORT}/bindings/feishu \\`,
  `      -H 'Content-Type: application/json' \\`,
  `      -d '{"agentId":"my-agent","a2aAgentUrl":"http://localhost:4000",`,
  `          "appId":"cli_xxx","appSecret":"xxx"}'`,
  `    curl http://localhost:${PORT}/bindings`,
  '',
].join('\n'));

export default server;
