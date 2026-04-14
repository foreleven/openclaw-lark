/**
 * Lightweight mock of the `openclaw/plugin-sdk` surface used by channel plugins.
 *
 * This module serves two purposes:
 *
 * 1. `createMockPluginApi()` — the plugin host shell that the Feishu plugin calls
 *    `register(api)` on.  It collects all channel/tool/hook/command registrations
 *    so the demo server (and unit tests) can inspect and invoke them.
 *
 * 2. `buildMockPluginRuntime()` — a fully in-process runtime that implements every
 *    method the plugin reads from `api.runtime.*`.  Pure/stateless helpers are
 *    computed inline; stateful helpers (session store, activity, pairing…) use
 *    in-memory Maps so the plugin can run end-to-end without a real database or
 *    an external A2A agent.
 *
 *    When a real A2A agent IS available, `plugin-loader.ts` replaces this runtime
 *    with the one from `a2a-plugin-runtime.ts`; this file then only provides the
 *    host-API half.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Minimal type stubs (mirrors the real SDK just enough for the plugin)
// ---------------------------------------------------------------------------

export type OpenClawConfig = Record<string, unknown>;
/** @deprecated Alias kept for backward compatibility. Use {@link OpenClawConfig} instead. */
export type ClawdbotConfig = OpenClawConfig;
export type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: unknown };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => { ok: boolean; errors?: string[] };
  uiHints?: Record<string, unknown>;
  jsonSchema?: Record<string, unknown>;
};

export type ChannelPlugin<T = unknown> = {
  id: string;
  meta: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Warn once when a method is truly not available in the mock environment. */
function notAvailable(name: string) {
  return (..._args: unknown[]) => {
    console.warn(`[mock-sdk] ${name} — not available in standalone mock (requires external service)`);
    return undefined as never;
  };
}

/** Ensure a directory exists, creating it (recursively) if needed. */
function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ---------------------------------------------------------------------------
// Control-command set (mirrors the real SDK defaults)
// ---------------------------------------------------------------------------

const CONTROL_COMMANDS = new Set(['/new', '/reset', '/clear', '/help', '/stop', '/cancel']);

// ---------------------------------------------------------------------------
// Text chunking helpers (pure, no external deps)
// ---------------------------------------------------------------------------

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

function chunkByNewline(text: string, maxLen: number): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      out.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [text];
}

// ---------------------------------------------------------------------------
// PluginRuntime mock — fully in-process implementation
// ---------------------------------------------------------------------------

