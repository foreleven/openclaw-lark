/**
 * Channel Registry
 *
 * In-memory service that maps A2A agent IDs to channel bindings.
 *
 * Each binding captures everything needed to spin up a channel plugin
 * instance: which A2A agent to route messages to, which channel to use
 * (currently only "feishu"), and the full channel configuration.
 *
 * Usage:
 *   const registry = new ChannelRegistry();
 *   registry.register({
 *     agentId: 'my-agent',
 *     a2aAgentUrl: 'http://localhost:4000',
 *     channelId: 'feishu',
 *     config: { appId: 'cli_xxx', appSecret: '…' },
 *   });
 */

// ---------------------------------------------------------------------------
// Feishu channel configuration
// ---------------------------------------------------------------------------

export interface FeishuChannelConfig {
  /** Feishu App ID, e.g. "cli_xxxx". */
  appId: string;
  /** Feishu App Secret. */
  appSecret: string;
  /** Feishu verification token (for webhook mode). */
  verificationToken?: string;
  /** Feishu Encrypt Key (for webhook mode). */
  encryptKey?: string;
  /** "websocket" (default) or "webhook". */
  connectionMode?: 'websocket' | 'webhook';
  /** Webhook port when using webhook mode. */
  webhookPort?: number;
  /** DM access policy. Defaults to "open". */
  dmPolicy?: 'open' | 'pairing' | 'allowlist' | 'disabled';
  /** Require @mention in group chats. Defaults to false. */
  requireMention?: boolean;
  /**
   * Feishu domain brand — "feishu" (default) or "lark".
   * Controls which open-platform domain URLs are used.
   */
  domain?: 'feishu' | 'lark';
}

// ---------------------------------------------------------------------------
// Generic binding type (extensible for future channels)
// ---------------------------------------------------------------------------

export interface AgentChannelBinding {
  /** Logical agent identifier (any non-empty string). */
  agentId: string;
  /**
   * Base URL of the A2A-compliant remote agent.
   * E.g. "http://localhost:4000" or "https://my-agent.example.com".
   */
  a2aAgentUrl: string;
  /** Channel identifier — only "feishu" is supported for now. */
  channelId: 'feishu';
  /** Channel-specific configuration. */
  config: FeishuChannelConfig;
  /** Unix timestamp (ms) when this binding was first registered. */
  createdAt: number;
  /** Unix timestamp (ms) when this binding was last updated. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * In-memory registry of agent → channel bindings.
 *
 * Bindings are keyed by `agentId`.  Registering with an existing
 * `agentId` replaces the previous binding (upsert semantics).
 */
export class ChannelRegistry {
  private readonly bindings = new Map<string, AgentChannelBinding>();

  /**
   * Register (or replace) a binding.
   *
   * If a binding with the same `agentId` already exists its
   * `createdAt` timestamp is preserved; only `updatedAt` changes.
   */
  register(
    params: Omit<AgentChannelBinding, 'createdAt' | 'updatedAt'>,
  ): AgentChannelBinding {
    const existing = this.bindings.get(params.agentId);
    const now = Date.now();
    const binding: AgentChannelBinding = {
      ...params,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.bindings.set(params.agentId, binding);
    return binding;
  }

  /**
   * Update configuration fields on an existing binding.
   * Returns `null` if no binding with that `agentId` exists.
   */
  update(
    agentId: string,
    patch: Partial<Omit<AgentChannelBinding, 'agentId' | 'createdAt' | 'updatedAt'>>,
  ): AgentChannelBinding | null {
    const existing = this.bindings.get(agentId);
    if (!existing) return null;
    const updated: AgentChannelBinding = {
      ...existing,
      ...patch,
      config: patch.config ? { ...existing.config, ...patch.config } : existing.config,
      updatedAt: Date.now(),
    };
    this.bindings.set(agentId, updated);
    return updated;
  }

  /**
   * Remove a binding.
   * Returns `true` if the binding existed and was removed.
   */
  unregister(agentId: string): boolean {
    return this.bindings.delete(agentId);
  }

  /** Retrieve a binding by agent ID. */
  get(agentId: string): AgentChannelBinding | undefined {
    return this.bindings.get(agentId);
  }

  /** Check whether a binding exists for the given agent ID. */
  has(agentId: string): boolean {
    return this.bindings.has(agentId);
  }

  /** Return all bindings as an array. */
  list(): AgentChannelBinding[] {
    return [...this.bindings.values()];
  }

  /** Return the number of registered bindings. */
  get size(): number {
    return this.bindings.size;
  }
}
