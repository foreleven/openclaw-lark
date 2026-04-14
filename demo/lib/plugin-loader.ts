/**
 * Channel Plugin Loader
 *
 * Loads the `@larksuite/openclaw-lark` plugin by importing its default export
 * and calling `plugin.register(api)` with a mock OpenClawPluginApi.
 *
 * After registration the loader exposes the collected channel plugin object
 * so the demo server can interact with it (inspect capabilities, metadata,
 * simulate inbound events, etc.).
 *
 * Pass `a2aAgentUrl` to wire the plugin runtime to a real A2A-compatible
 * remote agent for sub-agent calls instead of the default no-op stubs.
 * Pass `feishuConfig` to start the Feishu WebSocket gateway so that real
 * Feishu messages are forwarded to the A2A agent and replies sent back.
 */

import { createMockPluginApi, type ChannelRegistration, type PluginRegistrationResult } from './mock-sdk.ts';
import { createA2APluginRuntime } from './a2a-plugin-runtime.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeishuAccountConfig {
  /** Feishu App ID (e.g. "cli_xxxx"). */
  appId: string;
  /** Feishu App Secret. */
  appSecret: string;
  /** Feishu verification token (for webhook mode). Optional for WebSocket mode. */
  verificationToken?: string;
  /** Feishu Encrypt Key (for webhook mode). Optional. */
  encryptKey?: string;
  /** Connection mode — defaults to "websocket". */
  connectionMode?: 'websocket' | 'webhook';
  /** Webhook port (webhook mode only). */
  webhookPort?: number;
  /** DM policy — defaults to "open" in the demo (no pairing needed). */
  dmPolicy?: 'open' | 'pairing' | 'allowlist' | 'disabled';
  /** Whether to require a bot @mention in group chats. Defaults to false. */
  requireMention?: boolean;
}

export interface PluginLoaderOptions {
  /**
   * Optional URL of a remote A2A agent.
   * When provided the plugin loader wires up the full A2A-backed runtime,
   * enabling real sub-agent calls. Omit for the minimal no-op runtime.
   */
  a2aAgentUrl?: string;

  /**
   * Optional Feishu account credentials.
   * When provided alongside `a2aAgentUrl`, the Feishu WebSocket gateway
   * can be started to receive real inbound messages and forward them to
   * the A2A agent, then send replies back via Feishu.
   */
  feishuAccount?: FeishuAccountConfig;
}

