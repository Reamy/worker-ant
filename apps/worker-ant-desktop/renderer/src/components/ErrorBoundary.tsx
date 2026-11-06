import React from 'react';

interface EBState { error: Error | null; url: string }
/**
 * 顶层错误边界（zx_20260904_7 白屏排查）：渲染期异常不再白屏——
 * 显示可恢复提示并把错误上报到 main（diag:renderError 落库），Reload 按钮恢复。
 */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, EBState> {
  state: EBState = { error: null, url: '' };

  static getDerivedStateFromError(error: Error): Partial<EBState> {
    return { error, url: (typeof location !== 'undefined' ? location.hash : '') };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
    try {
      void window.electronAPI?.invoke('diag:renderError', {
        url: (typeof location !== 'undefined' ? location.hash : ''),
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? '') + '\n' + String(info?.componentStack ?? ''),
      }).catch(() => {});
    } catch { /* 上报失败忽略 */ }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fafafa', color: '#333', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
          <p style={{ fontSize: 20, fontWeight: 600 }}>界面出错了（已捕获，不再白屏）</p>
          <p style={{ fontSize: 12, color: '#888', margin: '6px 0 0' }}>路由：{this.state.url || '/'}</p>
          <pre style={{ maxWidth: 760, maxHeight: 260, overflow: 'auto', background: '#fff', border: '1px solid #eee', borderRadius: 8, padding: 10, fontSize: 11, color: '#c0392b', marginTop: 12, whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
          <pre style={{ maxWidth: 760, maxHeight: 160, overflow: 'auto', background: '#f7f7f7', borderRadius: 8, padding: 10, fontSize: 10, color: '#555', marginTop: 8, whiteSpace: 'pre-wrap' }}>{this.state.error.stack}</pre>
          <button type="button" onClick={() => { this.setState({ error: null }); try { window.location.reload(); } catch { /* ignore */ } }} style={{ marginTop: 16, padding: '8px 18px', background: '#2f6fed', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