function buildMockPluginRuntime(opts?: {
  /** Override config returned by loadConfig(). Defaults to {}. */
  loadConfig?: () => OpenClawConfig;
  /** Base directory for workspace/session files. */
  workspaceBaseDir?: string;
}): Record<string, unknown> {
  const workspaceBaseDir =
    opts?.workspaceBaseDir ?? path.join(os.tmpdir(), 'openclaw-mock', 'workspaces');
  const loadConfig = opts?.loadConfig ?? (() => ({} as OpenClawConfig));

  // ---------------------------------------------------------------------------
  // In-memory stores (per runtime instance)
  // ---------------------------------------------------------------------------

  const sessions = new Map<string, unknown>();
  const activityStore = new Map<string, { channelId: string; accountId?: string; ts: number }>();
  const pairingRequests = new Map<string, { channel: string; accountId: string; userId: string; approved: boolean }>();
  const allowFrom = new Map<string, Set<string>>(); // `channel:accountId` → Set<userId>
  const runtimeContextRegistry = new Map<
    string,
    { value: unknown; watchers: Array<(v: unknown) => void> }
  >();
  const threadIdleTimeouts = new Map<string, number>();
  const threadMaxAges = new Map<string, number>();
  const inboundSessionMeta = new Map<
    string,
    { channelId: string; sessionKey: string; updatedAt: number; route?: unknown }
  >();

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const config = {
    loadConfig,
    writeConfigFile: (cfg: unknown) => {
      const dir = ensureDir(path.join(workspaceBaseDir, 'config'));
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    },
  };

  // ---------------------------------------------------------------------------
  // Agent
  // ---------------------------------------------------------------------------

  const agent = {
    defaults: { model: 'mock-model', provider: 'mock-provider' },
    resolveAgentDir: (agentId: string) =>
      ensureDir(path.join(workspaceBaseDir, 'agents', agentId)),
    resolveAgentWorkspaceDir: (agentId: string) =>
      ensureDir(path.join(workspaceBaseDir, 'agents', agentId, 'workspace')),
    resolveAgentIdentity: (_agentId: string): unknown => null,
    resolveThinkingDefault: (_cfg: unknown): unknown => null,
    runEmbeddedPiAgent: notAvailable('runtime.agent.runEmbeddedPiAgent'),
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: (agentId: string) => {
      const dir = ensureDir(path.join(workspaceBaseDir, 'agents', agentId));
      return { dir };
    },
    session: {
      resolveStorePath: (sessionKey: string) =>
        path.join(ensureDir(path.join(workspaceBaseDir, 'sessions')), `${sessionKey}.json`),
      loadSessionStore: async (sessionKey: string): Promise<unknown> => {
        const p = path.join(workspaceBaseDir, 'sessions', `${sessionKey}.json`);
        try {
          return JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
        } catch {
          return null;
        }
      },
      saveSessionStore: async (sessionKey: string, data: unknown): Promise<void> => {
        const dir = ensureDir(path.join(workspaceBaseDir, 'sessions'));
        fs.writeFileSync(path.join(dir, `${sessionKey}.json`), JSON.stringify(data, null, 2), 'utf8');
      },
      resolveSessionFilePath: (sessionKey: string, filename: string) =>
        path.join(
          ensureDir(path.join(workspaceBaseDir, 'sessions', sessionKey)),
          filename,
        ),
    },
  };

  // ---------------------------------------------------------------------------
  // System
  // ---------------------------------------------------------------------------

  const system = {
    enqueueSystemEvent: (event: unknown) => {
      console.debug('[mock-sdk] system.enqueueSystemEvent:', JSON.stringify(event));
    },
    requestHeartbeatNow: () => {
      console.debug('[mock-sdk] system.requestHeartbeatNow called');
    },
    runHeartbeatOnce: async (_opts?: unknown) => {
      return { ran: false, reason: 'mock' };
    },
    runCommandWithTimeout: async (cmd: string, args: string[], timeoutMs?: number) => {
      const { spawn } = await import('node:child_process');
      return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        const proc = spawn(cmd, args, { timeout: timeoutMs ?? 30_000 });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => resolve({ stdout, stderr, code }));
        proc.on('error', (err) => resolve({ stdout, stderr: String(err), code: -1 }));
      });
    },
    formatNativeDependencyHint: (dep: string) =>
      `Install missing dependency: ${dep}\n  npm install ${dep}`,
  };

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  const media = {
    loadWebMedia: async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`loadWebMedia: HTTP ${res.status} for ${url}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), url };
    },
    detectMime: (buffer: Buffer): string => {
      const b = buffer.subarray(0, 4);
      if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
      if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
      if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'audio/wav';
      return 'application/octet-stream';
    },
    mediaKindFromMime: (mime: string) => {
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime.startsWith('video/')) return 'video';
      return 'file';
    },
    isVoiceCompatibleAudio: (mime: string) =>
      ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm'].includes(mime),
    getImageMetadata: async (_buffer: Buffer) => ({ width: 0, height: 0 }),
    resizeToJpeg: async (buffer: Buffer, _opts?: unknown) => buffer,
  };

  // ---------------------------------------------------------------------------
  // Channel — text utilities (pure)
  // ---------------------------------------------------------------------------

  const channelText = {
    chunkText: (text: string, maxLen = 4000) => chunkText(text, maxLen),
    chunkByNewline: (text: string, maxLen = 4000) => chunkByNewline(text, maxLen),
    chunkMarkdownText: (text: string, maxLen = 4000) => chunkText(text, maxLen),
    chunkMarkdownTextWithMode: (text: string, _mode: unknown, maxLen = 4000) => chunkText(text, maxLen),
    chunkTextWithMode: (text: string, _mode: unknown, maxLen = 4000) => chunkText(text, maxLen),
    resolveChunkMode: (_cfg?: unknown) => 'newline' as const,
    resolveTextChunkLimit: (_cfg?: unknown, _channel?: string, _accountId?: string, opts?: { fallbackLimit?: number }) =>
      opts?.fallbackLimit ?? 4000,
    hasControlCommand: (text: string) => {
      const t = text.trim().toLowerCase();
      return CONTROL_COMMANDS.has(t) || t.startsWith('/');
    },
    resolveMarkdownTableMode: (_opts?: unknown) => 'markdown' as const,
    convertMarkdownTables: (text: string) => text,
  };

  // ---------------------------------------------------------------------------
  // Channel — commands (pure)
  // ---------------------------------------------------------------------------

  const channelCommands = {
    isControlCommandMessage: (text: string) => {
      const t = (text ?? '').trim().toLowerCase();
      return CONTROL_COMMANDS.has(t) || t.startsWith('/');
    },
    shouldComputeCommandAuthorized: (_cfg: unknown) => true,
    shouldHandleTextCommands: (_cfg: unknown) => true,
    resolveCommandAuthorizedFromAuthorizers: async (
      _authorizers: unknown[],
      _ctx: unknown,
    ) => true,
  };

  // ---------------------------------------------------------------------------
  // Channel — routing (pure)
  // ---------------------------------------------------------------------------

  const channelRouting = {
    buildAgentSessionKey: (params: {
      channelId: string;
      accountId?: string;
      target: string;
      agentId?: string;
    }) =>
      [
        params.channelId,
        params.accountId ?? 'default',
        params.target,
        params.agentId ?? 'default',
      ].join(':'),

    resolveAgentRoute: (params: {
      channelId: string;
      target: string;
      cfg: unknown;
      agentId?: string;
    }) => ({
      agentId: params.agentId ?? 'default',
      channelId: params.channelId,
      target: params.target,
    }),
  };

  // ---------------------------------------------------------------------------
  // Channel — session (in-memory)
  // ---------------------------------------------------------------------------

  const channelSession = {
    resolveStorePath: (sessionKey: string) =>
      path.join(ensureDir(path.join(workspaceBaseDir, 'channel-sessions')), `${sessionKey}.json`),
    readSessionUpdatedAt: (sessionKey: string) =>
      inboundSessionMeta.get(sessionKey)?.updatedAt ?? null,
    recordSessionMetaFromInbound: (
      params: { sessionKey: string; channelId: string; route?: unknown },
    ) => {
      inboundSessionMeta.set(params.sessionKey, {
        channelId: params.channelId,
        sessionKey: params.sessionKey,
        updatedAt: Date.now(),
        route: params.route,
      });
    },
    recordInboundSession: (
      params: { sessionKey: string; channelId: string; route?: unknown },
    ) => {
      inboundSessionMeta.set(params.sessionKey, {
        channelId: params.channelId,
        sessionKey: params.sessionKey,
        updatedAt: Date.now(),
        route: params.route,
      });
      // persist lightweight record
      const dir = ensureDir(path.join(workspaceBaseDir, 'channel-sessions'));
      try {
        fs.writeFileSync(
          path.join(dir, `${params.sessionKey}.json`),
          JSON.stringify({ ...params, updatedAt: Date.now() }, null, 2),
          'utf8',
        );
      } catch {
        // best-effort
      }
    },
    updateLastRoute: (params: { sessionKey: string; route: unknown }) => {
      const existing = inboundSessionMeta.get(params.sessionKey);
      if (existing) {
        inboundSessionMeta.set(params.sessionKey, {
          ...existing,
          route: params.route,
          updatedAt: Date.now(),
        });
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Channel — activity (in-memory)
  // ---------------------------------------------------------------------------

  const channelActivity = {
    record: (params: { channelId: string; accountId?: string }) => {
      const key = `${params.channelId}:${params.accountId ?? 'default'}`;
      activityStore.set(key, { channelId: params.channelId, accountId: params.accountId, ts: Date.now() });
    },
    get: (params: { channelId: string; accountId?: string }) => {
      const key = `${params.channelId}:${params.accountId ?? 'default'}`;
      return activityStore.get(key) ?? null;
    },
  };

  // ---------------------------------------------------------------------------
  // Channel — pairing (in-memory)
  // ---------------------------------------------------------------------------

  const channelPairing = {
    buildPairingReply: (params: { accepted: boolean; channelId: string }) =>
      params.accepted
        ? '✅ Pairing approved. You can now send messages.'
        : '❌ Pairing request was not approved.',

    readAllowFromStore: (params: { channel: string; accountId: string }): unknown => {
      const key = `${params.channel}:${params.accountId}`;
      return Array.from(allowFrom.get(key) ?? []);
    },

    upsertPairingRequest: (params: {
      channel: string;
      accountId: string;
      userId: string;
      approved?: boolean;
    }): void => {
      const storeKey = `${params.channel}:${params.accountId}:${params.userId}`;
      pairingRequests.set(storeKey, {
        channel: params.channel,
        accountId: params.accountId,
        userId: params.userId,
        approved: params.approved ?? false,
      });
      if (params.approved) {
        const k = `${params.channel}:${params.accountId}`;
        if (!allowFrom.has(k)) allowFrom.set(k, new Set());
        allowFrom.get(k)!.add(params.userId);
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Channel — media
  // ---------------------------------------------------------------------------

  const channelMedia = {
    fetchRemoteMedia: async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetchRemoteMedia: HTTP ${res.status} for ${url}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
    saveMediaBuffer: async (buffer: Buffer, filename: string) => {
      const dir = ensureDir(path.join(workspaceBaseDir, 'media'));
      const p = path.join(dir, filename);
      fs.writeFileSync(p, buffer);
      return { path: p };
    },
  };

  // ---------------------------------------------------------------------------
  // Channel — mentions (simple prefix/pattern matching)
  // ---------------------------------------------------------------------------

  const channelMentions = {
    buildMentionRegexes: (patterns: string[]): RegExp[] =>
      patterns.map((p) => new RegExp(p, 'i')),
    matchesMentionPatterns: (text: string, patterns: RegExp[]): boolean =>
      patterns.some((r) => r.test(text)),
    matchesMentionWithExplicit: (
      text: string,
      patterns: RegExp[],
      explicit: string[],
    ): boolean =>
      explicit.some((e) => text.toLowerCase().includes(e.toLowerCase())) ||
      patterns.some((r) => r.test(text)),
    implicitMentionKindWhen: (_cfg: unknown) => 'none' as const,
    resolveInboundMentionDecision: (_params: unknown): unknown => ({
      shouldReply: true,
      reason: 'mock',
    }),
  };

  // ---------------------------------------------------------------------------
  // Channel — reactions (sensible defaults)
  // ---------------------------------------------------------------------------

  const channelReactions = {
    shouldAckReaction: (_cfg: unknown) => false,
    removeAckReactionAfterReply: (_cfg: unknown) => false,
  };

  // ---------------------------------------------------------------------------
  // Channel — groups (sensible defaults)
  // ---------------------------------------------------------------------------

  const channelGroups = {
    resolveGroupPolicy: (_cfg: unknown) => 'open' as const,
    resolveRequireMention: (_cfg: unknown) => false,
  };

  // ---------------------------------------------------------------------------
  // Channel — debounce (no-op: immediate delivery)
  // ---------------------------------------------------------------------------

  const channelDebounce = {
    createInboundDebouncer: (handler: (...args: unknown[]) => unknown) => handler,
    resolveInboundDebounceMs: (_cfg: unknown) => 0,
  };

  // ---------------------------------------------------------------------------
  // Channel — outbound (stub — real impl needs provider-specific adapters)
  // ---------------------------------------------------------------------------

  const channelOutbound = {
    loadAdapter: notAvailable('runtime.channel.outbound.loadAdapter'),
  };

  // ---------------------------------------------------------------------------
  // Channel — threadBindings (in-memory)
  // ---------------------------------------------------------------------------

  const channelThreadBindings = {
    setIdleTimeoutBySessionKey: (sessionKey: string, timeoutMs: number) => {
      threadIdleTimeouts.set(sessionKey, timeoutMs);
    },
    setMaxAgeBySessionKey: (sessionKey: string, maxAgeMs: number) => {
      threadMaxAges.set(sessionKey, maxAgeMs);
    },
  };

  // ---------------------------------------------------------------------------
  // Channel — runtimeContexts (in-memory registry)
  // ---------------------------------------------------------------------------

  const channelRuntimeContexts = {
    register: (key: string, initialValue: unknown) => {
      if (!runtimeContextRegistry.has(key)) {
        runtimeContextRegistry.set(key, { value: initialValue, watchers: [] });
      }
    },
    get: (key: string): unknown => runtimeContextRegistry.get(key)?.value ?? null,
    watch: (key: string, callback: (value: unknown) => void) => {
      if (!runtimeContextRegistry.has(key)) {
        runtimeContextRegistry.set(key, { value: null, watchers: [] });
      }
      runtimeContextRegistry.get(key)!.watchers.push(callback);
      // Return an unsubscribe function
      return () => {
        const entry = runtimeContextRegistry.get(key);
        if (entry) {
          entry.watchers = entry.watchers.filter((w) => w !== callback);
        }
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Channel — reply (in-process implementations)
  // ---------------------------------------------------------------------------

  const channelReply = {
    /**
     * Finalize an inbound context by adding the required `CommandAuthorized` field.
     * This is a pure transform — no I/O required.
     */
    finalizeInboundContext: (ctx: Record<string, unknown>, _opts?: unknown) => ({
      CommandAuthorized: false,
      ...ctx,
    }),

    /**
     * Dispatch reply from config — no agent backend, so we log a warning and
     * return a "no-op" completed result.  Replace this runtime with
     * `a2a-plugin-runtime.ts` when a real agent is needed.
     */
    dispatchReplyFromConfig: async (params: {
      ctx: Record<string, unknown>;
      cfg: Record<string, unknown>;
      dispatcher: {
        sendFinalReply: (payload: Record<string, unknown>) => boolean;
        markComplete: () => void;
        waitForIdle: () => Promise<void>;
        getQueuedCounts: () => Record<string, number>;
        getFailedCounts: () => Record<string, number>;
      };
      replyOptions?: Record<string, unknown>;
    }): Promise<{ queuedFinal: boolean; counts: Record<string, number> }> => {
      console.warn(
        '[mock-sdk] channel.reply.dispatchReplyFromConfig called — no agent backend. ' +
        'Set A2A_AGENT_URL to forward messages to a real agent.',
      );
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    },

    /**
     * Buffered-block dispatcher — same stub as dispatchReplyFromConfig.
     */
    dispatchReplyWithBufferedBlockDispatcher: async (params: {
      ctx: Record<string, unknown>;
      cfg: Record<string, unknown>;
      dispatcherOptions: {
        deliver: (payload: Record<string, unknown>, info: { kind: string }) => Promise<void>;
        onSkip?: (payload: unknown, info: { reason: string; kind: string }) => void;
      };
      replyOptions?: Record<string, unknown>;
    }): Promise<{ queuedFinal: boolean; counts: Record<string, number> }> => {
      console.warn('[mock-sdk] channel.reply.dispatchReplyWithBufferedBlockDispatcher — no agent backend.');
      params.dispatcherOptions.onSkip?.({ text: '' }, { reason: 'no_backend', kind: 'final' });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    },

    /**
     * Create a minimal dispatcher with optional typing callbacks.
     */
    createReplyDispatcherWithTyping: (options: {
      deliver: (payload: Record<string, unknown>, info: { kind: string }) => Promise<void>;
      onError?: (err: unknown, info: { kind: string }) => void;
      onIdle?: () => void;
      onCleanup?: () => void;
    }) => {
      const pending: Promise<void>[] = [];
      const queued = { tool: 0, block: 0, final: 0 };
      const failed = { tool: 0, block: 0, final: 0 };
      let completed = false;

      const enqueue = (payload: Record<string, unknown>, kind: 'tool' | 'block' | 'final') => {
        if (completed) return false;
        queued[kind]++;
        const p = options.deliver(payload, { kind }).catch((err) => {
          failed[kind]++;
          options.onError?.(err, { kind });
        });
        pending.push(p);
        return true;
      };

      const dispatcher = {
        sendFinalReply: (payload: Record<string, unknown>) => enqueue(payload, 'final'),
        sendBlockReply: (payload: Record<string, unknown>) => enqueue(payload, 'block'),
        sendToolResult: (payload: Record<string, unknown>) => enqueue(payload, 'tool'),
        waitForIdle: async () => {
          await Promise.allSettled(pending);
          options.onIdle?.();
        },
        getQueuedCounts: () => ({ ...queued }),
        getFailedCounts: () => ({ ...failed }),
        markComplete: () => { completed = true; },
      };

      return {
        dispatcher,
        replyOptions: {},
        markDispatchIdle: () => { options.onIdle?.(); },
        markRunComplete: () => {},
        markFullyComplete: () => { dispatcher.markComplete(); },
        abortCard: async () => {},
      };
    },

    resolveEffectiveMessagesConfig: (_cfg: unknown) => ({ maxMessages: 20, maxTokens: 8192 }),
    resolveHumanDelayConfig: (_cfg: unknown) => ({ enabled: false, minMs: 0, maxMs: 0 }),

    withReplyDispatcher: async (params: {
      dispatcher: Record<string, unknown>;
      run: () => Promise<unknown>;
      onSettled?: () => void | Promise<void>;
    }) => {
      try {
        return await params.run();
      } finally {
        await params.onSettled?.();
      }
    },

    formatAgentEnvelope: (params: { prompt: string; [k: string]: unknown }) =>
      `[envelope] ${params.prompt}`,
    formatInboundEnvelope: (params: { prompt: string; [k: string]: unknown }) =>
      `[inbound] ${params.prompt}`,
    resolveEnvelopeFormatOptions: () => ({ includeTimestamp: false, includeChannel: true }),
  };

  // ---------------------------------------------------------------------------
  // Channel — assemble
  // ---------------------------------------------------------------------------

  const channel = {
    text: channelText,
    reply: channelReply,
    routing: channelRouting,
    pairing: channelPairing,
    media: channelMedia,
    activity: channelActivity,
    session: channelSession,
    mentions: channelMentions,
    reactions: channelReactions,
    groups: channelGroups,
    debounce: channelDebounce,
    commands: channelCommands,
    outbound: channelOutbound,
    threadBindings: channelThreadBindings,
    runtimeContexts: channelRuntimeContexts,
  };

  // ---------------------------------------------------------------------------
  // Subagent stubs (no agent backend — warn clearly)
  // ---------------------------------------------------------------------------

  const subagent = {
    run: async (_params: unknown): Promise<{ runId: string }> => {
      console.warn(
        '[mock-sdk] subagent.run called — no agent backend. Set A2A_AGENT_URL to enable.',
      );
      return { runId: `mock_run_${Date.now()}` };
    },
    waitForRun: async (_params: unknown): Promise<{ status: 'error'; error: string }> => {
      return { status: 'error', error: 'No agent backend configured (set A2A_AGENT_URL)' };
    },
    getSessionMessages: async (_params: unknown): Promise<{ messages: unknown[] }> => {
      return { messages: [] };
    },
    getSession: async (_params: unknown): Promise<{ messages: unknown[] }> => {
      return { messages: [] };
    },
    deleteSession: async (_params: unknown): Promise<void> => {
      // no-op
    },
  };

  // ---------------------------------------------------------------------------
  // TTS / media understanding / image generation (require external services)
  // ---------------------------------------------------------------------------

  const tts = {
    textToSpeech: notAvailable('runtime.tts.textToSpeech'),
    textToSpeechTelephony: notAvailable('runtime.tts.textToSpeechTelephony'),
    listVoices: notAvailable('runtime.tts.listVoices'),
  };

  const mediaUnderstanding = {
    runFile: notAvailable('runtime.mediaUnderstanding.runFile'),
    describeImageFile: notAvailable('runtime.mediaUnderstanding.describeImageFile'),
    describeImageFileWithModel: notAvailable('runtime.mediaUnderstanding.describeImageFileWithModel'),
    describeVideoFile: notAvailable('runtime.mediaUnderstanding.describeVideoFile'),
    transcribeAudioFile: notAvailable('runtime.mediaUnderstanding.transcribeAudioFile'),
  };

  const imageGeneration = {
    generate: notAvailable('runtime.imageGeneration.generate'),
  };

  return {
    version: '0.0.0-mock',
    config,
    agent,
    system,
    media,
    channel,
    subagent,
    tts,
    mediaUnderstanding,
    imageGeneration,
  };
}

// ---------------------------------------------------------------------------
// Registration stores — collected during plugin.register(api)
// ---------------------------------------------------------------------------

export interface ChannelRegistration {
  plugin: ChannelPlugin;
}

export interface ToolRegistration {
  tool: unknown;
  opts?: unknown;
}

export interface HttpRouteRegistration {
  method: string;
  path: string;
  handler: (...args: unknown[]) => unknown;
}

export interface PluginRegistrationResult {
  channels: ChannelRegistration[];
  tools: ToolRegistration[];
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  commands: unknown[];
  cliRegistrars: unknown[];
  httpRoutes: HttpRouteRegistration[];
}

// ---------------------------------------------------------------------------
// Mock OpenClawPluginApi builder
// ---------------------------------------------------------------------------

export function createMockPluginApi(
  overrides?: Partial<{
    config: OpenClawConfig;
    runtime: Record<string, unknown>;
    workspaceBaseDir: string;
  }>,
): { api: Record<string, unknown>; result: PluginRegistrationResult } {
  const channels: ChannelRegistration[] = [];
  const tools: ToolRegistration[] = [];
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands: unknown[] = [];
  const cliRegistrars: unknown[] = [];
  const httpRoutes: HttpRouteRegistration[] = [];

  const config: OpenClawConfig = overrides?.config ?? {};

  const logger: PluginLogger = {
    debug: (msg) => console.debug(`[plugin:debug] ${msg}`),
    info: (msg) => console.info(`[plugin:info] ${msg}`),
    warn: (msg) => console.warn(`[plugin:warn] ${msg}`),
    error: (msg) => console.error(`[plugin:error] ${msg}`),
  };

  /** Return value when `notAvailable` is called inside the API (not runtime). */
  function apiNotAvailable(name: string) {
    return (..._args: unknown[]) => {
      console.warn(`[mock-sdk] api.${name} — not available in standalone mock`);
      return undefined as never;
    };
  }

  const api: Record<string, unknown> = {
    id: 'openclaw-lark',
    name: 'Feishu',
    version: '0.0.0-mock',
    description: 'Mock plugin host',
    source: 'mock',
    rootDir: process.cwd(),
    registrationMode: 'native',
    config,
    pluginConfig: {},
    runtime: overrides?.runtime ?? buildMockPluginRuntime({
      loadConfig: () => config,
      workspaceBaseDir: overrides?.workspaceBaseDir,
    }),
    logger,

    // ---- Registration methods (fully implemented) ----

    registerChannel: (registration: ChannelRegistration | ChannelPlugin) => {
      let channelReg: ChannelRegistration;
      if ('plugin' in registration && typeof (registration as ChannelRegistration).plugin === 'object') {
        channelReg = registration as ChannelRegistration;
      } else {
        channelReg = { plugin: registration as ChannelPlugin };
      }
      channels.push(channelReg);
      console.info(`[plugin-loader] channel registered: ${channelReg.plugin.id}`);
    },

    registerTool: (tool: unknown, opts?: unknown) => {
      tools.push({ tool, opts });
    },

    registerHook: (events: string | string[], handler: (...args: unknown[]) => unknown) => {
      const names = Array.isArray(events) ? events : [events];
      for (const name of names) {
        if (!hooks.has(name)) hooks.set(name, []);
        hooks.get(name)!.push(handler);
      }
    },

    /**
     * registerHttpRoute — stores the route for webhook-mode support.
     * The demo server can inspect `result.httpRoutes` and mount them.
     */
    registerHttpRoute: (
      method: string,
      routePath: string,
      handler: (...args: unknown[]) => unknown,
    ) => {
      httpRoutes.push({ method: method.toUpperCase(), path: routePath, handler });
      console.info(`[plugin-loader] HTTP route registered: ${method.toUpperCase()} ${routePath}`);
    },

    registerGatewayMethod: apiNotAvailable('registerGatewayMethod'),

    registerCli: (registrar: unknown) => {
      cliRegistrars.push(registrar);
    },

    registerReload: apiNotAvailable('registerReload'),
    registerNodeHostCommand: apiNotAvailable('registerNodeHostCommand'),
    registerSecurityAuditCollector: apiNotAvailable('registerSecurityAuditCollector'),
    registerService: apiNotAvailable('registerService'),
    registerCliBackend: apiNotAvailable('registerCliBackend'),
    registerConfigMigration: apiNotAvailable('registerConfigMigration'),
    registerAutoEnableProbe: apiNotAvailable('registerAutoEnableProbe'),
    registerProvider: apiNotAvailable('registerProvider'),
    registerSpeechProvider: apiNotAvailable('registerSpeechProvider'),
    registerRealtimeTranscriptionProvider: apiNotAvailable('registerRealtimeTranscriptionProvider'),
    registerRealtimeVoiceProvider: apiNotAvailable('registerRealtimeVoiceProvider'),
    registerMediaUnderstandingProvider: apiNotAvailable('registerMediaUnderstandingProvider'),
    registerImageGenerationProvider: apiNotAvailable('registerImageGenerationProvider'),
    registerVideoGenerationProvider: apiNotAvailable('registerVideoGenerationProvider'),
    registerMusicGenerationProvider: apiNotAvailable('registerMusicGenerationProvider'),
    registerWebFetchProvider: apiNotAvailable('registerWebFetchProvider'),
    registerWebSearchProvider: apiNotAvailable('registerWebSearchProvider'),
    registerInteractiveHandler: apiNotAvailable('registerInteractiveHandler'),
    onConversationBindingResolved: apiNotAvailable('onConversationBindingResolved'),
    registerCommand: (command: unknown) => {
      commands.push(command);
    },
    registerContextEngine: apiNotAvailable('registerContextEngine'),
    registerCompactionProvider: apiNotAvailable('registerCompactionProvider'),
    registerMemoryCapability: apiNotAvailable('registerMemoryCapability'),
    registerMemoryPromptSection: apiNotAvailable('registerMemoryPromptSection'),
    registerMemoryPromptSupplement: apiNotAvailable('registerMemoryPromptSupplement'),
    registerMemoryCorpusSupplement: apiNotAvailable('registerMemoryCorpusSupplement'),
    registerMemoryFlushPlan: apiNotAvailable('registerMemoryFlushPlan'),
    registerMemoryRuntime: apiNotAvailable('registerMemoryRuntime'),
    registerMemoryEmbeddingProvider: apiNotAvailable('registerMemoryEmbeddingProvider'),
    resolvePath: (input: string) => input,

    on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
      if (!hooks.has(hookName)) hooks.set(hookName, []);
      hooks.get(hookName)!.push(handler);
    },
  };

  return { api, result: { channels, tools, hooks, commands, cliRegistrars, httpRoutes } };
}

// ---------------------------------------------------------------------------
// emptyPluginConfigSchema (re-exported so the plugin's import resolves)
// ---------------------------------------------------------------------------

export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  };
}

// ---------------------------------------------------------------------------
// Re-export buildMockPluginRuntime for callers that need to compose runtimes
// ---------------------------------------------------------------------------

export { buildMockPluginRuntime };
