/**
 * A2A Plugin Runtime
 *
 * A full implementation of the `PluginRuntime` interface that uses the
 * Agent-to-Agent (A2A) protocol to delegate sub-agent calls to remote
 * A2A-compliant agents, and fills in all other previously-stubbed methods
 * with proper in-process logic.
 *
 * Usage:
 *   import { createA2APluginRuntime } from './lib/a2a-plugin-runtime.ts';
 *   const runtime = createA2APluginRuntime({ agentUrl: 'http://localhost:4000' });
 *
 * The `runtime` object can then be passed to `createMockPluginApi` via its
 * `overrides.runtime` option, replacing the fully-stubbed default runtime.
 */

import { A2AClient, A2ACardResolver, TaskState, Role } from 'a2a-js';
import type { Task } from 'a2a-js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2APluginRuntimeOptions {
  /**
   * URL of the A2A-compatible remote agent (e.g. "http://localhost:4000").
   * Used for all `subagent.*` calls.
   */
  agentUrl: string;

  /**
   * Optional base directory for agent workspaces.
   * Defaults to `<os.tmpdir()>/openclaw-demo/workspaces`.
   */
  workspaceBaseDir?: string;

  /**
   * Poll interval in ms when waiting for a task to complete.
   * Defaults to 500ms.
   */
  pollIntervalMs?: number;

  /**
   * Default timeout for `subagent.waitForRun()` in ms.
   * Defaults to 60_000 (60 s).
   */
  defaultWaitTimeoutMs?: number;

  /**
   * Logger — defaults to console.
   */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ---------------------------------------------------------------------------
// In-memory stores (replace file-backed store stubs)
// ---------------------------------------------------------------------------

type ActivityRecord = { channelId: string; accountId?: string; ts: number };
type PairingEntry = { channel: string; accountId: string; userId: string; approved: boolean };
type SessionMeta = { channelId: string; sessionKey: string; updatedAt: number; route?: unknown };

// Shared in-memory stores — per runtime instance
function createInMemoryStores() {
  const activity = new Map<string, ActivityRecord>();
  const pairingRequests = new Map<string, PairingEntry>();
  const allowFrom = new Map<string, Set<string>>(); // channel:accountId → Set<userId>
  const sessions = new Map<string, SessionMeta>();

  // session key  → task IDs (most recent last)
  const sessionTasks = new Map<string, string[]>();
  // task ID → task object (local cache)
  const taskCache = new Map<string, Task>();

  return { activity, pairingRequests, allowFrom, sessions, sessionTasks, taskCache };
}

