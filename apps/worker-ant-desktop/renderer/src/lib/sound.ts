import { isQuietTimeActive } from './settingsStore';

/**
 * D2 (2026-09-04_2): 应用内提示音（Web Audio 短音）—— 按事件类 × 全局声音开关决策。
 * 规则读 settingsStore（响应式，运行中即时生效）：
 *  - notify_sound_enabled==='0' → 全静音；
 *  - 事件类对应 sound_<class>==='0' → 该类静音；
 *  - 免打扰时段内完成类提示已由 toast 层抑制；此处额外尊重安静时段（不响）。
 */
const SOUND_CLASS_KEY: Record<string, string> = {
  'task.completed': 'sound_completed',
  'task.failed': 'sound_failed',
  'task.awaiting_input': 'sound_await',
};

const FREQ: Record<string, number> = { 'task.completed': 880, 'task.failed': 220, 'task.awaiting_input': 440 };

export function shouldPlaySound(type: string, settings: Record<string, string>): boolean {
  if (settings.notify_sound_enabled === '0') return false;
  if (isQuietTimeActive(settings)) return false;
  const key = SOUND_CLASS_KEY[type];
  if (key && settings[key] === '0') return false;
  return true;
}

let _ctx: AudioContext | null = null;
function ctx(): AudioContext | null {
  try {
    if (!_ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      _ctx = new AC();
    }
    if (_ctx.state === 'suspended') void _ctx.resume();
    return _ctx;
  } catch { return null; }
}

export function playToastSound(type: string): void {
  const c = ctx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  const freq = FREQ[type] ?? 620;
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, c.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.45);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.5);
}
