/**
 * Channel Runtime Manager
 *
 * Reads bindings from the `ChannelRegistry` and manages `LoadedPlugin`
 * lifecycle — one instance per agent-channel binding.
 *
 * Responsibilities:
 *   • `startAll()`  — boot all bindings currently in the registry
 *   • `start()`     — load the plugin for one binding and start its gateway
 *   • `stop()`      — stop the gateway for one binding
 *   • `restart()`   — stop then start
 *   • status queries — `getEntry()`, `listEntries()`, `isRunning()`
 *
 * The manager is intentionally decoupled from the HTTP server so it can
 * also be used in tests or from a CLI wrapper.
 */

import { loadPlugin } from './plugin-loader.ts';
import type { LoadedPlugin } from './plugin-loader.ts';
import type { ChannelRegistry, AgentChannelBinding } from './channel-registry.ts';

// ---------------------------------------------------------------------------
// Active channel entry
// ---------------------------------------------------------------------------

export interface ActiveChannelEntry {
  /** The binding that describes this channel. */
  binding: AgentChannelBinding;
  /** The loaded plugin instance for this binding. */
  plugin: LoadedPlugin;
  /**
   * The `ClawdbotConfig`-shaped config dict that was passed to the plugin.
   * Stored here so callers (e.g. the auth endpoint) can pass it to
   * functions that expect the full config object.
   */
  feishuCfg: Record<string, unknown>;
  /** Unix timestamp (ms) when this channel was started. */
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ChannelRuntimeManager {
  private readonly active = new Map<string, ActiveChannelEntry>();

  constructor(private readonly registry: ChannelRegistry) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start channel plugins for every binding currently in the registry.
   * Bindings that are already running are skipped.
   * Errors for individual bindings are logged but do not interrupt others.
   */
  async startAll(): Promise<void> {
    const bindings = this.registry.list();
    if (bindings.length === 0) {
      console.info('[channel-runtime] registry is empty — no channels to start');
      return;
    }
    await Promise.allSettled(
      bindings.map((b) =>
        this.start(b.agentId).catch((err) => {
          console.error(`[channel-runtime] failed to start agent "${b.agentId}":`, err);
        }),
      ),
    );
  }

  /**
   * Load the plugin and start its Feishu gateway for the given agent.
   *
   * Throws if no binding is registered for `agentId`.
   * If the channel is already running, this is a no-op.
   */
  async start(agentId: string): Promise<void> {
    const binding = this.registry.get(agentId);
    if (!binding) {
      throw new Error(`[channel-runtime] no binding registered for agent "${agentId}"`);
    }

    if (this.active.has(agentId)) {
      console.info(`[channel-runtime] agent "${agentId}" already running — skipping start`);
      return;
    }

    console.info(`[channel-runtime] starting agent "${agentId}" (channel: ${binding.channelId}) …`);

    // Build the feishu config dict (mirrors what plugin-loader.ts does)
    const cfg = binding.config;
    const feishuCfg: Record<string, unknown> = {
      channels: {
        feishu: {
          appId: cfg.appId,
          appSecret: cfg.appSecret,
          verificationToken: cfg.verificationToken ?? '',
          encryptKey: cfg.encryptKey ?? '',
          connectionMode: cfg.connectionMode ?? 'websocket',
          webhookPort: cfg.webhookPort,
          dmPolicy: cfg.dmPolicy ?? 'open',
          requireMention: cfg.requireMention ?? false,
          enabled: true,
          // 'brand' is the plugin-internal field for the Feishu/Lark domain;
          // users configure it as 'domain' in the binding for clarity.
          ...(cfg.domain ? { brand: cfg.domain } : {}),
        },
      },
    };

    const plugin = await loadPlugin({
      a2aAgentUrl: binding.a2aAgentUrl,
      feishuAccount: {
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        verificationToken: cfg.verificationToken,
        encryptKey: cfg.encryptKey,
        connectionMode: cfg.connectionMode ?? 'websocket',
        webhookPort: cfg.webhookPort,
        dmPolicy: cfg.dmPolicy ?? 'open',
        requireMention: cfg.requireMention ?? false,
      },
    });

    this.active.set(agentId, {
      binding,
      plugin,
      feishuCfg,
      startedAt: Date.now(),
    });

    // Start the gateway (non-blocking — runs in background)
    try {
      await plugin.startGateway();
      console.info(`[channel-runtime] agent "${agentId}" gateway started`);
    } catch (err) {
      // Gateway failure should not remove the entry — the plugin is still
      // loaded and can be retried via restart().
      console.error(`[channel-runtime] agent "${agentId}" gateway start error:`, err);
      throw err;
    }
  }

  /**
   * Stop the gateway for the given agent.
   * If the agent is not running, this is a no-op.
   */
  stop(agentId: string): void {
    const entry = this.active.get(agentId);
    if (!entry) {
      console.info(`[channel-runtime] agent "${agentId}" is not running — nothing to stop`);
      return;
    }
    entry.plugin.stopGateway();
    this.active.delete(agentId);
    console.info(`[channel-runtime] agent "${agentId}" stopped`);
  }

  /**
   * Stop then start the channel for the given agent.
   * The registry binding is re-read so any config updates take effect.
   */
  async restart(agentId: string): Promise<void> {
    this.stop(agentId);
    await this.start(agentId);
  }

  // -------------------------------------------------------------------------
  // Status queries
  // -------------------------------------------------------------------------

  /** Return the active entry for an agent, or `undefined`. */
  getEntry(agentId: string): ActiveChannelEntry | undefined {
    return this.active.get(agentId);
  }

  /** Return all active channel entries. */
  listEntries(): ActiveChannelEntry[] {
    return [...this.active.values()];
  }

  /** Return whether a gateway is currently running for the given agent. */
  isRunning(agentId: string): boolean {
    const entry = this.active.get(agentId);
    return entry?.plugin.gatewayRunning ?? false;
  }

  /**
   * Return a plain-object status summary for an agent.
   * Includes binding info and runtime state.
   */
  getStatus(agentId: string): {
    agentId: string;
    bound: boolean;
    running: boolean;
    gatewayRunning: boolean;
    a2aEnabled: boolean;
    startedAt: number | null;
    binding: AgentChannelBinding | null;
  } {
    const binding = this.registry.get(agentId) ?? null;
    const entry = this.active.get(agentId);
    return {
      agentId,
      bound: binding !== null,
      running: entry !== undefined,
      gatewayRunning: entry?.plugin.gatewayRunning ?? false,
      a2aEnabled: entry?.plugin.a2aEnabled ?? false,
      startedAt: entry?.startedAt ?? null,
      binding,
    };
  }
}
