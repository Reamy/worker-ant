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
import cron from 'node-cron';
import { recordAudit } from '../core/audit-log.js';
// zx_20261121_3 M4「见·首」：知识决定生效后发一根瞬态线，铃铛/待办中心订阅即刷。
import { emitKnowledgeChanged } from '../core/refresh-events.js';
import { enqueueJob } from '../core/job-enqueuer.js';
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  routineBoard,
  suggestRoutineCandidates,
  updateRoutine,
  type PositionRoutineInput,
} from '../core/position-routines.js';
import { runRoutine } from '../core/routine-runner.js';
// zx_20261120_3 M4「积·技」：岗位可调用技能（草案/审批/列表）。
import { approvedPositionSkillNames, createPositionSkillDraft, decidePositionSkill, listPositionSkills } from '../core/position-skills.js';
// zx_20261120_3 M5「积·桥」：项目知识 → 岗位候选（只写 pending，人工采纳）。
import { captureProjectKnowledgeCandidate } from '../core/position-capture.js';
import { proFeatureRefusal } from '../core/pro-gate.js';
// zx_20261120_3 M7「传·档」：自建岗位 / 岗位例行两维容量（只拦新增）。
import { resolveLicenseTier } from '../core/license.js';
import { capacityRefusal, countCustomPositions, countPositionRoutines, type CapacityDb } from '../core/tier-capacity.js';
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
  defaultPositionForProject,
  deletePosition,
  getPosition,
  getPositionByName,
  getPositionDetail,
  isPositionLessonDecision,
  isPositionLessonPromoteTarget,
  listPositions,
  listProjectEnabledPositions,
  listProjectPositionBoard,
  positionBlockDetail,
  positionProfile,
  promotePositionLesson,
  selectPositionLessonsForInjection,
  retireLesson,
  setLessonApplies,
  setPositionEnabled,
  setProjectPositionEnabled,
  supersedeLesson,
  unpromotePositionLesson,
  unretireLesson,
  unsupersedeLesson,
  updatePosition,
  verifyLesson,
  updatePositionLessonContent,
  type PositionInput,
} from '../core/positions.js';

type IpcFailure = { error: { code: string; message: string } };

/**
 * zx_20261120_1 M2：例行定义变更后重注册定时作业（由 `main/index.ts` 注入）。
 * 只传 routineId；注入方按"取不到/已停用即注销"处理，IPC 不需要知道调度器长什么样。
 */