// ---------------------------------------------------------------------------
// Terminal A2A task states
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set<string>([
  TaskState.Completed,
  TaskState.Canceled,
  TaskState.Failed,
  TaskState.Unknown,
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createA2APluginRuntime(options: A2APluginRuntimeOptions): Record<string, unknown> {
  const {
    agentUrl,
    workspaceBaseDir = path.join(os.tmpdir(), 'openclaw-demo', 'workspaces'),
    pollIntervalMs = 500,
    defaultWaitTimeoutMs = 60_000,
    log = {
      info: (msg: string) => console.info(`[a2a-runtime] ${msg}`),
      warn: (msg: string) => console.warn(`[a2a-runtime] ${msg}`),
      error: (msg: string) => console.error(`[a2a-runtime] ${msg}`),
    },
  } = options;

  const client = new A2AClient(agentUrl);
  const cardResolver = new A2ACardResolver(agentUrl);
  const stores = createInMemoryStores();

  // ---------------------------------------------------------------------------
  // Subagent — A2A-backed agent dispatch
  // ---------------------------------------------------------------------------

  const subagent = {
    /**
     * Start a new agent run by submitting a task to the remote A2A agent.
     *
     * Maps:
     *   sessionKey    → A2A sessionId (groups related tasks)
     *   message       → A2A TextPart user message
     *   idempotencyKey → A2A task id (reuse existing task when set)
     */
    run: async (params: {
      sessionKey: string;
      message: string;
      provider?: string;
      model?: string;
      extraSystemPrompt?: string;
      lane?: string;
      deliver?: boolean;
      idempotencyKey?: string;
    }): Promise<{ runId: string }> => {
      const taskId = params.idempotencyKey ?? crypto.randomUUID();
      log.info(
        `subagent.run: sessionKey=${params.sessionKey} taskId=${taskId}` +
          (params.model ? ` model=${params.model}` : ''),
      );

      const metadata: Record<string, unknown> = {
        sessionKey: params.sessionKey,
      };
      if (params.model) metadata.model = params.model;
      if (params.provider) metadata.provider = params.provider;
      if (params.extraSystemPrompt) metadata.extraSystemPrompt = params.extraSystemPrompt;
      if (params.lane) metadata.lane = params.lane;

      const task = await client.sendTask({
        id: taskId,
        sessionId: params.sessionKey,
        message: {
          role: Role.User,
          parts: [{ type: 'text', text: params.message }],
        },
        historyLength: 20,
        metadata,
      });

      if (task) {
        stores.taskCache.set(taskId, task);
        const existing = stores.sessionTasks.get(params.sessionKey) ?? [];
        if (!existing.includes(taskId)) {
          stores.sessionTasks.set(params.sessionKey, [...existing, taskId]);
        }
      }

      return { runId: taskId };
    },

    /**
     * Wait for a run to reach a terminal state by polling the A2A agent.
     */
    waitForRun: async (params: {
      runId: string;
      timeoutMs?: number;
    }): Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string }> => {
      const timeoutMs = params.timeoutMs ?? defaultWaitTimeoutMs;
      const deadline = Date.now() + timeoutMs;

      log.info(`subagent.waitForRun: runId=${params.runId} timeout=${timeoutMs}ms`);

      while (Date.now() < deadline) {
        let task: Task | null = null;
        try {
          task = await client.getTask({ id: params.runId, historyLength: 0 });
        } catch (err) {
          log.warn(`subagent.waitForRun: getTask failed — ${err}`);
        }

        if (!task) {
          return { status: 'error', error: 'Task not found' };
        }

        stores.taskCache.set(params.runId, task);
        const state = task.status.state as string;

        if (TERMINAL_STATES.has(state)) {
          if (state === TaskState.Completed) return { status: 'ok' };
          if (state === TaskState.Canceled) return { status: 'error', error: 'Task was canceled' };
          const errorMsg =
            task.status.message?.parts
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join(' ') ?? `Task ${state}`;
          return { status: 'error', error: errorMsg };
        }

        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      return { status: 'timeout' };
    },

    /**
     * Retrieve messages for a session by querying the most recent task.
     */
    getSessionMessages: async (params: {
      sessionKey: string;
      limit?: number;
    }): Promise<{ messages: unknown[] }> => {
      log.info(`subagent.getSessionMessages: sessionKey=${params.sessionKey}`);
      const taskIds = stores.sessionTasks.get(params.sessionKey) ?? [];

      if (taskIds.length === 0) return { messages: [] };

      // Use the latest task in the session (length > 0 is guaranteed by the check above)
      const latestTaskId = taskIds[taskIds.length - 1] as string;
      let task: Task | null = stores.taskCache.get(latestTaskId) ?? null;

      if (!task) {
        try {
          task = await client.getTask({
            id: latestTaskId,
            historyLength: params.limit ?? 50,
          });
          if (task) stores.taskCache.set(latestTaskId, task);
        } catch (err) {
          log.warn(`subagent.getSessionMessages: getTask failed — ${err}`);
        }
      }

      const history = task?.history ?? [];
      const messages = history.map((msg) => ({
        role: msg.role,
        content: msg.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join(''),
        metadata: msg.metadata,
      }));

      return { messages: params.limit ? messages.slice(-params.limit) : messages };
    },

    /** @deprecated Use getSessionMessages. */
    getSession: async (params: { sessionKey: string; limit?: number }) =>
      subagent.getSessionMessages(params),

    /**
     * Cancel all tasks in a session.
     */
    deleteSession: async (params: {
      sessionKey: string;
      deleteTranscript?: boolean;
    }): Promise<void> => {
      log.info(`subagent.deleteSession: sessionKey=${params.sessionKey}`);
      const taskIds = stores.sessionTasks.get(params.sessionKey) ?? [];

      await Promise.allSettled(
        taskIds.map((id) =>
          client.cancelTask({ id }).catch((err) => {
            log.warn(`subagent.deleteSession: cancelTask(${id}) failed — ${err}`);
          }),
        ),
      );

      stores.sessionTasks.delete(params.sessionKey);
      for (const id of taskIds) stores.taskCache.delete(id);
    },
  };

  // ---------------------------------------------------------------------------
  // Channel utilities
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

  const CONTROL_COMMANDS = new Set(['/new', '/reset', '/clear', '/help', '/stop', '/cancel']);

  const channelText = {
    chunkText: (text: string, maxLen = 4000) => chunkText(text, maxLen),
    chunkByNewline: (text: string, maxLen = 4000) => chunkByNewline(text, maxLen),
    chunkMarkdownText: (text: string, maxLen = 4000) => chunkText(text, maxLen),
    chunkMarkdownTextWithMode: (text: string, _mode: unknown, maxLen = 4000) =>
      chunkText(text, maxLen),
    chunkTextWithMode: (text: string, _mode: unknown, maxLen = 4000) => chunkText(text, maxLen),
    resolveChunkMode: () => 'newline',
    resolveTextChunkLimit: () => 4000,
    hasControlCommand: (text: string) => {
      const trimmed = text.trim().toLowerCase();
      return CONTROL_COMMANDS.has(trimmed) || trimmed.startsWith('/');
    },
    resolveMarkdownTableMode: () => 'markdown',
    convertMarkdownTables: (text: string) => text, // passthrough in demo
  };

  // ---------------------------------------------------------------------------
  // Channel reply (basic wiring — real dispatching still goes through feishu SDK)
  // ---------------------------------------------------------------------------

  const channelReply = {
    dispatchReplyWithBufferedBlockDispatcher: (..._args: unknown[]) => {
      log.warn('channel.reply.dispatchReplyWithBufferedBlockDispatcher — no-op in demo');
      return Promise.resolve();
    },
    createReplyDispatcherWithTyping: (..._args: unknown[]) => {
      log.warn('channel.reply.createReplyDispatcherWithTyping — no-op in demo');
      return undefined;
    },
    resolveEffectiveMessagesConfig: (_cfg: unknown) => ({ maxMessages: 20, maxTokens: 8192 }),
    resolveHumanDelayConfig: (_cfg: unknown) => ({ enabled: false, minMs: 0, maxMs: 0 }),
    dispatchReplyFromConfig: (..._args: unknown[]) => {
      log.warn('channel.reply.dispatchReplyFromConfig — no-op in demo');
      return Promise.resolve();
    },
    withReplyDispatcher: (..._args: unknown[]) => {
      log.warn('channel.reply.withReplyDispatcher — no-op in demo');
      return Promise.resolve();
    },
    finalizeInboundContext: (ctx: unknown) => ctx,
    formatAgentEnvelope: (params: { prompt: string; [k: string]: unknown }) =>
      `[envelope] ${params.prompt}`,
    formatInboundEnvelope: (params: { prompt: string; [k: string]: unknown }) =>
      `[inbound] ${params.prompt}`,
    resolveEnvelopeFormatOptions: () => ({ includeTimestamp: false, includeChannel: true }),
  };

  // ---------------------------------------------------------------------------
  // Channel routing
  // ---------------------------------------------------------------------------

  const channelRouting = {
    buildAgentSessionKey: (params: {
      channelId: string;
      accountId?: string;
      target: string;
      agentId?: string;
    }) =>
      [params.channelId, params.accountId ?? 'default', params.target, params.agentId ?? 'default']
        .join(':'),

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
  // Channel pairing (in-memory)
  // ---------------------------------------------------------------------------

  const channelPairing = {
    buildPairingReply: (params: { accepted: boolean; channelId: string }) =>
      params.accepted
        ? '✅ Pairing approved. You can now send messages.'
        : '❌ Pairing request was not approved.',

    readAllowFromStore: (params: {
      channel: string;
      accountId: string;
      env?: unknown;
    }): unknown => {
      const key = `${params.channel}:${params.accountId}`;
      return Array.from(stores.allowFrom.get(key) ?? []);
    },

    upsertPairingRequest: (params: {
      channel: string;
      accountId: string;
      userId: string;
      approved?: boolean;
    }): void => {
      const storeKey = `${params.channel}:${params.accountId}:${params.userId}`;
      stores.pairingRequests.set(storeKey, {
        channel: params.channel,
        accountId: params.accountId,
        userId: params.userId,
        approved: params.approved ?? false,
      });
      if (params.approved) {
        const k = `${params.channel}:${params.accountId}`;
        if (!stores.allowFrom.has(k)) stores.allowFrom.set(k, new Set());
        stores.allowFrom.get(k)!.add(params.userId);
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Channel media (passthrough stubs — real impl needs the Feishu SDK)
  // ---------------------------------------------------------------------------

  const channelMedia = {
    fetchRemoteMedia: async (url: string) => {
      log.info(`channel.media.fetchRemoteMedia: ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetchRemoteMedia: HTTP ${res.status} for ${url}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
    saveMediaBuffer: async (buffer: Buffer, filename: string) => {
      const dir = path.join(os.tmpdir(), 'openclaw-demo', 'media');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, filename);
      fs.writeFileSync(dest, buffer);
      log.info(`channel.media.saveMediaBuffer: saved to ${dest}`);
      return { path: dest };
    },
  };

  // ---------------------------------------------------------------------------
  // Channel activity (in-memory log)
  // ---------------------------------------------------------------------------

  const channelActivity = {
    record: (params: { channelId: string; accountId?: string }) => {
      const key = `${params.channelId}:${params.accountId ?? 'default'}`;
      stores.activity.set(key, {
        channelId: params.channelId,
        accountId: params.accountId,
        ts: Date.now(),
      });
    },
    get: (params: { channelId: string; accountId?: string }) => {
      const key = `${params.channelId}:${params.accountId ?? 'default'}`;
      return stores.activity.get(key) ?? null;
    },
  };

  // ---------------------------------------------------------------------------
  // Channel session (in-memory store)
  // ---------------------------------------------------------------------------

  const sessionsDir = path.join(os.tmpdir(), 'openclaw-demo', 'sessions');

  const channelSession = {
    resolveStorePath: (sessionKey: string) => {
      fs.mkdirSync(sessionsDir, { recursive: true });
      return path.join(sessionsDir, `${sessionKey}.json`);
    },
    readSessionUpdatedAt: (sessionKey: string): number | null => {
      const meta = stores.sessions.get(sessionKey);
      return meta?.updatedAt ?? null;
    },
    recordSessionMetaFromInbound: (params: {
      channelId: string;
      sessionKey: string;
      updatedAt?: number;
    }) => {
      stores.sessions.set(params.sessionKey, {
        channelId: params.channelId,
        sessionKey: params.sessionKey,
        updatedAt: params.updatedAt ?? Date.now(),
      });
    },
    recordInboundSession: (params: {
      channelId: string;
      sessionKey: string;
      updatedAt?: number;
    }) => {
      stores.sessions.set(params.sessionKey, {
        channelId: params.channelId,
        sessionKey: params.sessionKey,
        updatedAt: params.updatedAt ?? Date.now(),
      });
    },
    updateLastRoute: (params: { sessionKey: string; route: unknown }) => {
      const existing = stores.sessions.get(params.sessionKey);
      if (existing) {
        existing.route = params.route;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Channel mentions
  // ---------------------------------------------------------------------------

  const channelMentions = {
    buildMentionRegexes: (mentions: Array<{ name: string }>) =>
      mentions.map((m) => new RegExp(`@${m.name}`, 'i')),

    matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
      patterns.some((p) => p.test(text)),

    matchesMentionWithExplicit: (text: string, patterns: RegExp[], explicit: boolean) =>
      explicit || patterns.some((p) => p.test(text)),

    implicitMentionKindWhen: (_chatType: string) => 'none',

    resolveInboundMentionDecision: (params: {
      text: string;
      mentionedBot: boolean;
      chatType: string;
    }) => ({
      shouldProcess: params.mentionedBot || params.chatType === 'p2p',
      reason: params.chatType === 'p2p' ? 'dm' : params.mentionedBot ? 'mention' : 'skipped',
    }),
  };

  // ---------------------------------------------------------------------------
  // Channel reactions
  // ---------------------------------------------------------------------------

  const channelReactions = {
    shouldAckReaction: (_params: unknown) => false,
    removeAckReactionAfterReply: (_params: unknown) => Promise.resolve(),
  };

  // ---------------------------------------------------------------------------
  // Channel groups
  // ---------------------------------------------------------------------------

  const channelGroups = {
    resolveGroupPolicy: (_cfg: unknown, _groupId: string) => ({
      allowAll: true,
      allowFrom: [],
      requireMention: false,
    }),
    resolveRequireMention: (_cfg: unknown, _groupId: string) => false,
  };

  // ---------------------------------------------------------------------------
  // Channel debounce
  // ---------------------------------------------------------------------------

  const channelDebounce = {
    createInboundDebouncer: (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      return {
        debounce: (fn: () => void) => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(fn, ms);
        },
        flush: () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        },
      };
    },
    resolveInboundDebounceMs: (_cfg: unknown) => 0,
  };

  // ---------------------------------------------------------------------------
  // Channel commands
  // ---------------------------------------------------------------------------

  const channelCommands = {
    resolveCommandAuthorizedFromAuthorizers: (_params: unknown) => true,
    isControlCommandMessage: (text: string) =>
      typeof text === 'string' && (text.startsWith('/') || CONTROL_COMMANDS.has(text.trim())),
    shouldComputeCommandAuthorized: () => true,
    shouldHandleTextCommands: () => true,
  };

  // ---------------------------------------------------------------------------
  // Channel outbound
  // ---------------------------------------------------------------------------

  const channelOutbound = {
    loadAdapter: (_params: unknown) => {
      log.warn('channel.outbound.loadAdapter — not available in demo');
      return undefined;
    },
  };

  // ---------------------------------------------------------------------------
  // Channel thread bindings (in-memory)
  // ---------------------------------------------------------------------------

  const threadBindingStore = new Map<
    string,
    { boundAt: number; lastActivityAt: number; idleTimeoutMs?: number; maxAgeMs?: number }
  >();

  function makeBindingKey(params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string;
  }) {
    return `${params.channelId}:${params.accountId ?? 'default'}:${params.targetSessionKey}`;
  }

  const channelThreadBindings = {
    setIdleTimeoutBySessionKey: (params: {
      channelId: string;
      targetSessionKey: string;
      accountId?: string;
      idleTimeoutMs: number;
    }) => {
      const key = makeBindingKey(params);
      const existing = threadBindingStore.get(key);
      const record = existing ?? { boundAt: Date.now(), lastActivityAt: Date.now() };
      record.idleTimeoutMs = params.idleTimeoutMs;
      record.lastActivityAt = Date.now();
      threadBindingStore.set(key, record);
      return [record];
    },
    setMaxAgeBySessionKey: (params: {
      channelId: string;
      targetSessionKey: string;
      accountId?: string;
      maxAgeMs: number;
    }) => {
      const key = makeBindingKey(params);
      const existing = threadBindingStore.get(key);
      const record = existing ?? { boundAt: Date.now(), lastActivityAt: Date.now() };
      record.maxAgeMs = params.maxAgeMs;
      record.lastActivityAt = Date.now();
      threadBindingStore.set(key, record);
      return [record];
    },
  };

  // ---------------------------------------------------------------------------
  // Runtime contexts (in-memory registry)
  // ---------------------------------------------------------------------------

  const runtimeContextMap = new Map<string, unknown>();

  const runtimeContexts = {
    register: (params: {
      channelId: string;
      accountId?: string | null;
      capability: string;
      context: unknown;
      abortSignal?: AbortSignal;
    }) => {
      const key = `${params.channelId}:${params.accountId ?? ''}:${params.capability}`;
      runtimeContextMap.set(key, params.context);
      const dispose = () => runtimeContextMap.delete(key);
      if (params.abortSignal) params.abortSignal.addEventListener('abort', dispose);
      return { dispose };
    },
    get: <T = unknown>(params: {
      channelId: string;
      accountId?: string | null;
      capability: string;
    }): T | undefined => {
      const key = `${params.channelId}:${params.accountId ?? ''}:${params.capability}`;
      return runtimeContextMap.get(key) as T | undefined;
    },
    watch: (params: {
      channelId?: string;
      accountId?: string | null;
      capability?: string;
      onEvent: (event: unknown) => void;
    }) => {
      // In-memory: no dynamic events. Return a no-op unsubscribe.
      void params; // suppress unused warning
      return () => {};
    },
  };

  // ---------------------------------------------------------------------------
  // Full channel object
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
    runtimeContexts,
  };

  // ---------------------------------------------------------------------------
  // Agent workspace helpers
  // ---------------------------------------------------------------------------

  function ensureDir(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const agentRuntime = {
    defaults: { model: 'a2a-remote', provider: 'a2a' },

    resolveAgentDir: (agentId: string) =>
      ensureDir(path.join(workspaceBaseDir, 'agents', agentId)),

    resolveAgentWorkspaceDir: (agentId: string, sessionKey?: string) =>
      ensureDir(
        path.join(
          workspaceBaseDir,
          'agents',
          agentId,
          'workspaces',
          sessionKey ?? 'default',
        ),
      ),

    resolveAgentIdentity: async (_cfg: unknown, agentId: string) => {
      // Try to resolve via agent card; fall back to agentId
      try {
        const card = await cardResolver.getAgentCard();
        return { agentId, name: card.name ?? agentId, description: card.description ?? '' };
      } catch {
        return { agentId, name: agentId };
      }
    },

    resolveThinkingDefault: (_cfg: unknown) => false,

    runEmbeddedPiAgent: (..._args: unknown[]) => {
      log.warn('runtime.agent.runEmbeddedPiAgent — not available in demo');
      return Promise.reject(new Error('runEmbeddedPiAgent not available in demo'));
    },

    resolveAgentTimeoutMs: (_cfg: unknown, _agentId?: string) => defaultWaitTimeoutMs,

    ensureAgentWorkspace: (agentId: string) => {
      const dir = ensureDir(path.join(workspaceBaseDir, 'agents', agentId));
      return { dir };
    },

    session: {
      resolveStorePath: (sessionKey: string) => {
        const dir = ensureDir(path.join(workspaceBaseDir, 'sessions'));
        return path.join(dir, `${sessionKey}.json`);
      },
      loadSessionStore: async (sessionKey: string) => {
        const p = path.join(workspaceBaseDir, 'sessions', `${sessionKey}.json`);
        try {
          const raw = fs.readFileSync(p, 'utf8');
          return JSON.parse(raw) as unknown;
        } catch {
          return null;
        }
      },
      saveSessionStore: async (sessionKey: string, data: unknown) => {
        const dir = ensureDir(path.join(workspaceBaseDir, 'sessions'));
        const p = path.join(dir, `${sessionKey}.json`);
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
      },
      resolveSessionFilePath: (sessionKey: string, filename: string) => {
        const dir = ensureDir(path.join(workspaceBaseDir, 'sessions', sessionKey));
        return path.join(dir, filename);
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const configRuntime = {
    loadConfig: () => ({} as Record<string, unknown>),
    writeConfigFile: (_cfg: unknown) => {
      log.warn('runtime.config.writeConfigFile — no-op in demo');
    },
  };

  // ---------------------------------------------------------------------------
  // System
  // ---------------------------------------------------------------------------

  const systemRuntime = {
    enqueueSystemEvent: (event: unknown) => {
      log.info(`runtime.system.enqueueSystemEvent: ${JSON.stringify(event)}`);
    },
    requestHeartbeatNow: () => {
      log.info('runtime.system.requestHeartbeatNow called');
    },
    runHeartbeatOnce: async (_opts?: unknown) => {
      log.info('runtime.system.runHeartbeatOnce called');
      return { ran: false, reason: 'demo' };
    },
    runCommandWithTimeout: async (cmd: string, args: string[], timeoutMs?: number) => {
      log.info(`runtime.system.runCommandWithTimeout: ${cmd} ${args.join(' ')} (timeout=${timeoutMs ?? 30000}ms)`);
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

  const mediaRuntime = {
    loadWebMedia: async (url: string) => {
      log.info(`runtime.media.loadWebMedia: ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`loadWebMedia: HTTP ${res.status}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), url };
    },
    detectMime: (buffer: Buffer): string => {
      // Basic magic-byte detection
      const bytes = buffer.subarray(0, 4);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
      if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
      if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)
        return 'audio/wav';
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
  // TTS stubs (require external service — logged warnings)
  // ---------------------------------------------------------------------------

  const ttsRuntime = {
    textToSpeech: async (_params: unknown) => {
      log.warn('runtime.tts.textToSpeech — not available in demo');
      return null;
    },
    textToSpeechTelephony: async (_params: unknown) => {
      log.warn('runtime.tts.textToSpeechTelephony — not available in demo');
      return null;
    },
    listVoices: async (_params: unknown) => {
      log.warn('runtime.tts.listVoices — not available in demo');
      return { voices: [] };
    },
  };

  // ---------------------------------------------------------------------------
  // Media understanding stubs
  // ---------------------------------------------------------------------------

  const mediaUnderstandingRuntime = {
    runFile: async (_params: unknown) => {
      log.warn('runtime.mediaUnderstanding.runFile — not available in demo');
      return null;
    },
    describeImageFile: async (_params: unknown) => {
      log.warn('runtime.mediaUnderstanding.describeImageFile — not available in demo');
      return { description: '' };
    },
    describeImageFileWithModel: async (_params: unknown) => {
      log.warn('runtime.mediaUnderstanding.describeImageFileWithModel — not available in demo');
      return { description: '' };
    },
    describeVideoFile: async (_params: unknown) => {
      log.warn('runtime.mediaUnderstanding.describeVideoFile — not available in demo');
      return { description: '' };
    },
    transcribeAudioFile: async (_params: unknown) => {
      log.warn('runtime.mediaUnderstanding.transcribeAudioFile — not available in demo');
      return { text: '' };
    },
  };

  // ---------------------------------------------------------------------------
  // Image generation stubs
  // ---------------------------------------------------------------------------

  const imageGenerationRuntime = {
    generate: async (_params: unknown) => {
      log.warn('runtime.imageGeneration.generate — not available in demo');
      return null;
    },
  };

  // ---------------------------------------------------------------------------
  // Expose A2A-specific utilities
  // ---------------------------------------------------------------------------

  /**
   * Expose the underlying A2AClient and session stores for advanced use cases.
   * Not part of the standard PluginRuntime interface.
   */
  const a2a = {
    client,
    cardResolver,
    getAgentCard: () => cardResolver.getAgentCard(),
    getSessionTaskIds: (sessionKey: string) =>
      stores.sessionTasks.get(sessionKey) ?? [],
    getCachedTask: (taskId: string) => stores.taskCache.get(taskId) ?? null,
  };

  // ---------------------------------------------------------------------------
  // Assemble the full PluginRuntime
  // ---------------------------------------------------------------------------

  return {
    version: '0.0.0-a2a-demo',
    config: configRuntime,
    agent: agentRuntime,
    system: systemRuntime,
    media: mediaRuntime,
    channel,
    subagent,
    tts: ttsRuntime,
    mediaUnderstanding: mediaUnderstandingRuntime,
    imageGeneration: imageGenerationRuntime,
    /** A2A-specific extensions (not part of standard PluginRuntime). */
    a2a,
  };
}
