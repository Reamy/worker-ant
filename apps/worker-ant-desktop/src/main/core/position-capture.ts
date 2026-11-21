/**
 * zx_20261120_3 M5「积·桥」：**项目知识 → 岗位候选经验**（单向、人工、永不自动采纳）。
 *
 * 边界：
 *   · 只接受**可迁移节**（配方/验收/术语）；实体/成果/服务/使用/索引/运行面是项目专有事实，不进岗位。
 *   · 只写 `pending` 候选；`verified_at=NULL`（项目知识没有在本机任务上验证过）。
 *   · 同一岗位同一内容幂等（`task_id = pk:<sha16>` 命中 `UNIQUE(position_id, task_id)`）。
 *   · 主进程专用：本文件引 `node:crypto`；渲染层不得 import（承 `feedback_renderer_must_not_import_main_chain`）。
 */
import { createHash } from 'node:crypto';
import { insertPositionLessonCandidate, resolveTaskPosition, POSITION_LESSON_MAX, type PositionDb } from './positions.js';

export const POSITION_CAPTURE_SECTIONS = ['recipes', 'criteria', 'domain'] as const;
export type PositionCaptureSection = (typeof POSITION_CAPTURE_SECTIONS)[number];
export const POSITION_CAPTURE_SECTION_LABEL: Record<PositionCaptureSection, string> = {
  recipes: '配方与样板',
  criteria: '验收与失败',
  domain: '领域与术语',
};

export type CaptureProjectKnowledgeResult =
  | { ok: true; created: boolean; lessonId: string }
  | { ok: false; code: 'BAD_INPUT' | 'NOT_FOUND' | 'INTERNAL'; message: string };

function isCaptureSection(v: unknown): v is PositionCaptureSection {
  return typeof v === 'string' && (POSITION_CAPTURE_SECTIONS as readonly string[]).includes(v);
}

export function captureProjectKnowledgeCandidate(
  db: PositionDb,
  input: { projectId: string; positionId: string; section: string; content: string; sourceRef?: string },
): CaptureProjectKnowledgeResult {
  const projectId = String(input.projectId ?? '').trim();
  const positionId = String(input.positionId ?? '').trim();
  const section = String(input.section ?? '').trim();
  // 单行化：换行/连续空白折成单空格（岗位经验是“一条”，不是一段）。
  const content = String(input.content ?? '').replace(/\s+/g, ' ').trim();
  if (!projectId || !positionId) return { ok: false, code: 'BAD_INPUT', message: '缺少项目或岗位 id' };
  if (!isCaptureSection(section)) {
    return { ok: false, code: 'BAD_INPUT', message: `只能沉淀可迁移节：${POSITION_CAPTURE_SECTIONS.join(' / ')}` };
  }
  if (!content) return { ok: false, code: 'BAD_INPUT', message: '内容不能为空' };
  if (content.length > POSITION_LESSON_MAX) {
    return { ok: false, code: 'BAD_INPUT', message: `内容最多 ${POSITION_LESSON_MAX} 字（当前 ${content.length}）` };
  }
  if (!resolveTaskPosition(db, projectId, positionId)) {
    return { ok: false, code: 'NOT_FOUND', message: '岗位不存在、已停用或未在本项目启用' };
  }
  const key = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const taskId = `pk:${key}`;
  const wrote = insertPositionLessonCandidate(db, {
    positionId,
    taskId,
    projectId,
    content,
    source: 'project_knowledge',
    reusable: true,
    origin: 'local',
    // 项目知识没有在本机任务上验证过 —— 显式 NULL，待人工复验。
    verifiedAt: null,
  });
  if (wrote) {
    // 回读 id（候选写入不返回 id；按 UNIQUE(position_id, task_id) 取）。
    try {
      const row = db.prepare('SELECT id FROM wa_position_lessons WHERE position_id = ? AND task_id = ? LIMIT 1')
        .get(positionId, taskId) as { id?: unknown } | undefined;
      return { ok: true, created: true, lessonId: String(row?.id ?? '') };
    } catch {
      return { ok: true, created: true, lessonId: '' };
    }
  }
  try {
    const row = db.prepare('SELECT id FROM wa_position_lessons WHERE position_id = ? AND task_id = ? LIMIT 1')
      .get(positionId, taskId) as { id?: unknown } | undefined;
    if (row?.id) return { ok: true, created: false, lessonId: String(row.id) };
  } catch { /* fall through */ }
  return { ok: false, code: 'INTERNAL', message: '候选写入失败' };
}
