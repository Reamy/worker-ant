/**
 * zx_20261122_1 M5「夜·度」——界面主题（system / light / dark）。
 *
 * 真源与缓存两处：
 *   · DB `ui.theme`（跨设备/重装可保留的权威设置，经既有 `settings:get`/`settings:set`）；
 *   · localStorage `wa.theme`（首屏内联脚本在 React 挂载前即可读，避免暗色闪白）。
 * 二者分工：localStorage 只做**首屏快照**，DB 是**最终真源**；`initTheme` 异步用 DB 校正缓存。
 *
 * 纪律：只影响本机界面显示，不改任何引擎判据、配置与数据；零新依赖。
 */
import { invoke } from './ipc';

export type ThemeChoice = 'system' | 'light' | 'dark';

/** DB 设置键（与 SettingsPage 写口同源）。 */
export const THEME_SETTING_KEY = 'ui.theme';
/** localStorage 首屏缓存键（与 `index.html` 内联脚本同源） */
export const THEME_STORAGE_KEY = 'wa.theme';

const DARK_MEDIA = '(prefers-color-scheme: dark)';

/** 把任意字符串收窄为合法选择；坏值按 `system`（不猜用户意图）。 */
function normalizeChoice(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** 解析 `system` 为当前实际明暗（无匹配环境时回落 light）。 */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'light' || choice === 'dark') return choice;
  try {
    return window.matchMedia(DARK_MEDIA).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 立即应用（写 `documentElement.dataset.theme` 与 localStorage 快照）。 */
export function applyTheme(choice: ThemeChoice): void {
  const resolved = resolveTheme(choice);
  try {
    document.documentElement.dataset.theme = resolved;
    // Tailwind 会把 `html[data-theme]` 这类整块自定义属性规则当变体处理掉；
    // 暗色 token 与兼容层统一挂在 `html.wa-dark` 类上（见 index.css 注释）。
    document.documentElement.classList.toggle('wa-dark', resolved === 'dark');
  } catch { /* 非 DOM 环境：仅写缓存 */ }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch { /* 存储不可用：忽略 */ }
}

/** 从 localStorage 读当前选择（坏值按 system）。 */
export function getThemeChoice(): ThemeChoice {
  try {
    return normalizeChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

let mediaBound = false;

/** 仅 `system` 时跟随系统明暗变化重应用（避免手动选择被系统切换覆盖）。 */
function bindSystemListener(): void {
  if (mediaBound) return;
  mediaBound = true;
  try {
    const mq = window.matchMedia(DARK_MEDIA);
    const onChange = (): void => {
      if (getThemeChoice() === 'system') applyTheme('system');
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(onChange);
    }
  } catch { /* 环境无 matchMedia：不监听从 system 变化 */ }
}

/**
 * 启动时初始化：先按 localStorage 快照立即应用（无闪），再异步用 DB `ui.theme` 校正。
 * DB 读失败不抛——首屏保持缓存值（离线/首启也能用）。
 */
export function initTheme(): void {
  applyTheme(getThemeChoice());
  bindSystemListener();
  void (async () => {
    try {
      const stored = await invoke<string | null>('settings:get', THEME_SETTING_KEY);
      if (stored === 'system' || stored === 'light' || stored === 'dark') {
        applyTheme(stored);
      }
    } catch { /* 读不到 DB：保持缓存值 */ }
  })();
}

/**
 * 用户显式切换：立即应用 + 写缓存 + 落 DB。
 * DB 写失败**如实抛出**（调用方提示），但界面已即时生效——不因写库失败把用户的选择吞掉。
 */
export async function setTheme(choice: ThemeChoice): Promise<void> {
  applyTheme(choice);
  await invoke('settings:set', THEME_SETTING_KEY, choice);
}
