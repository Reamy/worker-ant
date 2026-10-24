/**
 * zx_20261023_5 批三（维特根斯坦·意义即用法 / 米勒 7±2）: **统一接入向导**——一步一屏，四步走完。
 *
 *   ① 选渠道（渠道目录由 main 的 `devices:channels` 给；**锁定的渠道不出现**）
 *   ② 接法（局域网：直接发现；网关/云：先配好凭据，再发现/同步）
 *   ③ 勾选设备（米家设备在此逐台填 token，**只写不读**）
 *   ④ 完成（可选"同时允许控制"；授权闸仍由 main 的 K-6 判据执行）
 *
 * ⚠ 界面**不预判**能不能控：这里只呈现渠道自述（`requires`/`capabilities`）与服务端预检结论；
 *   真正下发时的授权闸在 main（`deviceControlVerdict`），被拒会原样上屏。
 * ⚠ 原有高级配置块（MQTT/HA/涂鸦）保留在页面下方——向导不删功能，只给一条最短路径。
 */
import { useEffect, useState } from 'react';
import { Radar, X, ChevronLeft, ChevronRight, Check, Loader2, KeyRound, Cloud, RadioTower } from 'lucide-react';
import {
  devices as devicesApi,
  type DeviceChannelAuthPayload,
  type DeviceChannelsPayload,
} from '../lib/ipc';
import type { DeviceChannel, DeviceChannelKind } from '../../../src/main/core/device-channel.js';
import type { AnsDevice } from '../../../src/main/core/device-registry.js';

const STEP_LABEL = ['选渠道', '接入方式', '勾选设备', '完成'];

const KIND_LABEL: Record<DeviceChannelKind, string> = {
  lan: '局域网',
  gateway: '网关',
  cloud: '厂商云',
};

const KIND_ICON: Record<DeviceChannelKind, typeof Radar> = {
  lan: Radar,
  gateway: RadioTower,
  cloud: Cloud,
};

export interface DeviceOnboardingWizardProps {
  /** 当前台账（由页面传入；发现后页面刷新即跟着更新）。 */
  devices: AnsDevice[];
  /** 关闭向导（不刷新）。 */
  onClose: () => void;
  /** 完成（让页面刷新台账）。 */
  onDone: () => void;
}

