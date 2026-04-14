/**
 * Lightweight mock of the `openclaw/plugin-sdk` surface used by channel plugins.
 *
 * Only the pieces actually exercised by `@larksuite/openclaw-lark` at
 * registration time are implemented here. Everything else is a no-op stub
 * so the plugin can call `register(api)` without crashing.
 */

import type { EventEmitter } from 'node:events';

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
// PluginRuntime mock — the plugin reads `api.runtime.*` in register()
// ---------------------------------------------------------------------------

function notImplemented(name: string) {
  return (..._args: unknown[]) => {
    console.warn(`[mock-sdk] ${name} called — not implemented in demo`);
    return undefined as never;
  };
}

function buildMockPluginRuntime(): Record<string, unknown> {
  const config = {
    loadConfig: () => ({} as OpenClawConfig),
    writeConfigFile: notImplemented('runtime.config.writeConfigFile'),
  };

  const agent = {
    defaults: { model: 'mock-model', provider: 'mock-provider' },
    resolveAgentDir: notImplemented('runtime.agent.resolveAgentDir'),
    resolveAgentWorkspaceDir: notImplemented('runtime.agent.resolveAgentWorkspaceDir'),
    resolveAgentIdentity: notImplemented('runtime.agent.resolveAgentIdentity'),
    resolveThinkingDefault: notImplemented('runtime.agent.resolveThinkingDefault'),
    runEmbeddedPiAgent: notImplemented('runtime.agent.runEmbeddedPiAgent'),
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: notImplemented('runtime.agent.ensureAgentWorkspace'),
    session: {
      resolveStorePath: notImplemented('runtime.agent.session.resolveStorePath'),
      loadSessionStore: notImplemented('runtime.agent.session.loadSessionStore'),
      saveSessionStore: notImplemented('runtime.agent.session.saveSessionStore'),
      resolveSessionFilePath: notImplemented('runtime.agent.session.resolveSessionFilePath'),
    },
  };

  const system = {
    enqueueSystemEvent: notImplemented('runtime.system.enqueueSystemEvent'),
    requestHeartbeatNow: notImplemented('runtime.system.requestHeartbeatNow'),
    runHeartbeatOnce: notImplemented('runtime.system.runHeartbeatOnce'),
    runCommandWithTimeout: notImplemented('runtime.system.runCommandWithTimeout'),
    formatNativeDependencyHint: notImplemented('runtime.system.formatNativeDependencyHint'),
  };

  const media = {
    loadWebMedia: notImplemented('runtime.media.loadWebMedia'),
    detectMime: notImplemented('runtime.media.detectMime'),
    mediaKindFromMime: notImplemented('runtime.media.mediaKindFromMime'),
    isVoiceCompatibleAudio: notImplemented('runtime.media.isVoiceCompatibleAudio'),
    getImageMetadata: notImplemented('runtime.media.getImageMetadata'),
    resizeToJpeg: notImplemented('runtime.media.resizeToJpeg'),
  };

  const channel = {
    text: {
      chunkByNewline: notImplemented('runtime.channel.text.chunkByNewline'),
      chunkMarkdownText: notImplemented('runtime.channel.text.chunkMarkdownText'),
      chunkMarkdownTextWithMode: notImplemented('runtime.channel.text.chunkMarkdownTextWithMode'),
      chunkText: notImplemented('runtime.channel.text.chunkText'),
      chunkTextWithMode: notImplemented('runtime.channel.text.chunkTextWithMode'),
      resolveChunkMode: notImplemented('runtime.channel.text.resolveChunkMode'),
      resolveTextChunkLimit: notImplemented('runtime.channel.text.resolveTextChunkLimit'),
      hasControlCommand: notImplemented('runtime.channel.text.hasControlCommand'),
      resolveMarkdownTableMode: notImplemented('runtime.channel.text.resolveMarkdownTableMode'),
      convertMarkdownTables: notImplemented('runtime.channel.text.convertMarkdownTables'),
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: notImplemented('runtime.channel.reply.dispatchReply'),
      createReplyDispatcherWithTyping: notImplemented('runtime.channel.reply.createReplyDispatcher'),
      resolveEffectiveMessagesConfig: notImplemented('runtime.channel.reply.resolveEffectiveMessagesConfig'),
      resolveHumanDelayConfig: notImplemented('runtime.channel.reply.resolveHumanDelayConfig'),
      dispatchReplyFromConfig: notImplemented('runtime.channel.reply.dispatchReplyFromConfig'),
      withReplyDispatcher: notImplemented('runtime.channel.reply.withReplyDispatcher'),
      finalizeInboundContext: notImplemented('runtime.channel.reply.finalizeInboundContext'),
      formatAgentEnvelope: notImplemented('runtime.channel.reply.formatAgentEnvelope'),
      formatInboundEnvelope: notImplemented('runtime.channel.reply.formatInboundEnvelope'),
      resolveEnvelopeFormatOptions: notImplemented('runtime.channel.reply.resolveEnvelopeFormatOptions'),
    },
    routing: {
      buildAgentSessionKey: notImplemented('runtime.channel.routing.buildAgentSessionKey'),
      resolveAgentRoute: notImplemented('runtime.channel.routing.resolveAgentRoute'),
    },
    pairing: {
      buildPairingReply: notImplemented('runtime.channel.pairing.buildPairingReply'),
      readAllowFromStore: notImplemented('runtime.channel.pairing.readAllowFromStore'),
      upsertPairingRequest: notImplemented('runtime.channel.pairing.upsertPairingRequest'),
    },
    media: {
      fetchRemoteMedia: notImplemented('runtime.channel.media.fetchRemoteMedia'),
      saveMediaBuffer: notImplemented('runtime.channel.media.saveMediaBuffer'),
    },
    activity: {
      record: notImplemented('runtime.channel.activity.record'),
      get: notImplemented('runtime.channel.activity.get'),
    },
    session: {
      resolveStorePath: notImplemented('runtime.channel.session.resolveStorePath'),
      readSessionUpdatedAt: notImplemented('runtime.channel.session.readSessionUpdatedAt'),
      recordSessionMetaFromInbound: notImplemented('runtime.channel.session.recordSessionMetaFromInbound'),
      recordInboundSession: notImplemented('runtime.channel.session.recordInboundSession'),
      updateLastRoute: notImplemented('runtime.channel.session.updateLastRoute'),
    },
    mentions: {
      buildMentionRegexes: notImplemented('runtime.channel.mentions.buildMentionRegexes'),
      matchesMentionPatterns: notImplemented('runtime.channel.mentions.matchesMentionPatterns'),
      matchesMentionWithExplicit: notImplemented('runtime.channel.mentions.matchesMentionWithExplicit'),
      implicitMentionKindWhen: notImplemented('runtime.channel.mentions.implicitMentionKindWhen'),
      resolveInboundMentionDecision: notImplemented('runtime.channel.mentions.resolveInboundMentionDecision'),
    },
    reactions: {
      shouldAckReaction: notImplemented('runtime.channel.reactions.shouldAckReaction'),
      removeAckReactionAfterReply: notImplemented('runtime.channel.reactions.removeAckReactionAfterReply'),
    },
    groups: {
      resolveGroupPolicy: notImplemented('runtime.channel.groups.resolveGroupPolicy'),
      resolveRequireMention: notImplemented('runtime.channel.groups.resolveRequireMention'),
    },
    debounce: {
      createInboundDebouncer: notImplemented('runtime.channel.debounce.createInboundDebouncer'),
      resolveInboundDebounceMs: notImplemented('runtime.channel.debounce.resolveInboundDebounceMs'),
    },
    commands: {
      resolveCommandAuthorizedFromAuthorizers: notImplemented('runtime.channel.commands.resolveCommandAuthorized'),
      isControlCommandMessage: notImplemented('runtime.channel.commands.isControlCommandMessage'),
      shouldComputeCommandAuthorized: notImplemented('runtime.channel.commands.shouldComputeCommandAuthorized'),
      shouldHandleTextCommands: notImplemented('runtime.channel.commands.shouldHandleTextCommands'),
    },
    outbound: {
      loadAdapter: notImplemented('runtime.channel.outbound.loadAdapter'),
    },
    threadBindings: {
      setIdleTimeoutBySessionKey: notImplemented('runtime.channel.threadBindings.setIdleTimeoutBySessionKey'),
      setMaxAgeBySessionKey: notImplemented('runtime.channel.threadBindings.setMaxAgeBySessionKey'),
    },
    runtimeContexts: {
      register: notImplemented('runtime.channel.runtimeContexts.register'),
      get: notImplemented('runtime.channel.runtimeContexts.get'),
      watch: notImplemented('runtime.channel.runtimeContexts.watch'),
    },
  };

  const subagent = {
    run: notImplemented('runtime.subagent.run'),
    waitForRun: notImplemented('runtime.subagent.waitForRun'),
    getSessionMessages: notImplemented('runtime.subagent.getSessionMessages'),
    getSession: notImplemented('runtime.subagent.getSession'),
    deleteSession: notImplemented('runtime.subagent.deleteSession'),
  };

  return {
    version: '0.0.0-demo',
    config,
    agent,
    system,
    media,
    channel,
    subagent,
    tts: {
      textToSpeech: notImplemented('runtime.tts.textToSpeech'),
      textToSpeechTelephony: notImplemented('runtime.tts.textToSpeechTelephony'),
      listVoices: notImplemented('runtime.tts.listVoices'),
    },
    mediaUnderstanding: {
      runFile: notImplemented('runtime.mediaUnderstanding.runFile'),
      describeImageFile: notImplemented('runtime.mediaUnderstanding.describeImageFile'),
      describeImageFileWithModel: notImplemented('runtime.mediaUnderstanding.describeImageFileWithModel'),
      describeVideoFile: notImplemented('runtime.mediaUnderstanding.describeVideoFile'),
      transcribeAudioFile: notImplemented('runtime.mediaUnderstanding.transcribeAudioFile'),
    },
    imageGeneration: {
      generate: notImplemented('runtime.imageGeneration.generate'),
    },
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

export interface PluginRegistrationResult {
  channels: ChannelRegistration[];
  tools: ToolRegistration[];
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  commands: unknown[];
  cliRegistrars: unknown[];
}

// ---------------------------------------------------------------------------
// Mock OpenClawPluginApi builder
// ---------------------------------------------------------------------------

export function createMockPluginApi(
  overrides?: Partial<{ config: OpenClawConfig; runtime: Record<string, unknown> }>,
): { api: Record<string, unknown>; result: PluginRegistrationResult } {
  const channels: ChannelRegistration[] = [];
  const tools: ToolRegistration[] = [];
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands: unknown[] = [];
  const cliRegistrars: unknown[] = [];

  const config: OpenClawConfig = overrides?.config ?? {};

  const logger: PluginLogger = {
    debug: (msg) => console.debug(`[plugin:debug] ${msg}`),
    info: (msg) => console.info(`[plugin:info] ${msg}`),
    warn: (msg) => console.warn(`[plugin:warn] ${msg}`),
    error: (msg) => console.error(`[plugin:error] ${msg}`),
  };

  const api: Record<string, unknown> = {
    id: 'openclaw-lark',
    name: 'Feishu',
    version: '0.0.0-demo',
    description: 'Demo plugin host',
    source: 'demo',
    rootDir: process.cwd(),
    registrationMode: 'native',
    config,
    pluginConfig: {},
    runtime: overrides?.runtime ?? buildMockPluginRuntime(),
    logger,

    // ---- Registration methods ----

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

    registerHttpRoute: notImplemented('api.registerHttpRoute'),
    registerGatewayMethod: notImplemented('api.registerGatewayMethod'),

    registerCli: (registrar: unknown) => {
      cliRegistrars.push(registrar);
    },

    registerReload: notImplemented('api.registerReload'),
    registerNodeHostCommand: notImplemented('api.registerNodeHostCommand'),
    registerSecurityAuditCollector: notImplemented('api.registerSecurityAuditCollector'),
    registerService: notImplemented('api.registerService'),
    registerCliBackend: notImplemented('api.registerCliBackend'),
    registerConfigMigration: notImplemented('api.registerConfigMigration'),
    registerAutoEnableProbe: notImplemented('api.registerAutoEnableProbe'),
    registerProvider: notImplemented('api.registerProvider'),
    registerSpeechProvider: notImplemented('api.registerSpeechProvider'),
    registerRealtimeTranscriptionProvider: notImplemented('api.registerRealtimeTranscriptionProvider'),
    registerRealtimeVoiceProvider: notImplemented('api.registerRealtimeVoiceProvider'),
    registerMediaUnderstandingProvider: notImplemented('api.registerMediaUnderstandingProvider'),
    registerImageGenerationProvider: notImplemented('api.registerImageGenerationProvider'),
    registerVideoGenerationProvider: notImplemented('api.registerVideoGenerationProvider'),
    registerMusicGenerationProvider: notImplemented('api.registerMusicGenerationProvider'),
    registerWebFetchProvider: notImplemented('api.registerWebFetchProvider'),
    registerWebSearchProvider: notImplemented('api.registerWebSearchProvider'),
    registerInteractiveHandler: notImplemented('api.registerInteractiveHandler'),
    onConversationBindingResolved: notImplemented('api.onConversationBindingResolved'),
    registerCommand: (command: unknown) => {
      commands.push(command);
    },
    registerContextEngine: notImplemented('api.registerContextEngine'),
    registerCompactionProvider: notImplemented('api.registerCompactionProvider'),
    registerMemoryCapability: notImplemented('api.registerMemoryCapability'),
    registerMemoryPromptSection: notImplemented('api.registerMemoryPromptSection'),
    registerMemoryPromptSupplement: notImplemented('api.registerMemoryPromptSupplement'),
    registerMemoryCorpusSupplement: notImplemented('api.registerMemoryCorpusSupplement'),
    registerMemoryFlushPlan: notImplemented('api.registerMemoryFlushPlan'),
    registerMemoryRuntime: notImplemented('api.registerMemoryRuntime'),
    registerMemoryEmbeddingProvider: notImplemented('api.registerMemoryEmbeddingProvider'),
    resolvePath: (input: string) => input,

    on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
      if (!hooks.has(hookName)) hooks.set(hookName, []);
      hooks.get(hookName)!.push(handler);
    },
  };

  return { api, result: { channels, tools, hooks, commands, cliRegistrars } };
}

// ---------------------------------------------------------------------------
// emptyPluginConfigSchema (re-exported so the plugin's import resolves)
// ---------------------------------------------------------------------------

export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse: (value: unknown) => ({ success: true, data: value }),
  };
}
