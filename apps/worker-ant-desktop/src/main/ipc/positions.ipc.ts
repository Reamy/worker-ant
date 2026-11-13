/**
 * zx_20261112_1 B1「岗」: 岗位管理的 IPC 出口。
 *
 * 判据与写入全在 `core/positions.ts`；本文件只做壳：参数收窄、错误码、审计旁账。
 * 审计只记「会改变世界」的动作（建/改/启停/删/项目绑定/经验采纳拒绝），不记浏览。
 */
import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { recordAudit } from '../core/audit-log.js';
import { proFeatureRefusal } from '../core/pro-gate.js';
import {
  buildPositionPackage,
  importPositionPackage,
  parsePositionPackage,
  positionPackageFileName,
  type PositionImportMode,
} from '../core/position-package.js';
import {
  createPosition,
  decidePositionLesson,
  deletePosition,
  getPositionDetail,
  isPositionLessonDecision,
  isPositionLessonPromoteTarget,
  listPositions,
  listProjectEnabledPositions,
  listProjectPositionBoard,
  positionProfile,
  promotePositionLesson,
  setPositionEnabled,
  setProjectPositionEnabled,
  unpromotePositionLesson,
  updatePosition,
  updatePositionLessonContent,
  type PositionInput,
} from '../core/positions.js';

type IpcFailure = { error: { code: string; message: string } };

function idOf(input: { id?: unknown; positionId?: unknown } | undefined): string {
  const v = input?.positionId ?? input?.id;
  return typeof v === 'string' ? v.trim() : '';
}

function inputOf(input: Record<string, unknown> | undefined): PositionInput {
  return input ?? {};
}

