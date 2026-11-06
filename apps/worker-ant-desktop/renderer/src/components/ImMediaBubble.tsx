/**
 * zx_20260930 M1（维特根斯坦·意义即使用 / 海德格尔·上手状态）: IM 会话里一「件」的控件。
 *
 * 病根：`message_json` 里早就记着「这件在盘上哪儿」（入站扁平 `saved_path`、出站嵌套 `media.path`），
 *   但界面上**一律塌成一行灰字占位符**（`[图片]` / `[其他消息(3)]`）——
 *   看得出"收到过一件"，看不出那件是什么、更打不开。
 *
 * ⚠ 分派判定**不在本文件**：`imMediaOf`（`src/main/core/im/im-media-view.ts`，零依赖）一处产出
 *   「这件该出哪种控件」。本组件只把那个判决翻成 DOM，**不另判一份**"什么算图片"
 *   （在渲染层抄第二份 = 同一条规则的第二处载体，改一处忘另一处）。
 *
 * 三条出口各有其职，缺一件都不算"上手"：
 *   · 打开——交给系统默认程序（`im:mediaOpen`）；
 *   · 另存——落到用户挑的位置（`im:mediaSave`；「用户取消」是一次取舍结果，**不是失败**）；
 *   · 在文件夹中显示——`showItemInFolder`（preload 既有，无需新 IPC）。
 *
 * ⚠ 取字节那一步（`im:mediaRead`）失败要**如实说出来**并退到"件名 + 大小 + 打开"：
 *   一个加载不出来的 `<img>` 比没有 `<img>` 更坏——它让用户以为**件本身**坏了，
 *   而真相多半只是"这种格式浏览器解不了"。
 */
import { useEffect, useState } from 'react';
import { FolderOpen, Loader2, Paperclip, Save, ExternalLink } from 'lucide-react';
import { im } from '../lib/ipc';
import { audioPlayNote, videoPlayNote, formatMediaSize, type ImMediaRef } from '../../../src/main/core/im/im-media-view.js';

interface Props {
  media: ImMediaRef;
  /** 逐条操作的结果回报（打开失败/另存到哪儿）——行内小字，不弹窗。 */
  onNotice: (text: string, ok: boolean) => void;
}

