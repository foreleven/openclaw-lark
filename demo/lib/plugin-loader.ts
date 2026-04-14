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
 */

import { createMockPluginApi, type ChannelRegistration, type PluginRegistrationResult } from './mock-sdk.ts';
import { createA2APluginRuntime } from './a2a-plugin-runtime.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginLoaderOptions {
  /**
   * Optional URL of a remote A2A agent.
   * When provided the plugin loader wires up the full A2A-backed runtime,
   * enabling real sub-agent calls. Omit for the minimal no-op runtime.
   */
  a2aAgentUrl?: string;
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

  // Choose the runtime: A2A-backed or default no-op stubs
  let runtime: Record<string, unknown> | undefined;
  let a2aEnabled = false;

  if (options.a2aAgentUrl) {
    console.info(`[plugin-loader] using A2A runtime → ${options.a2aAgentUrl}`);
    runtime = createA2APluginRuntime({ agentUrl: options.a2aAgentUrl });
    a2aEnabled = true;
  }

  // Build mock API and let the plugin register itself
  const { api, result } = createMockPluginApi({ runtime });

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

  return {
    registration: result,
    channel: result.channels[0],
    emitHook,
    a2aEnabled,
  };
}