let _routineRegistrar: ((routineId: string) => void) | null = null;
export function setRoutineRegistrar(fn: ((routineId: string) => void) | null): void {
  _routineRegistrar = fn;
}

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
      const verdict = capacityRefusal(resolveLicenseTier(db), 'maxCustomPositions', countCustomPositions(db as unknown as CapacityDb));
      if (!verdict.ok) return { error: { code: 'CAPACITY_EXCEEDED', message: verdict.note } } satisfies IpcFailure;
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
      // zx_20261115_3 M4：附带**项目默认岗位**（恰好一个启用岗位时才有值；否则 null）。
      //   与建单默认同一派生 `defaultPositionForProject`——界面预选与服务端回退不会各说一套。
      return { data: {
        positions: listProjectEnabledPositions(db, projectId),
        defaultId: defaultPositionForProject(db, projectId)?.id ?? null,
      } };
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
      // zx_20261120_3 M7：新岗位受自建岗位容量闸；覆盖已有岗位不占新增。
      if (!getPositionByName(db, parsed.value.position.name)) {
        const verdict = capacityRefusal(resolveLicenseTier(db), 'maxCustomPositions', countCustomPositions(db as unknown as CapacityDb));
        if (!verdict.ok) return { error: { code: 'CAPACITY_EXCEEDED', message: verdict.note } } satisfies IpcFailure;
      }
      const imported = importPositionPackage(db, parsed.value, mode, path.basename(filePath));
      if (!imported.ok) return { error: { code: imported.code, message: imported.message } } satisfies IpcFailure;
      writeAudit('position.import', imported.value.position.id, {
        fileName: path.basename(filePath), mode, addedSections: imported.value.addedSections,
        addedLessons: imported.value.addedLessons, skippedLessons: imported.value.skippedLessons,
        addedSkills: imported.value.addedSkills, skippedSkills: imported.value.skippedSkills,
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
      emitKnowledgeChanged('position.lesson_decide', { lessonId: id, decision: input.decision });
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

  // zx_20261120_3 M3「积·命」：经验生命周期的人工动作（适用条件/复验/退役/替代）。
  //   只动对应列；已采纳内容不改写；每个成功动作落审计（会改变世界才记）。
  ipcMain.handle('positions:lessonLifecycle', async (_event, input?: {
    id?: unknown; action?: unknown; appliesTo?: unknown; reason?: unknown; byId?: unknown;
  }) => {
    try {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      const action = typeof input?.action === 'string' ? input.action.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少经验 id' } } satisfies IpcFailure;
      let r: { ok: true } | { ok: false; code: string; message: string };
      switch (action) {
        case 'applies':
          r = setLessonApplies(db, id, typeof input?.appliesTo === 'string' ? input.appliesTo : '');
          break;
        case 'verify':
          r = verifyLesson(db, id);
          break;
        case 'retire':
          r = retireLesson(db, id, typeof input?.reason === 'string' ? input.reason : '');
          break;
        case 'unretire':
          r = unretireLesson(db, id);
          break;
        case 'supersede': {
          const byId = typeof input?.byId === 'string' ? input.byId.trim() : '';
          if (!byId) return { error: { code: 'INVALID_REQUEST', message: '缺少替代者经验 id' } } satisfies IpcFailure;
          r = supersedeLesson(db, id, byId);
          break;
        }
        case 'unsupersede':
          r = unsupersedeLesson(db, id);
          break;
        default:
          return { error: { code: 'INVALID_REQUEST', message: '未知动作（applies/verify/retire/unretire/supersede/unsupersede）' } } satisfies IpcFailure;
      }
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit(`position.lesson_${action}`, id, { lessonId: id });
      return { data: { ok: true } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261120_3 M4「积·技」：岗位技能——列表/建草案/审批。草案永不自动批准。
  ipcMain.handle('positions:skills', async (_event, input?: { positionId?: unknown; status?: unknown }) => {
    try {
      const positionId = typeof input?.positionId === 'string' ? input.positionId.trim() : '';
      if (!positionId) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const status = input?.status === 'draft' || input?.status === 'approved' || input?.status === 'rejected' ? input.status : undefined;
      return { data: { skills: listPositionSkills(db, positionId, status) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:skillCreate', async (_event, input?: Record<string, unknown>) => {
    try {
      const r = createPositionSkillDraft(db, {
        positionId: typeof input?.positionId === 'string' ? input.positionId : '',
        name: typeof input?.name === 'string' ? input.name : '',
        description: typeof input?.description === 'string' ? input.description : '',
        steps: Array.isArray(input?.steps) ? (input.steps as string[]) : [],
        sourceLessonId: typeof input?.sourceLessonId === 'string' ? input.sourceLessonId : '',
      });
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.skill_create', r.skill.positionId, { skillId: r.skill.id, name: r.skill.name, steps: r.skill.steps.length });
      return { data: { skill: r.skill } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positions:skillDecide', async (_event, input?: { id?: unknown; decision?: unknown }) => {
    try {
      const id = typeof input?.id === 'string' ? input.id.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少技能 id' } } satisfies IpcFailure;
      if (input?.decision !== 'approved' && input?.decision !== 'rejected') {
        return { error: { code: 'INVALID_REQUEST', message: '决定只能是 approved / rejected' } } satisfies IpcFailure;
      }
      const r = decidePositionSkill(db, id, input.decision);
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit(`position.skill_${input.decision}`, r.skill.positionId, { skillId: r.skill.id, name: r.skill.name });
      emitKnowledgeChanged('position.skill_decide', { skillId: r.skill.id, decision: input.decision });
      return { data: { skill: r.skill } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261120_3 M5「积·桥」：项目知识 → 岗位候选（只落 pending；不自动采纳、不回写项目知识）。
  ipcMain.handle('positions:captureProjectKnowledge', async (_event, input?: {
    projectId?: unknown; positionId?: unknown; section?: unknown; content?: unknown; sourceRef?: unknown;
  }) => {
    try {
      const r = captureProjectKnowledgeCandidate(db, {
        projectId: typeof input?.projectId === 'string' ? input.projectId : '',
        positionId: typeof input?.positionId === 'string' ? input.positionId : '',
        section: typeof input?.section === 'string' ? input.section : '',
        content: typeof input?.content === 'string' ? input.content : '',
        sourceRef: typeof input?.sourceRef === 'string' ? input.sourceRef : '',
      });
      if (!r.ok) return { error: { code: r.code, message: r.message } } satisfies IpcFailure;
      writeAudit('position.capture_project_knowledge', input?.positionId as string, {
        projectId: input?.projectId, section: input?.section, created: r.created, lessonId: r.lessonId,
      });
      return { data: r };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261120_3 M8：岗位注入预演（只读；与执行期同一构造，不写注入账）。
  ipcMain.handle('positions:injectPreview', async (_event, input?: { positionId?: unknown; query?: unknown }) => {
    try {
      const id = typeof input?.positionId === 'string' ? input.positionId.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少岗位 id' } } satisfies IpcFailure;
      const position = getPosition(db, id);
      if (!position) return { error: { code: 'NOT_FOUND', message: '岗位不存在（可能已删除）' } } satisfies IpcFailure;
      const query = typeof input?.query === 'string' ? input.query : '';
      const lessons = selectPositionLessonsForInjection(db, id, undefined, query);
      const detail = positionBlockDetail(position, lessons, undefined, approvedPositionSkillNames(db, id));
      return { data: { text: detail.text, items: detail.items, chars: detail.text.length } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // ── zx_20261120_1 M3：岗位例行（全档可用；跨机执行才走既有 multi_node） ──────────
  const validCron = (raw: unknown): boolean => {
    const expr = String(raw ?? '').trim();
    if (!expr) return false;
    const parts = expr.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 && parts.every((p) => cron.validate(p));
  };
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  ipcMain.handle('positionRoutine:list', async (_event, input?: { positionId?: unknown; projectId?: unknown; enabledOnly?: unknown }) => {
    try {
      // ⚠ 回 `{ data }` 信封：渲染层 `ipcCall` 只认这一形（2026-11-22 修，同运维页）。
      return {
        data: {
          routines: listRoutines(db, {
            positionId: str(input?.positionId) || undefined,
            projectId: str(input?.projectId) || undefined,
            enabledOnly: input?.enabledOnly === true,
          }),
        },
      };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positionRoutine:create', async (_event, input?: Record<string, unknown>) => {
    try {
      if (!validCron(input?.cron)) return { error: { code: 'INVALID_CRON', message: 'cron 表达式无效（支持换行/分号分隔多条）' } } satisfies IpcFailure;
      // zx_20261120_3 M7：岗位例行受容量闸（只拦新增；已有例行一条不删）。
      const verdict = capacityRefusal(resolveLicenseTier(db), 'maxPositionRoutines', countPositionRoutines(db as unknown as CapacityDb));
      if (!verdict.ok) return { error: { code: 'CAPACITY_EXCEEDED', message: verdict.note } } satisfies IpcFailure;
      const body: PositionRoutineInput = {
        position_id: str(input?.position_id ?? input?.positionId),
        project_id: str(input?.project_id ?? input?.projectId),
        name: str(input?.name),
        cron: str(input?.cron),
        timezone: str(input?.timezone) || 'Asia/Shanghai',
        title: str(input?.title),
        description: str(input?.description),
        acceptance_criteria: str(input?.acceptance_criteria ?? input?.acceptanceCriteria),
        priority: Number(input?.priority) || 0,
        enabled: input?.enabled !== false,
        created_by: 'local',
      };
      const r = createRoutine(db, body);
      if (!r.ok) return { error: { code: r.reason.toUpperCase(), message: r.reason } } satisfies IpcFailure;
      writeAudit('position.routine_create', r.id, { positionId: body.position_id, projectId: body.project_id, name: body.name, cron: body.cron });
      _routineRegistrar?.(r.id);
      return { data: { id: r.id } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positionRoutine:update', async (_event, input?: Record<string, unknown>) => {
    try {
      const id = str(input?.id ?? input?.routineId);
      if (!id) return { error: { code: 'INVALID_INPUT', message: '缺少例行 id' } } satisfies IpcFailure;
      if (input?.cron !== undefined && !validCron(input.cron)) {
        return { error: { code: 'INVALID_CRON', message: 'cron 表达式无效（支持换行/分号分隔多条）' } } satisfies IpcFailure;
      }
      const patch: Partial<PositionRoutineInput> & { enabled?: boolean } = {};
      if (input?.position_id !== undefined || input?.positionId !== undefined) patch.position_id = str(input.position_id ?? input.positionId);
      if (input?.project_id !== undefined || input?.projectId !== undefined) patch.project_id = str(input.project_id ?? input.projectId);
      if (input?.name !== undefined) patch.name = str(input.name);
      if (input?.cron !== undefined) patch.cron = str(input.cron);
      if (input?.timezone !== undefined) patch.timezone = str(input.timezone);
      if (input?.title !== undefined) patch.title = str(input.title);
      if (input?.description !== undefined) patch.description = str(input.description);
      if (input?.acceptance_criteria !== undefined || input?.acceptanceCriteria !== undefined) {
        patch.acceptance_criteria = str(input.acceptance_criteria ?? input.acceptanceCriteria);
      }
      if (input?.priority !== undefined) patch.priority = Number(input.priority) || 0;
      if (input?.enabled !== undefined) patch.enabled = input.enabled !== false;
      const r = updateRoutine(db, id, patch);
      if (!r.ok) return { error: { code: r.reason.toUpperCase(), message: r.reason } } satisfies IpcFailure;
      writeAudit('position.routine_update', id, { fields: Object.keys(patch) });
      _routineRegistrar?.(id);
      return { data: { id } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positionRoutine:delete', async (_event, input?: { id?: unknown }) => {
    try {
      const id = str(input?.id);
      if (!id) return { error: { code: 'INVALID_INPUT', message: '缺少例行 id' } } satisfies IpcFailure;
      const ok = deleteRoutine(db, id);
      if (!ok) return { error: { code: 'NOT_FOUND', message: '例行不存在' } } satisfies IpcFailure;
      writeAudit('position.routine_delete', id, {});
      _routineRegistrar?.(id);
      return { data: { deleted: true } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positionRoutine:runNow', async (_event, input?: { id?: unknown }) => {
    try {
      const id = str(input?.id);
      if (!id) return { error: { code: 'INVALID_INPUT', message: '缺少例行 id' } } satisfies IpcFailure;
      const r = runRoutine(db, id, {
        trigger: 'manual',
        enqueue: (taskId, projectId) => { enqueueJob(db, 'ai-task', { taskId, projectId, source: 'routine' }); },
      });
      writeAudit('position.routine_run_now', id, { ok: r.ok, taskId: r.taskId, skipped: r.skipped, reason: r.reason });
      return { data: r };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positionRoutine:suggestions', async (_event, input?: { positionId?: unknown; projectId?: unknown; days?: unknown; minRuns?: unknown }) => {
    try {
      const positionId = str(input?.positionId);
      const projectId = str(input?.projectId);
      if (!positionId || !projectId) return { error: { code: 'INVALID_INPUT', message: '缺少岗位或项目' } } satisfies IpcFailure;
      return { data: { suggestions: suggestRoutineCandidates(db, { positionId, projectId, days: Number(input?.days) || 90, minRuns: Number(input?.minRuns) || 3 }) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('positionRoutine:board', async (_event, input?: { positionId?: unknown; projectId?: unknown; days?: unknown }) => {
    try {
      const positionId = str(input?.positionId);
      if (!positionId) return { error: { code: 'INVALID_INPUT', message: '缺少岗位 id' } } satisfies IpcFailure;
      return { data: routineBoard(db, { positionId, projectId: str(input?.projectId) || undefined, days: Number(input?.days) || 90 }) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  console.log('[IPC] Positions handlers registered');
}
