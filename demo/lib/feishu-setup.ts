/**
 * Feishu Setup Service — QR Code Bot Binding Flow
 *
 * Implements the OAuth 2.0 Device Authorization Grant (RFC 8628) flow for
 * setting up a Feishu bot without manual credential entry on the server.
 *
 * Flow:
 *   1. Caller provides Feishu app credentials (appId + appSecret).
 *   2. `startQrFlow()` calls `requestDeviceAuthorization()` to obtain a
 *      `device_code` and a `verificationUriComplete` URL.
 *   3. The `verificationUriComplete` is rendered as a QR code on the setup page.
 *      The QR image is generated server-side (via the `qrcode` npm package) and
 *      served from `GET /setup/feishu/qr.svg?data=…` — no CDN dependencies.
 *   4. The Feishu app user scans the QR code and approves the authorization.
 *   5. Background polling (`pollDeviceToken`) detects completion and fires
 *      `registerBinding()` which creates the ChannelRegistry entry and
 *      starts the Feishu WebSocket gateway.
 *
 * Agent ID is hardcoded to "1" for now (as per the current requirement).
 */

import {
  requestDeviceAuthorization,
  pollDeviceToken,
} from '../../src/core/device-flow.ts';
import type { ChannelRegistry } from './channel-registry.ts';
import type { ChannelRuntimeManager } from './channel-runtime-manager.ts';

// ---------------------------------------------------------------------------
// QR code generation (server-side, no CDN dependency)
// ---------------------------------------------------------------------------

// Imported lazily so the module can be loaded even if qrcode is absent.
// `qrcode` is a CJS module so we use createRequire.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const _require = createRequire(import.meta.url ?? fileURLToPath(import.meta.url));

/**
 * Generate an SVG string for the given URL using the `qrcode` npm package.
 * Returns null if the package is not installed.
 */