export function DeviceOnboardingWizard({ devices, onClose, onDone }: DeviceOnboardingWizardProps) {
  const [step, setStep] = useState(1);
  const [channels, setChannels] = useState<DeviceChannel[]>([]);
  const [channelsError, setChannelsError] = useState('');
  const [channelId, setChannelId] = useState('');
  const [auth, setAuth] = useState<DeviceChannelAuthPayload | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [grantControl, setGrantControl] = useState(false);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [tokenDone, setTokenDone] = useState<Record<string, boolean>>({});
  const [finished, setFinished] = useState<{ authorized: number; failed: number } | null>(null);

  const channel = channels.find((c) => c.id === channelId) ?? null;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r: DeviceChannelsPayload = await devicesApi.channels();
        if (!alive) return;
        setChannels(r.channels);
        // 全部渠道被锁（非 Team 档）⇒ 如实说清原因，不给一条走不通的路。
        if (r.channels.length === 0) setChannelsError(r.gate.detail);
      } catch (e) {
        if (alive) setChannelsError((e as Error)?.message || '读取渠道目录失败');
      }
    })();
    return () => { alive = false; };
  }, []);

  async function chooseChannel(next: string): Promise<void> {
    setChannelId(next);
    setAuth(null);
    setMsg(null);
    setStep(2);
    setBusy('auth');
    try {
      setAuth(await devicesApi.channelAuth(next));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '渠道预检失败' });
    } finally { setBusy(''); }
  }

  async function recheck(): Promise<void> {
    if (!channel) return;
    setBusy('auth');
    setMsg(null);
    try {
      setAuth(await devicesApi.channelAuth(channel.id));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '渠道预检失败' });
    } finally { setBusy(''); }
  }

  async function startDiscover(): Promise<void> {
    setDiscovering(true);
    setMsg(null);
    try {
      const r = await devicesApi.discover();
      onDone(); // 让页面立刻重读台账；新设备继续实时出现
      setMsg({
        ok: true,
        text: r.mqttErrors && r.mqttErrors.length > 0
          ? `发现已开始；MQTT 路有 ${r.mqttErrors.length} 条告警（mDNS/SSDP/miIO 照常）。`
          : '发现已开始——设备会逐个出现在下一步。',
      });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '起发现失败' });
    } finally { setDiscovering(false); }
  }

  async function syncCloud(): Promise<void> {
    setBusy('sync');
    setMsg(null);
    try {
      const r = await devicesApi.cloudSync();
      onDone();
      setMsg({ ok: true, text: `云同步完成：新增 ${r.added} 台、更新 ${r.updated} 台。` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '云同步失败' });
    } finally { setBusy(''); }
  }

  async function saveToken(address: string): Promise<void> {
    const raw = tokens[address] ?? '';
    setBusy(`token:${address}`);
    setMsg(null);
    try {
      const st = await devicesApi.miioToken(address, raw);
      setTokenDone((m) => ({ ...m, [address]: st.hasValue && st.encrypted }));
      setTokens((m) => ({ ...m, [address]: '' }));
      setMsg({
        ok: true,
        text: st.hasValue
          ? (st.encrypted ? 'token 已加密落库（界面上不会再显示它）。' : 'token 已保存（当前加密后端不可用，明文未被写入？请查看告警）。')
          : 'token 已清除。',
      });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || 'token 保存失败' });
    } finally { setBusy(''); }
  }

  async function finish(): Promise<void> {
    const ids = Object.entries(selected).filter(([, on]) => on).map(([id]) => id);
    let authorized = 0;
    let failed = 0;
    if (grantControl) {
      setBusy('finish');
      for (const id of ids) {
        try {
          await devicesApi.authorize(id, true);
          authorized += 1;
        } catch {
          failed += 1;
        }
      }
    }
    setFinished({ authorized, failed });
    setStep(4);
    setBusy('');
    onDone();
  }

  /** 渠道对应的台账设备行（按渠道自述的协议归属；发现不覆盖用户的勾选）。 */
  const matching = channel == null ? [] : devices.filter((d) => channel.protocols.includes(d.protocol));
  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        {/* 头部：四步进度（一步一屏，当前步高亮） */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-1.5 flex-wrap">
            {STEP_LABEL.map((label, i) => {
              const n = i + 1;
              const current = n === step;
              const done = n < step;
              return (
                <span key={label} className="inline-flex items-center gap-1">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${current ? 'bg-blue-600 text-white' : done ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'}`}>
                    {done ? <Check className="w-3 h-3 inline" /> : `${n}.`} {label}
                  </span>
                  {i < STEP_LABEL.length - 1 && <ChevronRight className="w-3 h-3 text-gray-300" />}
                </span>
              );
            })}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100" title="关闭"><X className="w-4 h-4 text-gray-400" /></button>
        </div>

        <div className="px-5 py-4 overflow-y-auto grow">
          {/* ① 选渠道 */}
          {step === 1 && (
            <div className="space-y-2">
              {channelsError && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">{channelsError}</div>
              )}
              {channels.map((c) => {
                const Icon = KIND_ICON[c.kind];
                return (
                  <button key={c.id} onClick={() => void chooseChannel(c.id)}
                    className="w-full text-left rounded-lg border px-3 py-2.5 hover:border-blue-300 hover:bg-blue-50/40 transition-colors">
                    <div className="flex items-center gap-2">
                      <Icon className="w-4 h-4 text-gray-400" />
                      <span className="text-sm font-medium text-gray-800">{c.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{KIND_LABEL[c.kind]}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">{c.summary}</div>
                  </button>
                );
              })}
              {channels.length === 0 && !channelsError && <div className="text-xs text-gray-400 py-6 text-center"><Loader2 className="w-4 h-4 animate-spin inline mr-1" />读取渠道目录…</div>}
            </div>
          )}

          {/* ② 接入方式 */}
          {step === 2 && channel && (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                发现是**显式动作**：点了才开始扫描局域网；发现**不等于授权**——真下发还须「允许控制」。
              </div>

              {busy === 'auth' && <div className="text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />预检中…</div>}

              {auth && !auth.verdict.ok && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{auth.verdict.reason}</div>
              )}

              {auth?.verdict.ok && auth.hasCredentials && (
                <div className="text-xs text-emerald-600">渠道配置已就绪。</div>
              )}

              {channel.requires === 'credentials' && !auth?.hasCredentials && (
                <div className="rounded-lg border bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  请先在页面下方的「{channel.label}」配置区填写：
                  <span className="font-mono ml-1">{channel.settingsKeys.join('、')}</span>
                  （密钥类字段会**加密落库**，界面上不再回显）。
                  <div className="mt-1.5">
                    <button onClick={() => void recheck()} disabled={busy === 'auth'}
                      className="text-[11px] px-2 py-0.5 border border-gray-300 rounded hover:bg-white disabled:opacity-50">我已填好，重新检查</button>
                  </div>
                </div>
              )}

              {channel.kind === 'cloud' ? (
                <button onClick={() => void syncCloud()} disabled={busy === 'sync' || !auth?.hasCredentials}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  title={auth?.hasCredentials ? '从厂商云拉取设备清单' : '先完成凭据配置'}>
                  {busy === 'sync' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}同步云端设备
                </button>
              ) : (
                <button onClick={() => void startDiscover()} disabled={discovering || (channel.requires === 'credentials' && !auth?.hasCredentials)}
                  className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {discovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />}开始发现
                </button>
              )}

              {channel.requires === 'token' && (
                <div className="rounded-lg border bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  这个渠道的设备需要**逐台**填入 token（下一步每行一个输入框）。token 会经系统钥匙串加密后落库，界面只显示「已配置」。
                </div>
              )}
            </div>
          )}

          {/* ③ 勾选设备 */}
          {step === 3 && channel && (
            <div className="space-y-2">
              {matching.length === 0 ? (
                <div className="text-xs text-gray-400 py-4 text-center">
                  还没有属于「{channel.label}」的设备。{channel.kind === 'cloud' ? '请先同步云端设备。' : '请先开始发现，或确认设备与本机在同一网段。'}
                </div>
              ) : matching.map((d) => (
                <div key={d.id} className="rounded-lg border px-3 py-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={selected[d.id] === true}
                      onChange={(e) => setSelected((m) => ({ ...m, [d.id]: e.target.checked }))} />
                    <span className="text-sm text-gray-800">{d.alias || d.name || d.address}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{d.kind}</span>
                    <span className="text-[11px] text-gray-400 font-mono">{d.address}{d.port ? `:${d.port}` : ''}</span>
                    {d.authorized && <span className="text-[10px] text-blue-600">已授权</span>}
                  </label>
                  {d.protocol === 'miio' && (
                    <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                      <KeyRound className="w-3 h-3 text-gray-400" />
                      <input value={tokens[d.address] ?? ''} onChange={(e) => setTokens((m) => ({ ...m, [d.address]: e.target.value }))}
                        placeholder="32 位 miIO token（留空不改）" className="text-[11px] px-2 py-1 rounded border border-gray-300 w-64 font-mono" />
                      <button onClick={() => void saveToken(d.address)} disabled={busy === `token:${d.address}`}
                        className="text-[11px] px-2 py-0.5 bg-slate-700 text-white rounded hover:bg-slate-800 disabled:opacity-50">
                        {busy === `token:${d.address}` ? '保存中…' : '保存 token'}
                      </button>
                      {tokenDone[d.address] && <span className="text-[10px] text-emerald-600">已加密保存</span>}
                    </div>
                  )}
                </div>
              ))}
              <label className="flex items-center gap-1.5 text-[11px] text-gray-600 pt-1 cursor-pointer">
                <input type="checkbox" checked={grantControl} onChange={(e) => setGrantControl(e.target.checked)} />
                同时为勾选的设备打开「允许控制」（未勾选则稍后逐台授权）
              </label>
            </div>
          )}

          {/* ④ 完成 */}
          {step === 4 && (
            <div className="py-4 text-center space-y-2">
              <Check className="w-10 h-10 text-emerald-500 mx-auto" />
              <div className="text-sm font-medium text-gray-800">接入完成</div>
              <div className="text-xs text-gray-500">
                本次勾选 {selectedCount} 台{finished ? `，已授权 ${finished.authorized} 台` : ''}
                {finished && finished.failed > 0 ? `，${finished.failed} 台授权失败（可稍后在列表逐台打开）` : ''}。
              </div>
              <div className="text-[11px] text-gray-400">设备会继续出现在下方台账里；发现不等于授权，未授权的设备只能读状态。</div>
            </div>
          )}

          {msg && <div className={`mt-2 text-[11px] ${msg.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{msg.text}</div>}
        </div>

        {/* 底部导航 */}
        <div className="px-5 py-3 border-t flex items-center justify-between">
          <span className="text-[11px] text-gray-400">
            {channel ? `渠道：${channel.label}` : '选择一种接入方式开始'}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1 || step === 4 || busy !== ''}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
              <ChevronLeft className="w-3.5 h-3.5" />上一步
            </button>
            {step < 3 && (
              <button onClick={() => setStep((s) => s + 1)} disabled={!channel || busy !== ''}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50">
                下一步<ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === 3 && (
              <button onClick={() => void finish()} disabled={busy !== ''}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {busy === 'finish' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}完成
              </button>
            )}
            {step === 4 && (
              <button onClick={onClose}
                className="text-xs px-3 py-1 bg-slate-700 text-white rounded-lg hover:bg-slate-800">关闭</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