export function initPositionsIpc(db: Database.Database): void {
  // 审计写失败不改变主动作结局（recordAudit 永不抛）。
  const writeAudit = (action: string, targetId: string, detail: Record<string, unknown>): void => {
    recordAudit(db, {
      actorKind: 'local',
      action,
      targetType: 'position',
      targetId,
      detail,
    });
  };

  ipcMain.handle('positions:list', async () => {
    try {
      return { data: { positions: listPositions(db) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:get', async (_event, input?: { id?: unknown }) => {
    try {
      const id = idOf(input);
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const detail = getPositionDetail(db, id);
      if (!detail) return { error: { code: 'NOT_FOUND', message: '岗位不存在（可能已删除）' } } satisfies IpcFailure;
      return { data: detail };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:create', async (_event, input?: Record<string, unknown>) => {
    try {
      const r = createPosition(db, inputOf(input));
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.create', r.position.id, { name: r.position.name, builtin: false });
      return { data: { position: r.position } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:update', async (_event, input?: Record<string, unknown>) => {
    try {
      const id = idOf(input);
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const r = updatePosition(db, id, inputOf(input));
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.update', id, { name: r.position.name, version: r.position.version });
      return { data: { position: r.position } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:toggle', async (_event, input?: { id?: unknown; enabled?: unknown }) => {
    try {
      const id = idOf(input);
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      if (typeof input?.enabled !== 'boolean') {
        return { error: { code: 'INVALID_REQUEST', message: '缺少 enabled（布尔）' } } satisfies IpcFailure;
      }
      const r = setPositionEnabled(db, id, input.enabled);
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.toggle', id, { enabled: input.enabled });
      return { data: { position: r.position } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:delete', async (_event, input?: { id?: unknown }) => {
    try {
      const id = idOf(input);
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const r = deletePosition(db, id);
      if (!r.deleted) return { error: { code: 'NOT_FOUND', message: '岗位不存在（可能已删除）' } } satisfies IpcFailure;
      writeAudit('position.delete', id, { unboundProjects: r.unboundProjects, keptLessons: r.keptLessons });
      return { data: r };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // 项目启用/停用（绑定行即开关；缺行 = 未启用）。
  ipcMain.handle('positions:projectToggle', async (_event, input?: { positionId?: unknown; projectId?: unknown; enabled?: unknown }) => {
    try {
      const positionId = typeof input?.positionId === 'string' ? input.positionId.trim() : '';
      const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
      if (!positionId || !projectId) {
        return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id 或项目 id' } } satisfies IpcFailure;
      }
      if (typeof input?.enabled !== 'boolean') {
        return { error: { code: 'INVALID_REQUEST', message: '缺少 enabled（布尔）' } } satisfies IpcFailure;
      }
      setProjectPositionEnabled(db, projectId, positionId, input.enabled);
      writeAudit('position.project_toggle', positionId, { projectId, enabled: input.enabled });
      const detail = getPositionDetail(db, positionId);
      if (!detail) return { error: { code: 'NOT_FOUND', message: '岗位不存在（可能已删除）' } } satisfies IpcFailure;
      return { data: { projects: detail.projects } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261112_1 B2「任」: 本项目**可指派**岗位（岗位启用 ∧ 项目绑定启用）——建单下拉与派活共用同一读法。
  ipcMain.handle('positions:forProject', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      return { data: { positions: listProjectEnabledPositions(db, projectId) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261113_1 B6「商」: 岗位知识包导出——**先闸后读后写**（社区档零文件）。
  ipcMain.handle('positions:export', async (_event, input?: { id?: unknown }) => {
    try {
      const refusal = proFeatureRefusal(db, 'position_transfer');
      if (refusal) return { error: { code: 'PRO_REQUIRED', message: refusal } } satisfies IpcFailure;
      const id = idOf(input);
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const built = buildPositionPackage(db, id);
      if (!built.ok) return { error: { code: built.code, message: built.message } } satisfies IpcFailure;
      const { dialog, BrowserWindow, app } = await import('electron');
      const fileName = built.value.fileName || positionPackageFileName(built.value.package.position.name);
      const win = BrowserWindow.getAllWindows()[0];
      const options = {
        defaultPath: path.join(app.getPath('documents'), fileName),
        title: '导出岗位知识包（JSON）',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { data: { cancelled: true } };
      fs.writeFileSync(picked.filePath, `${JSON.stringify(built.value.package, null, 2)}\n`, 'utf-8');
      writeAudit('position.export', id, { path: path.basename(picked.filePath), lessons: built.value.package.lessons.length });
      return { data: { cancelled: false, path: picked.filePath, lessons: built.value.package.lessons.length } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261113_1 B6「商」: 岗位知识包导入——**先闸后整包校验再写**（坏包零写入；经验一律 pending）。
  ipcMain.handle('positions:import', async (_event, input?: { mode?: unknown }) => {
    try {
      const refusal = proFeatureRefusal(db, 'position_transfer');
      if (refusal) return { error: { code: 'PRO_REQUIRED', message: refusal } } satisfies IpcFailure;
      const mode: PositionImportMode = input?.mode === 'replace' ? 'replace' : 'merge';
      const { dialog, BrowserWindow } = await import('electron');
      const win = BrowserWindow.getAllWindows()[0];
      const options = { title: '导入岗位知识包（JSON）', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile' as const] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return { data: { cancelled: true } };
      const filePath = picked.filePaths[0]!;
      const parsed = parsePositionPackage(fs.readFileSync(filePath, 'utf-8'));
      if (!parsed.ok) return { error: { code: 'BAD_PACKAGE', message: parsed.message } } satisfies IpcFailure;
      const imported = importPositionPackage(db, parsed.value, mode, path.basename(filePath));
      if (!imported.ok) return { error: { code: imported.code, message: imported.message } } satisfies IpcFailure;
      writeAudit('position.import', imported.value.position.id, {
        fileName: path.basename(filePath), mode, addedSections: imported.value.addedSections,
        addedLessons: imported.value.addedLessons, skippedLessons: imported.value.skippedLessons,
      });
      return { data: { cancelled: false, ...imported.value } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261113_1 B5「像」: 岗位画像——任务/验收/经验/注入账一处派生，页面不自己数。
  ipcMain.handle('positions:profile', async (_event, input?: { id?: unknown }) => {
    try {
      const id = idOf(input);
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const profile = positionProfile(db, id);
      if (!profile) return { error: { code: 'NOT_FOUND', message: '岗位不存在（可能已删除）' } } satisfies IpcFailure;
      return { data: profile };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261113_1 B1「联」: 项目详情「岗位」卡——含未启用项与任务/待审计数，renderer 不自行遍历。
  ipcMain.handle('positions:projectBoard', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      return { data: { positions: listProjectPositionBoard(db, projectId) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:lessons', async (_event, input?: { positionId?: unknown }) => {
    try {
      const positionId = typeof input?.positionId === 'string' ? input.positionId.trim() : '';
      if (!positionId) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const detail = getPositionDetail(db, positionId);
      if (!detail) return { error: { code: 'NOT_FOUND', message: '岗位不存在（可能已删除）' } } satisfies IpcFailure;
      return { data: { lessons: detail.lessons } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261113_1 B4「晋」: 已采纳的可迁移经验 → 规范/技能/知识（第二次人工确认；写口在 core）。
  ipcMain.handle('positions:promoteLesson', async (_event, input?: { id?: unknown; target?: unknown }) => {
    try {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少经验 id' } } satisfies IpcFailure;
      if (!isPositionLessonPromoteTarget(input?.target)) {
        return { error: { code: 'INVALID_REQUEST', message: 'target 只能是 rules / skills / knowledge' } } satisfies IpcFailure;
      }
      const r = promotePositionLesson(db, id, input.target);
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.lesson_promote', r.position.id, { lessonId: id, target: input.target });
      return { data: { position: r.position, lesson: r.lesson } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:unpromoteLesson', async (_event, input?: { id?: unknown }) => {
    try {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少经验 id' } } satisfies IpcFailure;
      const r = unpromotePositionLesson(db, id);
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.lesson_unpromote', r.position.id, { lessonId: id });
      return { data: { position: r.position, lesson: r.lesson } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:decideLesson', async (_event, input?: { id?: unknown; decision?: unknown; by?: unknown }) => {
    try {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少经验 id' } } satisfies IpcFailure;
      if (!isPositionLessonDecision(input?.decision)) {
        return { error: { code: 'INVALID_REQUEST', message: 'decision 只能是 accepted 或 rejected' } } satisfies IpcFailure;
      }
      const by = typeof input?.by === 'string' ? input.by : '';
      const r = decidePositionLesson(db, id, input.decision, by);
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.lesson_decide', r.lesson.positionId, { lessonId: id, decision: input.decision });
      return { data: { lesson: r.lesson } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261113_2 M17：编辑经验内容（缩短后再晋升；已晋升的须先撤回）。
  ipcMain.handle('positions:updateLesson', async (_event, input?: { id?: unknown; content?: unknown }) => {
    try {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少经验 id' } } satisfies IpcFailure;
      const content = typeof input?.content === 'string' ? input.content : '';
      const r = updatePositionLessonContent(db, id, content);
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.lesson_update', r.lesson.positionId, { lessonId: id, chars: r.lesson.content.length });
      return { data: { lesson: r.lesson } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  console.log('[IPC] Positions handlers registered');
}