export async function generateQrSvg(url: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = _require('qrcode') as {
      toString: (text: string, opts: Record<string, unknown>, cb: (err: Error | null, str: string) => void) => void;
    };
    return await new Promise<string>((resolve, reject) => {
      QRCode.toString(url, { type: 'svg', margin: 2, width: 220 }, (err, str) => {
        if (err) reject(err);
        else resolve(str);
      });
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hardcoded agent ID
// ---------------------------------------------------------------------------

export const DEFAULT_SETUP_AGENT_ID = '1';

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export type QrSessionStatus = 'pending' | 'authorized' | 'denied' | 'expired';

export interface QrSession {
  /** Unique session identifier. */
  sessionId: string;
  /** Feishu app credentials used to initiate the flow. */
  appId: string;
  appSecret: string;
  brand: 'feishu' | 'lark';
  /** A2A agent URL to associate with the binding once authorized. */
  a2aAgentUrl: string;
  /** Short human-readable code shown as fallback on the QR page. */
  userCode: string;
  /** Base URL the user visits manually if they cannot scan. */
  verificationUri: string;
  /** Full URL including user_code — use this as the QR code content. */
  verificationUriComplete: string;
  /** Unix ms when the device code expires. */
  expiresAt: number;
  /** Current authorization status. */
  status: QrSessionStatus;
  /** Agent ID that will be registered on success (currently always "1"). */
  agentId: string;
  /** Error message if status is 'denied' or 'expired'. */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FeishuSetupService {
  private readonly sessions = new Map<string, QrSession>();

  constructor(
    private readonly registry: ChannelRegistry,
    private readonly manager: ChannelRuntimeManager,
  ) {}

  // -------------------------------------------------------------------------
  // Start QR flow
  // -------------------------------------------------------------------------

  /**
   * Initiate the Device Authorization Grant flow for the given Feishu app.
   *
   * Returns a `QrSession` with a `verificationUriComplete` that should be
   * rendered as a QR code on the setup page.
   *
   * Background polling starts immediately. When the user scans the QR code
   * and approves, the binding is registered automatically.
   */
  async startQrFlow(params: {
    appId: string;
    appSecret: string;
    brand?: 'feishu' | 'lark';
    agentId?: string;
    a2aAgentUrl?: string;
    scope?: string;
  }): Promise<QrSession> {
    const brand = params.brand ?? 'feishu';
    const agentId = params.agentId ?? DEFAULT_SETUP_AGENT_ID;
    const a2aAgentUrl = params.a2aAgentUrl || process.env['A2A_AGENT_URL'] || 'http://localhost:4000';

    const deviceAuth = await requestDeviceAuthorization({
      appId: params.appId,
      appSecret: params.appSecret,
      brand,
      scope: params.scope,
    });

    const sessionId = crypto.randomUUID();
    const session: QrSession = {
      sessionId,
      appId: params.appId,
      appSecret: params.appSecret,
      brand,
      a2aAgentUrl,
      userCode: deviceAuth.userCode,
      verificationUri: deviceAuth.verificationUri,
      verificationUriComplete: deviceAuth.verificationUriComplete,
      expiresAt: Date.now() + deviceAuth.expiresIn * 1000,
      status: 'pending',
      agentId,
    };

    this.sessions.set(sessionId, session);

    // Start background polling — does not block the caller.
    this._startPolling(session, deviceAuth.deviceCode, deviceAuth.interval, deviceAuth.expiresIn).catch((err) => {
      console.error(`[feishu-setup] polling error for session ${sessionId}:`, err);
    });

    return session;
  }

  // -------------------------------------------------------------------------
  // Status query
  // -------------------------------------------------------------------------

  getSession(sessionId: string): QrSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session && session.status === 'pending' && Date.now() > session.expiresAt) {
      session.status = 'expired';
      session.errorMessage = '授权码已过期，请重新发起';
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Remove sessions that expired over an hour ago. Safe to call periodically. */
  cleanupExpired(): void {
    const cutoff = Date.now() - 3_600_000; // 1 hour after expiry
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async _startPolling(
    session: QrSession,
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ): Promise<void> {
    const result = await pollDeviceToken({
      appId: session.appId,
      appSecret: session.appSecret,
      brand: session.brand,
      deviceCode,
      interval,
      expiresIn,
    });

    const stored = this.sessions.get(session.sessionId);
    if (!stored) return; // Session was cleaned up before polling finished.

    if (result.ok) {
      stored.status = 'authorized';
      console.info(`[feishu-setup] session ${session.sessionId} authorized — registering agent "${session.agentId}"`);
      await this._registerBinding(stored);
    } else if (result.error === 'access_denied') {
      stored.status = 'denied';
      stored.errorMessage = '用户已拒绝授权';
    } else {
      stored.status = 'expired';
      stored.errorMessage = result.message;
    }
  }

  private async _registerBinding(session: QrSession): Promise<void> {
    const { agentId, appId, appSecret, brand, a2aAgentUrl } = session;

    // Stop existing gateway if one is already running for this agent.
    if (this.manager.isRunning(agentId)) {
      this.manager.stop(agentId);
    }

    // Create/replace the binding in the registry.
    this.registry.register({
      agentId,
      a2aAgentUrl,
      channelId: 'feishu',
      config: {
        appId,
        appSecret,
        domain: brand,
        dmPolicy: 'open',
        connectionMode: 'websocket',
      },
    });

    // Start the gateway (errors are logged but do not fail the registration).
    try {
      await this.manager.start(agentId);
      console.info(`[feishu-setup] gateway started for agent "${agentId}"`);
    } catch (err) {
      console.error(`[feishu-setup] gateway start failed for agent "${agentId}":`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML page generator
// ---------------------------------------------------------------------------

/**
 * Build the setup HTML page.
 *
 * This is a single self-contained HTML page that:
 *   1. Shows a form for entering Feishu app credentials.
 *   2. On submit: calls `POST /setup/feishu/start` and receives session info.
 *   3. Renders the QR code (using qrcode.js from CDN) for `verificationUriComplete`.
 *   4. Polls `GET /setup/feishu/status/:sessionId` until done.
 *   5. Shows success (agentId registered) or failure.
 */
export function buildSetupPage(opts: {
  /** Pre-fill appId in the form (from env or registry). */
  defaultAppId?: string;
  /** Pre-fill a2aAgentUrl in the form. */
  defaultA2aAgentUrl?: string;
  /** Whether the server already has a registered binding for agentId="1". */
  alreadyRegistered?: boolean;
  /** If already registered, include this status summary. */
  registeredStatus?: string;
}): string {
  const { defaultAppId = '', defaultA2aAgentUrl = '', alreadyRegistered = false } = opts;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Feishu Bot Setup — OpenClaw</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 16px;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.10);
      padding: 36px 40px;
      max-width: 480px;
      width: 100%;
    }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 6px; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 28px; }
    label { display: block; font-size: 14px; font-weight: 600; color: #333; margin-bottom: 6px; }
    input, select {
      width: 100%;
      padding: 10px 14px;
      border: 1.5px solid #d0d5dd;
      border-radius: 8px;
      font-size: 14px;
      color: #1a1a1a;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus, select:focus { border-color: #0066ff; }
    .field { margin-bottom: 18px; }
    .hint { font-size: 12px; color: #888; margin-top: 5px; }
    button[type="submit"] {
      width: 100%;
      padding: 12px;
      background: #0066ff;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
      margin-top: 4px;
    }
    button[type="submit"]:hover { background: #0055dd; }
    button[type="submit"]:disabled { background: #8ab4f8; cursor: not-allowed; }
    #qr-section { display: none; text-align: center; }
    #qr-section.visible { display: block; }
    #qr-code { margin: 20px auto; line-height: 0; }
    #qr-code img, #qr-code svg { border: 4px solid #e6e8ed; border-radius: 8px; }
    .user-code {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: 6px;
      color: #0066ff;
      margin: 12px 0;
      font-family: monospace;
    }
    .verify-link { font-size: 12px; color: #888; margin-bottom: 16px; }
    .verify-link a { color: #0066ff; text-decoration: none; }
    .status-bar {
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      margin-top: 20px;
    }
    .status-pending { background: #fff8e1; color: #b45309; }
    .status-authorized { background: #e6f4ea; color: #1e7e34; }
    .status-denied, .status-expired { background: #fde8e8; color: #b91c1c; }
    .spinner {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid #b45309;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .badge-registered {
      background: #e6f4ea;
      color: #1e7e34;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 20px;
      border: 1px solid #a3d9a5;
    }
    .section-divider {
      border: none;
      border-top: 1.5px solid #eee;
      margin: 28px 0;
    }
    .back-link { display: block; text-align: center; margin-top: 24px; font-size: 13px; }
    .back-link a { color: #0066ff; text-decoration: none; }
    .form-error {
      background: #fde8e8;
      color: #b91c1c;
      border: 1px solid #fca5a5;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 16px;
      display: none;
    }
    .form-error.visible { display: block; }
  </style>
</head>
<body>
<div class="card">
  <h1>🤖 飞书 Bot 配置</h1>
  <p class="subtitle">扫描二维码，完成飞书机器人绑定（Agent ID: <strong>1</strong>）</p>

  ${alreadyRegistered ? `<div class="badge-registered">✅ Agent "1" 已绑定，可重新配置覆盖</div>` : ''}

  <div id="form-error" class="form-error" role="alert" aria-live="assertive"></div>

  <form id="setup-form">
    <div class="field">
      <label for="appId">Feishu App ID</label>
      <input id="appId" name="appId" type="text" placeholder="cli_xxxxxxxxxx"
        value="${defaultAppId}" required autocomplete="off" />
      <div class="hint">在飞书开放平台 → 我的应用 → 凭证与基础信息中获取</div>
    </div>
    <div class="field">
      <label for="appSecret">Feishu App Secret</label>
      <input id="appSecret" name="appSecret" type="password" placeholder="••••••••••••••••" required />
      <div class="hint">与 App ID 在同一页面</div>
    </div>
    <div class="field">
      <label for="brand">平台域名</label>
      <select id="brand" name="brand">
        <option value="feishu">飞书 (feishu.cn) — 中国</option>
        <option value="lark">Lark (larksuite.com) — 国际</option>
      </select>
    </div>
    <div class="field">
      <label for="a2aAgentUrl">A2A Agent URL</label>
      <input id="a2aAgentUrl" name="a2aAgentUrl" type="url"
        placeholder="http://localhost:4000"
        value="${defaultA2aAgentUrl}" />
      <div class="hint">OpenClaw A2A 代理地址（选填，留空使用默认值）</div>
    </div>
    <button type="submit" id="submit-btn">生成二维码</button>
  </form>

  <div id="qr-section">
    <hr class="section-divider" />
    <p style="font-size:14px;color:#555;margin-bottom:8px;">
      使用<strong>飞书 App</strong>扫描下方二维码完成授权
    </p>
    <div id="qr-code"></div>
    <div class="user-code" id="user-code-display"></div>
    <div class="verify-link">
      或访问 <a id="verify-link" href="#" target="_blank">授权页面</a>，输入上方代码
    </div>
    <div id="status-bar" class="status-bar status-pending">
      <span class="spinner"></span> 等待扫码授权…
    </div>
    <div class="back-link"><a href="#" id="restart-link">重新配置</a></div>
  </div>
</div>

<script>
(function () {
  let pollTimer = null;
  let currentSessionId = null;

  const form = document.getElementById('setup-form');
  const formError = document.getElementById('form-error');
  const qrSection = document.getElementById('qr-section');
  const submitBtn = document.getElementById('submit-btn');
  const qrCodeDiv = document.getElementById('qr-code');
  const userCodeDisplay = document.getElementById('user-code-display');
  const verifyLink = document.getElementById('verify-link');
  const statusBar = document.getElementById('status-bar');
  const restartLink = document.getElementById('restart-link');

  function showFormError(msg) {
    formError.textContent = msg;
    formError.classList.add('visible');
    formError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideFormError() {
    formError.classList.remove('visible');
    formError.textContent = '';
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideFormError();
    const appId = document.getElementById('appId').value.trim();
    const appSecret = document.getElementById('appSecret').value.trim();
    const brand = document.getElementById('brand').value;
    const a2aAgentUrl = document.getElementById('a2aAgentUrl').value.trim();

    if (!appId || !appSecret) return;

    submitBtn.disabled = true;
    submitBtn.textContent = '正在生成…';

    try {
      const resp = await fetch('/setup/feishu/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, appSecret, brand, a2aAgentUrl: a2aAgentUrl || undefined }),
      });
      const data = await resp.json();

      if (!resp.ok) {
        submitBtn.disabled = false;
        submitBtn.textContent = '生成二维码';
        showFormError('启动失败：' + (data.error || '未知错误') + (data.reason ? ' — ' + data.reason : ''));
        return;
      }

      currentSessionId = data.sessionId;
      showQrCode(data.verificationUriComplete, data.userCode, data.verificationUri);
      startPolling(data.sessionId, data.interval || 5);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = '生成二维码';
      showFormError('网络错误：' + err.message);
    }
  });

  restartLink.addEventListener('click', function (e) {
    e.preventDefault();
    stopPolling();
    qrSection.classList.remove('visible');
    form.style.display = '';
    qrCodeDiv.innerHTML = '';
    submitBtn.disabled = false;
    submitBtn.textContent = '生成二维码';
    setStatus('pending', '');
    hideFormError();
  });

  function showQrCode(url, userCode, verifyUrl) {
    form.style.display = 'none';
    qrSection.classList.add('visible');
    qrCodeDiv.innerHTML = '';
    userCodeDisplay.textContent = userCode || '';
    verifyLink.href = verifyUrl || url;
    verifyLink.textContent = verifyUrl || url;

    // QR code is generated server-side and served as SVG — no CDN dependency.
    const img = document.createElement('img');
    img.src = '/setup/feishu/qr.svg?data=' + encodeURIComponent(url);
    img.alt = 'QR Code — scan with Feishu App';
    img.width = 220;
    img.height = 220;
    qrCodeDiv.appendChild(img);
  }

  function startPolling(sessionId, intervalSecs) {
    stopPolling();
    const ms = Math.max(3000, intervalSecs * 1000);
    pollTimer = setInterval(async function () {
      try {
        const resp = await fetch('/setup/feishu/status/' + sessionId);
        const data = await resp.json();
        updateStatus(data);
        if (data.status !== 'pending') stopPolling();
      } catch { /* ignore transient network hiccups */ }
    }, ms);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function updateStatus(data) {
    const { status, errorMessage, agentId } = data;
    if (status === 'authorized') {
      setStatus('authorized', '✅ 授权成功！飞书机器人已绑定（Agent ID: ' + (agentId || '1') + '）');
    } else if (status === 'denied') {
      setStatus('denied', '❌ 用户已拒绝授权。' + (errorMessage ? ' ' + errorMessage : ''));
    } else if (status === 'expired') {
      setStatus('expired', '⏰ 授权码已过期。' + (errorMessage ? ' ' + errorMessage : '') + ' 请点击"重新配置"。');
    }
    // pending: keep the spinner
  }

  function setStatus(type, msg) {
    statusBar.className = 'status-bar status-' + type;
    if (type === 'pending') {
      statusBar.innerHTML = '<span class="spinner"></span> 等待扫码授权…';
    } else {
      statusBar.textContent = msg;
    }
  }
})();
</script>
</body>
</html>`;
}