export interface LoadedPlugin {
  /** Raw registration results collected during plugin.register(). */
  registration: PluginRegistrationResult;
  /** The first channel plugin registered by the package. */
  channel: ChannelRegistration | undefined;
  /** Emit a hook event — fires all handlers registered under that name. */
  emitHook: (name: string, event: unknown, ctx: unknown) => Promise<void>;
  /** Whether the A2A runtime is active. */
  a2aEnabled: boolean;
  /**
   * Start the Feishu WebSocket gateway for the specified account.
   * Requires `feishuAccount` to have been provided at load time.
   * Returns an AbortController that can be used to stop the gateway.
   */
  startGateway: (opts?: { accountId?: string }) => Promise<AbortController>;
  /**
   * Stop the Feishu WebSocket gateway (if running).
   */
  stopGateway: () => void;
  /** Whether the gateway is currently running. */
  readonly gatewayRunning: boolean;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadPlugin(options: PluginLoaderOptions = {}): Promise<LoadedPlugin> {
  console.info('[plugin-loader] loading @larksuite/openclaw-lark …');

  // Import the plugin package — use direct path to the built dist
  // (avoids bun link resolution issues in demo environments)
  const pluginModule = await import('../../dist/index.mjs');
  const pluginDef = pluginModule.default;

  if (!pluginDef || typeof pluginDef.register !== 'function') {
    throw new Error(
      '[plugin-loader] imported module does not expose a valid plugin ' +
      '(expected default export with .register() method)',
    );
  }

  // Build the Feishu ClawdbotConfig when account credentials are provided
  let feishuCfg: Record<string, unknown> | undefined;
  if (options.feishuAccount) {
    const acct = options.feishuAccount;
    feishuCfg = {
      channels: {
        feishu: {
          appId: acct.appId,
          appSecret: acct.appSecret,
          verificationToken: acct.verificationToken ?? '',
          encryptKey: acct.encryptKey ?? '',
          connectionMode: acct.connectionMode ?? 'websocket',
          webhookPort: acct.webhookPort,
          dmPolicy: acct.dmPolicy ?? 'open',
          requireMention: acct.requireMention ?? false,
          enabled: true,
        },
      },
    };
  }

  // Choose the runtime: A2A-backed or default no-op stubs
  let runtime: Record<string, unknown> | undefined;
  let a2aEnabled = false;

  if (options.a2aAgentUrl) {
    console.info(`[plugin-loader] using A2A runtime → ${options.a2aAgentUrl}`);
    runtime = createA2APluginRuntime({
      agentUrl: options.a2aAgentUrl,
      feishuConfig: feishuCfg,
    });
    a2aEnabled = true;
  }

  // Build mock API and let the plugin register itself
  const { api, result } = createMockPluginApi({ config: feishuCfg, runtime });

  console.info('[plugin-loader] calling plugin.register() …');
  pluginDef.register(api);

  console.info(
    `[plugin-loader] registration complete — ` +
    `channels=${result.channels.length}, ` +
    `tools=${result.tools.length}, ` +
    `hooks=${result.hooks.size} hook names, ` +
    `a2a=${a2aEnabled}`,
  );

  // Helper to emit hooks
  const emitHook = async (name: string, event: unknown, ctx: unknown) => {
    const handlers = result.hooks.get(name);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        await h(event, ctx);
      } catch (err) {
        console.error(`[plugin-loader] hook "${name}" error:`, err);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Gateway management
  // ---------------------------------------------------------------------------

  let _gatewayAbort: AbortController | null = null;

  const startGateway = async (opts: { accountId?: string } = {}): Promise<AbortController> => {
    if (!options.feishuAccount) {
      throw new Error(
        '[plugin-loader] startGateway requires feishuAccount credentials. ' +
        'Set FEISHU_APP_ID and FEISHU_APP_SECRET env vars.',
      );
    }
    if (!feishuCfg) {
      throw new Error('[plugin-loader] feishuCfg not built — internal error');
    }

    if (_gatewayAbort) {
      console.warn('[plugin-loader] gateway already running, stopping previous instance');
      _gatewayAbort.abort();
    }

    const abortController = new AbortController();
    _gatewayAbort = abortController;

    const channelPlugin = result.channels[0]?.plugin;
    if (!channelPlugin?.gateway?.startAccount) {
      throw new Error('[plugin-loader] feishu plugin does not expose gateway.startAccount');
    }

    const accountId = opts.accountId ?? 'default';
    console.info(`[plugin-loader] starting Feishu gateway for account "${accountId}" …`);

    const runtimeEnv = {
      log: (...args: unknown[]) => console.info('[feishu-gateway]', ...args),
      error: (...args: unknown[]) => console.error('[feishu-gateway]', ...args),
    };

    // startAccount returns a Promise that resolves when the abort signal fires.
    // Run it in the background — the caller awaits only the startup handshake.
    channelPlugin.gateway.startAccount({
      cfg: feishuCfg,
      accountId,
      runtime: runtimeEnv,
      abortSignal: abortController.signal,
      log: runtimeEnv.log,
      setStatus: (status: unknown) => {
        console.info('[plugin-loader] gateway status:', status);
      },
    }).then(() => {
      console.info(`[plugin-loader] Feishu gateway[${accountId}] stopped`);
      if (_gatewayAbort === abortController) _gatewayAbort = null;
    }).catch((err: unknown) => {
      console.error(`[plugin-loader] Feishu gateway[${accountId}] error:`, err);
      if (_gatewayAbort === abortController) _gatewayAbort = null;
    });

    console.info(`[plugin-loader] Feishu gateway[${accountId}] starting (websocket) …`);
    return abortController;
  };

  const stopGateway = () => {
    if (_gatewayAbort) {
      console.info('[plugin-loader] stopping Feishu gateway …');
      _gatewayAbort.abort();
      _gatewayAbort = null;
    }
  };

  return {
    registration: result,
    channel: result.channels[0],
    emitHook,
    a2aEnabled,
    startGateway,
    stopGateway,
    get gatewayRunning() { return _gatewayAbort !== null; },
  };
}