export function ImMediaBubble({ media, onNotice }: Props) {
  const [inline, setInline] = useState<{ dataUrl: string; size: number } | null>(null);
  const [readErr, setReadErr] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const canInline = (media.render === 'image' || media.render === 'audio' || media.render === 'video') && !!media.path && !media.error;

  // 取字节：只在**该出缩略图/播放条**时才读盘。读失败不是"件坏了"，是"预览不了"——
  //   两种话分开说（前者会让用户去重发，后者只需要换一条出口）。
  useEffect(() => {
    let alive = true;
    if (!canInline) return;
    setInline(null); setReadErr('');
    im.mediaRead(media.path)
      .then(r => { if (alive) setInline({ dataUrl: r.dataUrl, size: r.size }); })
      .catch(e => { if (alive) setReadErr((e as Error).message || '预览读取失败'); });
    return () => { alive = false; };
  }, [canInline, media.path]);

  function say(text: string, ok: boolean) { setNotice(text); onNotice(text, ok); }

  async function handleOpen() {
    setBusy('open');
    try { await im.mediaOpen(media.path); say('已交给系统默认程序打开', true); }
    catch (e) { say(`打开失败：${(e as Error).message}`, false); }
    finally { setBusy(''); }
  }
  async function handleSave() {
    setBusy('save');
    try {
      const r = await im.mediaSave(media.path, media.fileName || undefined);
      if (r.cancelled) return;                      // 取消不算失败，也不留一句"没成功"的灰字
      say(`已另存到 ${r.savedTo ?? ''}`, true);
    } catch (e) { say(`另存失败：${(e as Error).message}`, false); }
    finally { setBusy(''); }
  }
  async function handleReveal() {
    const api = window.electronAPI;
    // 不在 Electron 里（如 vite 单独热更调试）就没有这个出口——**如实说**，
    //   不能假装"已显示"（一个什么都没发生的按钮会被读成"点了没反应/件丢了"）。
    if (!api?.showItemInFolder) { say('当前环境不支持「在文件夹中显示」', false); return; }
    try { await api.showItemInFolder(media.path); }
    catch (e) { say(`在文件夹中显示失败：${(e as Error).message}`, false); }
  }

  // 大小：入站形状带 `size_bytes`；出站形状**没有**这个字段 ⇒ 读回来之前不显示数字
  //   （宁可少一行，也不编一个"0B"）。
  const sizeText = formatMediaSize(media.sizeBytes ?? inline?.size ?? -1);

  // 件没到手：**写出原因**，不显示成普通文本（`media_error` 非空就是"这件没到手"）。
  if (media.error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
        <p className="flex items-center gap-1"><Paperclip className="w-3 h-3" />件未到手：{media.error}</p>
        {media.fileName && <p className="mt-0.5 text-red-500 opacity-80">对方发的是「{media.fileName}」</p>}
      </div>
    );
  }

  return (
    <div className="rounded border border-gray-200 bg-white p-2 text-xs">
      <p className="flex items-center gap-1 text-gray-700">
        <Paperclip className="w-3 h-3 text-gray-400" />
        <span className="truncate" title={media.path}>{media.fileName || '（无名件）'}</span>
        {sizeText && <span className="text-gray-400 shrink-0">{sizeText}</span>}
        {media.ext && <span className="text-gray-300 shrink-0">{media.ext}</span>}
      </p>

      {media.render === 'image' && (
        inline
          ? <img src={inline.dataUrl} alt={media.fileName}
              className="mt-1.5 max-w-[200px] max-h-[200px] rounded border cursor-pointer"
              onClick={() => void handleOpen()} title="点击用系统默认程序打开" />
          : readErr
            ? <p className="mt-1 text-amber-700">预览不了：{readErr}（件本身仍在盘上，可用「打开」查看）</p>
            : <p className="mt-1 flex items-center gap-1 text-gray-400"><Loader2 className="w-3 h-3 animate-spin" />读取中…</p>
      )}

      {media.render === 'audio' && (
        inline
          ? <audio controls src={inline.dataUrl} className="mt-1.5 w-full max-w-[260px]" />
          : readErr
            ? <p className="mt-1 text-amber-700">预览不了：{readErr}（件本身仍在盘上，可用「另存」留存）</p>
            : <p className="mt-1 flex items-center gap-1 text-gray-400"><Loader2 className="w-3 h-3 animate-spin" />读取中…</p>
      )}

      {/* 格式浏览器解不了时**必须说**——一个按下去没反应的播放条会被读成"文件坏了/发丢了"。
          （这话的真源在 `im-media-view.audioPlayNote`，此处只显示，不另写一句。） */}
      {media.render === 'audio' && audioPlayNote(media.ext) && (
        <p className="mt-1 text-amber-700">{audioPlayNote(media.ext)}</p>
      )}

      {media.render === 'video' && (
        inline
          ? <video controls src={inline.dataUrl} className="mt-1.5 w-full max-w-[320px] rounded border" />
          : readErr
            ? <p className="mt-1 text-amber-700">预览不了：{readErr}（件本身仍在盘上，可用「另存」留存）</p>
            : <p className="mt-1 flex items-center gap-1 text-gray-400"><Loader2 className="w-3 h-3 animate-spin" />读取中…</p>
      )}

      {/* 同上：格式浏览器解不了时**必须说**（真源在 `im-media-view.videoPlayNote`，此处只显示）。 */}
      {media.render === 'video' && videoPlayNote(media.ext) && (
        <p className="mt-1 text-amber-700">{videoPlayNote(media.ext)}</p>
      )}

      <div className="mt-1.5 flex items-center gap-2 text-gray-500">
        <button onClick={() => void handleOpen()} disabled={!!busy}
          className="flex items-center gap-1 hover:text-blue-600 disabled:opacity-50" title="用系统默认程序打开">
          {busy === 'open' ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}打开
        </button>
        <button onClick={() => void handleSave()} disabled={!!busy}
          className="flex items-center gap-1 hover:text-blue-600 disabled:opacity-50" title="另存到本地任意位置">
          {busy === 'save' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}另存
        </button>
        <button onClick={() => void handleReveal()} className="flex items-center gap-1 hover:text-blue-600" title="在系统文件管理器中显示">
          <FolderOpen className="w-3 h-3" />在文件夹中显示
        </button>
      </div>
      {notice && <p className="mt-1 text-gray-500">{notice}</p>}
    </div>
  );
}
