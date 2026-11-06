import { app, shell } from 'electron';

const OAUTH_CALLBACK_PATH = '/auth/callback';
const SERVER_URL = `http://localhost:${process.env.WA_SERVER_PORT || '9411'}`;

/**
 * 注册自定义协议 worker-ant:// 用于 OAuth 回调。
 * macOS: app.on('open-url') 自动处理
 * Windows/Linux: argv + second-instance 传递
 */
export function registerOAuthProtocol(): void {
  if (process.platform === 'darwin') {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      handleOAuthCallback(url);
    });
  } else {
    if (!app.isDefaultProtocolClient('worker-ant')) {
      app.setAsDefaultProtocolClient('worker-ant');
    }

    const protoUrl = process.argv.find(arg => arg.startsWith('worker-ant://'));
    if (protoUrl) handleOAuthCallback(protoUrl);

    app.on('second-instance', (_event, argv) => {
      const url = argv.find(arg => arg.startsWith('worker-ant://'));
      if (url) handleOAuthCallback(url);
    });
  }
}

let oauthCallbackHandler: ((token: string, refreshToken?: string) => void) | null = null;

export function onOAuthCallback(handler: (token: string, refreshToken?: string) => void): void {
  oauthCallbackHandler = handler;
}

/**
 * 处理 OAuth 回调：提取 code → 服务端换取 JWT → 通知渲染进程。
 */
async function handleOAuthCallback(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(OAUTH_CALLBACK_PATH)) return;

    const code = parsed.searchParams.get('code');
    const error = parsed.searchParams.get('error');
    if (error) {
      console.error('[OAuth] 提供商返回错误:', error);
      return;
    }
    if (!code) {
      console.error('[OAuth] 回调缺少 code 参数');
      return;
    }

    // 用 code 向服务端换取 JWT
    const provider = parsed.hostname || parsed.pathname.split('/').pop() || 'github';
    const resp = await fetch(`${SERVER_URL}/api/v1/auth/oauth/desktop-exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, code }),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      console.error('[OAuth] token交换失败:', (errData as { error?: { message?: string } }).error?.message || resp.statusText);
      return;
    }

    const json = await resp.json() as { data?: { accessToken: string; refreshToken: string } };
    if (json.data?.accessToken && oauthCallbackHandler) {
      oauthCallbackHandler(json.data.accessToken, json.data.refreshToken);
    }
  } catch (err) {
    console.error('[OAuth] 回调处理失败:', (err as Error).message);
  }
}

/**
 * 在系统浏览器中打开 OAuth 授权页面。
 * 调用服务端 GET /api/v1/auth/oauth/:provider/desktop，
 * 服务端重定向到 OAuth 提供商，redirect_uri=worker-ant://auth/callback。
 */
export async function openOAuthInBrowser(provider: string): Promise<void> {
  const authUrl = `${SERVER_URL}/api/v1/auth/oauth/${provider}/desktop`;
  await shell.openExternal(authUrl);
}
