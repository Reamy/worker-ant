import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ActivityProvider } from './lib/activity';
import ToastProvider from './lib/toast';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

// zx_20260904_7 白屏排查：全局未捕获错误/未处理 Promise → 上报 main(diag:renderError 落库)
function reportRenderError(err: unknown, url?: string): void {
  try {
    const e = err as { message?: string; stack?: string };
    const payload = { url: url || (typeof location !== 'undefined' ? location.hash : ''), message: String(e?.message ?? err), stack: String(e?.stack ?? '') };
    console.error('[render-global]', payload);
    void window.electronAPI?.invoke('diag:renderError', payload).catch(() => {});
  } catch { /* ignore */ }
}
window.addEventListener('error', (ev) => { reportRenderError(ev.error || ev.message, ev.filename); });
window.addEventListener('unhandledrejection', (ev) => { reportRenderError(ev.reason); });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <ActivityProvider>
        <ToastProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </ToastProvider>
      </ActivityProvider>
    </HashRouter>
  </React.StrictMode>,
);
