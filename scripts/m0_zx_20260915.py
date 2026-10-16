#!/usr/bin/env python3
"""zx_20260915 M0 基线固证 —— 真库只读计数，产出 data/baseline_zx_20260915.json。

为什么要有这个脚本（而不是手抄数字）：
  zx_20260913 / 8a6f226a 两次教训都指向同一件事——**手抄的数字会漂**。
  本脚本把每条指标的 SQL/判据一并写进 JSON（`metrics[*].sql` / `.rule`），
  M7 收口时 **原样重跑**本脚本，用方向性比较（`<`/`>`）说明改没改到，**不写死期望值**
  （写死"本轮为真"的字面量 = 只对下一轮引爆的哑雷，见方案 §10.3 约定 3）。

判据真源：凡能对应到代码判据的指标，**镜像代码本身**，不另立一套
  - P0-1 的目标人群 = `agent-executor.ts:264` `realOutputEvidence(db,taskId)===false`（逐字镜像）
  - P0-8 的探针识别 = `deliverable-lifecycle.ts:153` `docNotProbe` 的同形规则（路径段级）
  - P0-9 的核验类标题 = 方案 §9.2(a) 的正则（`核验|核实|复核|检查|审计`）

只读：`file:...?mode=ro`，不写库、不启 WAL 写。
用法：python3 scripts/m0_zx_20260915.py [--out data/baseline_zx_20260915.json]
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_REL = 'data/worker-ant-server.db'
CST = timezone(timedelta(hours=8))

# ── 判据常量（与代码真源逐字对齐；改动须同步改代码处的锚点注释）────────────────
# agent-executor.ts:264 realOutputEvidence —— doc 落盘 / 服务类生命周期 / write|edit|register 工具行
SERVICE_TYPES = ('mcp', 'a2a', 'daemon', 'ui')
SERVICE_LIVE_STATUS = ('running', 'registered', 'stopped', 'completed')
WRITE_EVIDENCE_NEEDLES = ('%write_file%', '%edit_file%', '%register_deliverable%')
# 方案 §9.2(a) 核验类标题
VERIFY_TITLE_RE = re.compile(r'核验|核实|复核|检查|审计')
# 方案 §7.2 记忆面针脚
MEM_NEEDLES = ('%只读白名单%', '%命令包含非法字符%', '%换行/分隔符/命令替换%')
# 方案 §8.1 docNotProbe（deliverable-lifecycle.ts:160）**逐字镜像**——
#   探针 ⟺ NOT( `NOT LIKE '%/_%verify%'` AND `NOT LIKE '%/_%probe%'` AND `NOT LIKE '%/_%tmp%'`
#              AND `NOT GLOB '*test_[0-9a-f]×6*.py'` )
# ⚠ 三处易错，且都必须如镜像般还原，否则计数不可比：
#   ① LIKE 是 `%/_%verify%`（**不要求落在末段**，`/_probe_dir/x.md` 亦命中）且 **ASCII 大小写不敏感**；
#   ② GLOB 是 `*test_<6hex>*.py`（`*` 可跨 `/`）且 **大小写敏感**、`.` 为字面点；
#   ③ 整个谓词被 `(type != 'doc' OR …)` 门控 ⇒ **只判 doc 类**，code 类同名文件有意不过问。
PROBE_LIKE_RES = tuple(re.compile(r'/_[\s\S]*' + w, re.I) for w in ('verify', 'probe', 'tmp'))
PROBE_GLOB_RE = re.compile(r'test_[0-9a-f]{6}[\s\S]*\.py')


def is_probe_like(blob):
    """docNotProbe 的否定，逐字镜像（LIKE 段，大小写不敏感）。"""
    return any(r.search(blob) for r in PROBE_LIKE_RES)


def is_probe_glob(blob):
    """docNotProbe 的否定，逐字镜像（GLOB 段，大小写敏感）。"""
    return PROBE_GLOB_RE.search(blob) is not None


def coalesce_path(fp, name):
    """SQL `COALESCE(file_path, name)`：NULL 才回退到 name（空串**不**回退）。"""
    return fp if fp is not None else (name or '')


def open_ro(db_path):
    con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    # 库里存有历史坏字节（旧轮次落盘的非 UTF-8 片段）。**只读**场景下断然不该因个别行解码失败
    # 而放弃整轮计数——故按 replace 解码（判针是 ASCII 子串，替换字符不影响命中判定）。
    con.text_factory = lambda b: b.decode('utf-8', 'replace')
    return con


def one(cur, sql, params=()):
    return cur.execute(sql, params).fetchone()[0]


def collect(db_path):
    con = open_ro(db_path)
    cur = con.cursor()
    m = {}

    def metric(key, value, sql=None, rule=None, note=None):
        e = {'value': value}
        if sql:
            e['sql'] = sql
        if rule:
            e['rule'] = rule
        if note:
            e['note'] = note
        m[key] = e

    # ── 库总量 ────────────────────────────────────────────────────────────
    totals = {}
    for t in ('wa_tasks', 'wa_deliverables', 'wa_memories', 'wa_event_log',
              'wa_im_conversations', 'wa_notifications', 'wa_plan_milestones'):
        totals[t] = one(cur, f'SELECT COUNT(*) FROM {t}')
    metric('tableTotals', totals, sql='SELECT COUNT(*) FROM <表>')

    metric('tasksByStatus', dict(cur.execute(
        'SELECT status, COUNT(*) FROM wa_tasks GROUP BY status').fetchall()),
        sql='SELECT status, COUNT(*) FROM wa_tasks GROUP BY status')

    # ── P0-1 完成闸门目标人群（逐字镜像 realOutputEvidence）──────────────
    completed = [r[0] for r in cur.execute(
        "SELECT id FROM wa_tasks WHERE status = 'completed'").fetchall()]
    no_deliv, no_evidence = 0, []
    deliv_half_hits, tool_half_hits, any_hit = 0, 0, 0
    for tid in completed:
        # ① deliverable 段（与 realOutputEvidence 的 try 块同序）
        deliv_hit = False
        for typ, st, fp in cur.execute(
                'SELECT type, status, file_path FROM wa_deliverables WHERE task_id = ?', (tid,)):
            if typ == 'doc':
                if fp and os.path.exists(fp):
                    deliv_hit = True
                    break
            elif typ in SERVICE_TYPES and st in SERVICE_LIVE_STATUS:
                deliv_hit = True
                break
        if deliv_hit:
            deliv_half_hits += 1
        if one(cur, 'SELECT COUNT(*) FROM wa_deliverables WHERE task_id = ?', (tid,)) == 0:
            no_deliv += 1
        # ② 工具行段（与 realOutputEvidence 的 LIKE 逐字一致）——**独立判定**，不因 ① 命中而短路，
        #    否则 python 侧这一格就不是 `EXISTS(...)` 的同尺量，交叉核对会（如实地）判红。
        tool_hit = False
        for (cnt_,) in cur.execute(
                "SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'tool'", (tid,)):
            low = (cnt_ or '').lower()  # LIKE 对 ASCII 大小写不敏感，python 侧须同尺
            if any(n.strip('%') in low for n in WRITE_EVIDENCE_NEEDLES):
                tool_hit = True
                break
        if tool_hit:
            tool_half_hits += 1
        # ③ 合取（与 realOutputEvidence 同序：先交付物、再工具行 ⇒ 全不中才算"无产出证据"）
        if deliv_hit or tool_hit:
            any_hit += 1
        else:
            no_evidence.append(tid)

    metric('p0_1_completedTotal', len(completed), sql="SELECT id FROM wa_tasks WHERE status='completed'")
    metric('p0_1_completedNoDeliverable', no_deliv,
           sql='SELECT COUNT(*) FROM wa_tasks t WHERE t.status=? AND NOT EXISTS (SELECT 1 FROM wa_deliverables d WHERE d.task_id=t.id)')
    metric('p0_1_noOutputEvidence', len(no_evidence),
           rule='realOutputEvidence(db,taskId)===false（agent-executor.ts:264 逐字镜像）',
           note='完成闸门的目标人群：引擎 :5077 已算出"无产出证据⇒压降 45 分<60"，:4235 却照样标 completed')

    # 同人群按自评分分簇
    score_dist = {}
    for tid in no_evidence:
        s = one(cur, 'SELECT quality_score FROM wa_tasks WHERE id = ?', (tid,))
        key = 'NULL' if s is None else str(s)
        score_dist[key] = score_dist.get(key, 0) + 1
    metric('p0_1_noOutputEvidenceByScore', score_dist,
           rule='同上 + 按 quality_score 分组',
           note='45 = :5077 压降值（引擎自己判不合格）；10 = :5030 硬规则（无产出物且无对话 ⇒ 从未跑过）')

    # 全生命周期恰 1 条事件（"一次都没执行就被关闭"）
    single = []
    for tid in no_evidence:
        c = one(cur, 'SELECT COUNT(*) FROM wa_event_log WHERE aggregate_id = ?', (tid,))
        if c <= 1:
            row = cur.execute('SELECT title, created_at, updated_at FROM wa_tasks WHERE id = ?', (tid,)).fetchone()
            single.append({'id': tid[:8], 'title': row[0], 'created': row[1], 'updated': row[2], 'events': c})
    metric('p0_1_noOutputEvidenceSingleEvent', len(single),
           sql='SELECT COUNT(*) FROM wa_event_log WHERE aggregate_id = <taskId>', note='≤1 条事件 ⇒ 从未执行过一步')
    metric('p0_1_singleEventOn20260914', len([s for s in single if (s['created'] or '').startswith('2026-09-14')]),
           note='方案 §1.2 原写"4 个"，实为"09-14 当日的 4 个"；全库 ≤1 事件者实为 17 个（本项即该口径订正）')
    m['p0_1_singleEventSamples'] = {'value': single, 'note': '全量明细，供 M7 复核'}

    # ── P0-2 验收 ────────────────────────────────────────────────────────
    metric('p0_2_acceptanceCriteriaEmpty', one(cur,
           "SELECT COUNT(*) FROM wa_tasks WHERE status='completed' AND (acceptance_criteria IS NULL OR acceptance_criteria='')"),
           sql="... WHERE status='completed' AND (acceptance_criteria IS NULL OR acceptance_criteria='')")
    metric('p0_2_delivByType', dict(cur.execute(
        'SELECT type, COUNT(*) FROM wa_deliverables GROUP BY type').fetchall()))
    metric('p0_2_docCompleted', one(cur,
           "SELECT COUNT(*) FROM wa_deliverables WHERE type='doc' AND status='completed'"))
    metric('p0_2_docAcceptanceVerified', one(cur,
           "SELECT COUNT(*) FROM wa_deliverables WHERE type='doc' AND acceptance_verified=1"),
           note='"未验收"与"不需要验收"在库里长得一样：acceptance_verified=0 兼指二者')
    metric('p0_2_delivByStatus', dict(cur.execute(
        'SELECT status, COUNT(*) FROM wa_deliverables GROUP BY status').fetchall()))

    # ── P0-6 通知面 ──────────────────────────────────────────────────────
    metric('p0_6_notificationRows', one(cur, 'SELECT COUNT(*) FROM wa_notifications'),
           note='全库 0 行：暂停/偏离通知从未落到通知面（非投递失败，是压根没接线）')

    # ── P0-7 两把 shell 工具 ─────────────────────────────────────────────
    for key, needle in (('p0_7_rejectNonlegalChar', '命令包含非法字符'),
                        ('p0_7_rejectNotInWhitelist', '不在只读白名单'),
                        ('p0_7_rejectRedirect', '重定向被禁止'),
                        ('p0_7_rejectShellInterpreter', '禁止直接执行shell解释器')):
        metric(key, one(cur, 'SELECT COUNT(*) FROM wa_task_conversations WHERE content LIKE ?', (f'%{needle}%',)),
               sql=f"SELECT COUNT(*) FROM wa_task_conversations WHERE content LIKE '%{needle}%'")
    metric('p0_7_toolRowsExecuteCommand', one(cur,
           "SELECT COUNT(*) FROM wa_task_conversations WHERE role='tool' AND content LIKE '[execute_command]%'"))
    metric('p0_7_toolRowsBash', one(cur,
           "SELECT COUNT(*) FROM wa_task_conversations WHERE role='tool' AND content LIKE '[bash]%'"))

    mem_sql = 'SELECT COUNT(*) FROM wa_memories WHERE ' + ' OR '.join(['content LIKE ?'] * len(MEM_NEEDLES))
    metric('p0_7_memoryRowsRecordingShellLimits', one(cur, mem_sql, MEM_NEEDLES),
           rule='content LIKE 只读白名单|命令包含非法字符|换行/分隔符/命令替换（任一）')
    metric('p0_7_memoryRowsLive', one(cur,
           'SELECT COUNT(*) FROM wa_memories WHERE memory_type<>\'archived\' AND (' +
           ' OR '.join(['content LIKE ?'] * len(MEM_NEEDLES)) + ')', MEM_NEEDLES),
           note='非 archived 者才会被常规召回')
    wrong = ['e20cdc4e', '1ea42a3d', '984515f5', '842de6f5', 'ddb7e9df', 'ebd5ba6e']
    metric('p0_7_wrongRuleMemoryIds', wrong,
           rule='人工判读：教了解法同样被拒 / 归因到另一把工具 / 规则过宽（方案 §7.2 表）',
           note='e20cdc4e 教"用分号"（; 同在拒绝集）；1ea42a3d 指向 run_privileged；'
                '984515f5 说通配符被拒（不在拒绝集）；842de6f5/ddb7e9df/ebd5ba6e 把 execute_command 的报错'
                '记成 bash 的"换行/分隔符/命令替换"⇒ 两把工具被记成一把，且三条互为同义重复')

    # ── P0-8 探针产出物 / 主成果 ──────────────────────────────────────────
    probe_rows = []
    for did, tid, typ, st, name, fp in cur.execute(
            "SELECT id, task_id, type, status, name, file_path FROM wa_deliverables").fetchall():
        if typ != 'doc':
            continue  # 门控：谓词只判 doc 类（'code' 类同名文件有意不过问）
        blob = coalesce_path(fp, name)
        if is_probe_like(blob) or is_probe_glob(blob):
            probe_rows.append({'id': did[:8], 'task': (tid or '')[:8], 'type': typ,
                               'status': st, 'path': blob})
    not_retired = [r for r in probe_rows if r['status'] != 'retired']
    metric('p0_8_probeDeliverablesTotal', len(probe_rows),
           rule='doc 类且 NOT docNotProbe（deliverable-lifecycle.ts:160 逐字镜像：LIKE %/_%(verify|probe|tmp)% 或 GLOB *test_<6hex>*.py）')
    metric('p0_8_probeDeliverablesNotRetired', len(not_retired))
    metric('p0_8_probeTasksNotRetired', len({r['task'] for r in not_retired}))
    m['p0_8_probeSamplesNotRetired'] = {'value': not_retired[:20], 'note': '前 20 条样例'}

    metric('p0_8_autoPrimaryRule', 'ORDER BY created_at DESC, rowid DESC LIMIT 1',
           rule='deliverable-lifecycle.ts:423',
           note='挑的是**最新登记**的一条，与"谁是主成果"无关 ⇒ 本次核验任务的 177 959 B 既有脚本'
                '（09:50:27 登记）抢在真成果报告（09:50:04）前面拿到 ★')

    # ── P0-9 里程碑 ──────────────────────────────────────────────────────
    msByTask = dict(cur.execute(
        'SELECT plan_task_id, COUNT(*) FROM wa_plan_milestones GROUP BY plan_task_id').fetchall())
    metric('p0_9_milestoneRowsTotal', one(cur, 'SELECT COUNT(*) FROM wa_plan_milestones'))
    metric('p0_9_milestoneBoardTasks', len(msByTask))
    titles = dict(cur.execute('SELECT id, title FROM wa_tasks').fetchall())
    verify_boards = {k: v for k, v in msByTask.items() if VERIFY_TITLE_RE.search(titles.get(k, ''))}
    metric('p0_9_verificationTasksWithBoard', len(verify_boards),
           rule='wa_plan_milestones.plan_task_id 所属任务标题匹配 核验|核实|复核|检查|审计',
           note='方案 §10.2 预估"1"（只数了 8a6f226a），实测 5——问题是系统性的，非个例')
    m['p0_9_verificationBoards'] = {'value': {
        k[:8]: {'title': titles.get(k, ''), 'milestones': v} for k, v in verify_boards.items()}}

    def ms_of(prefix):
        return [r[0] for r in cur.execute(
            'SELECT milestone FROM wa_plan_milestones WHERE plan_task_id LIKE ? ORDER BY milestone', (prefix + '%',))]
    dup = {}
    for a, b in (('f07ad74a', '8a6f226a'), ('865d87b3', '9cf10c89')):
        sa, sb = ms_of(a), ms_of(b)
        dup[f'{a}∪{b}'] = {'a': sa, 'b': sb, 'identical': bool(sa) and sa == sb}
    metric('p0_9_duplicateBoards', dup,
           rule='同一 project 内两个任务登记了同一组里程碑',
           note='唯一索引是 (plan_task_id, milestone) ⇒ 同一里程碑挂在两个 plan_task_id 下**不被拦**，'
                '于是核验任务给规划任务已有的 M0–M8 又长出一块 9 行板')
    m['p0_9_verifyTitleRegex'] = {'value': VERIFY_TITLE_RE.pattern,
                                  'sql': "title GLOB '*核验*' OR ... (见方案 §9.2a)"}

    # ── 判据自身也须受判据管：python 镜像 vs SQLite 求值，逐条比数 ──────────
    # 若两处不等 ⇒ 镜像失真，本文件所有派生数字同时失效（故它是**致命项**，不是备注）。
    xc = {}
    xc['probeDocNotProbe'] = {
        'python': len(probe_rows),
        'sql': one(cur,
                   "SELECT COUNT(*) FROM wa_deliverables WHERE type='doc' AND ("
                   "COALESCE(file_path,name) LIKE '%/_%verify%' OR COALESCE(file_path,name) LIKE '%/_%probe%' "
                   "OR COALESCE(file_path,name) LIKE '%/_%tmp%' "
                   "OR COALESCE(file_path,name) GLOB '*test_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*.py')"),
        'note': 'docNotProbe 的否定，两侧全判据可比',
    }
    xc['realOutputEvidenceToolHalf'] = {
        'python': tool_half_hits,
        'sql': one(cur,
                   "SELECT COUNT(*) FROM wa_tasks t WHERE t.status='completed' AND EXISTS ("
                   "SELECT 1 FROM wa_task_conversations c WHERE c.task_id=t.id AND c.role='tool' "
                   "AND (c.content LIKE '%write_file%' OR c.content LIKE '%edit_file%' "
                   "OR c.content LIKE '%register_deliverable%'))"),
        'note': 'realOutputEvidence 的**工具行半边**（另一边的 fs.existsSync 无法用 SQL 表达，故不参与比对）',
    }
    xc['realOutputEvidenceDeliverableHalf'] = {
        'python': deliv_half_hits,
        'note': 'deliverable 半边**有意不比对**：判据含 fs.existsSync（磁盘当前态），SQL 无法表达；'
                '此项仅如实登记 python 侧命中数，供核算恒等式在有证据者里再做区分',
    }
    xc['ok'] = all(v['python'] == v['sql'] for v in xc.values()
                   if isinstance(v, dict) and 'sql' in v)
    # 核算恒等式（不写死期望值，只判"两侧是否同一把尺"）：
    # 有证据者 ∪ 无证据者 = completed 全体。两半边**会重叠**（同任务既落了盘又调过 write_file），
    # 故不能相加——相加即重复计数，这正是本轮反复要防的"两个事实一个符号"。
    xc['accountingIdentity'] = {
        'evidence(union) + noEvidence': f'{any_hit} + {len(no_evidence)}',
        'completedTotal': len(completed),
        'holds': any_hit + len(no_evidence) == len(completed),
        'halvesOverlap': deliv_half_hits + tool_half_hits - any_hit,
    }
    m['mirrorCrosscheck'] = {
        'value': xc,
        'rule': '凡镜像代码判据的指标，python 实现与 SQLite 求值必须逐条相等；不等即镜像失真',
        'note': '判据自身也须受判据管——否则"机器产出"只是另一种手抄',
    }

    # ── 8a6f226a 现场（第二轮取证的被核对象）──────────────────────────────
    t = cur.execute("SELECT id, status, quality_score, acceptance_criteria FROM wa_tasks WHERE id LIKE '8a6f226a%'").fetchone()
    if t:
        dels = [{'id': d[0][:8], 'primary': d[1], 'verified': d[2], 'status': d[3], 'path': d[4] or d[5]}
                for d in cur.execute(
                    'SELECT id, is_primary, acceptance_verified, status, file_path, name '
                    'FROM wa_deliverables WHERE task_id = ? ORDER BY created_at', (t[0],))]
        m['task8a6f226a'] = {'value': {
            'status': t[1], 'quality_score': t[2], 'acceptance_criteria': t[3],
            'deliverables': dels,
            'acceptanceVerifiedCount': sum(1 for d in dels if d['verified']),
            'deliverableCount': len(dels),
            'milestones': ms_of('8a6f226a'),
        }, 'note': '核验任务自身：交付物 3 个全未验收、标准为空、★ 落在既有脚本上'}

    con.close()
    return m


# ── 方案 §10.2 的**预估值** vs 本脚本**实测值**（M0 的意义就是这一栏）──────────
# 「先数后改」：方案写作时的预估若与实测不符，**以实测为准并就地订正方案**，
# 不把预估值留在方案里冒充事实（8a6f226a 报告"31/31" vs 实测 34 即此类）。
PLAN_PREVIEW = {
    'p0_1_completedTotal': 162,
    'p0_1_completedNoDeliverable': 130,
    'p0_1_noOutputEvidence': 43,
    'p0_1_noOutputEvidenceByScore': {'45.0': 6, '10.0': 19},
    'p0_1_singleEventOn20260914': 4,
    'p0_2_acceptanceCriteriaEmpty': 150,
    'p0_2_docCompleted': 66,
    'p0_2_docAcceptanceVerified': 7,
    'p0_6_notificationRows': 0,
    'p0_7_rejectNonlegalChar': 348,
    'p0_7_rejectNotInWhitelist': 134,
    'p0_8_probeDeliverablesNotRetired': '≥1',
    'p0_9_verificationTasksWithBoard': 1,
}
PLAN_PREVIEW_NOTE = {
    'p0_1_noOutputEvidenceByScore': '方案只列了 45/10 两簇；实测**共 8 簇**（NULL10/20:2/45:6/50:1/70:1/75:1/90:3/10:19）',
    'p0_1_singleEventOn20260914': '方案 §1.2 写"4 个…全生命周期恰 1 条事件"，实测该口径应写作"09-14 当日 4 个"；'
                                  '全库 ≤1 事件者实为 **21**（q10 子集 17）',
    'p0_8_probeDeliverablesNotRetired': '方案写"≥1"（只数了 8a6f226a 自己那一个）；实测 doc 类探针 **46** 个、'
                                        '未退休 **41** 个、涉 **13** 个任务',
    'p0_9_verificationTasksWithBoard': '方案 §10.2 写 1（只数 8a6f226a）；实测 **5**（另含 1af6b601/9cf10c89/865d87b3/c70a094c）'
                                       '——问题是**系统性**的，非个例，P0-9 因此更该做',
}


def diff_against_plan(metrics):
    out = {}
    for k, prev in PLAN_PREVIEW.items():
        cur_v = metrics[k]['value']
        differs = prev != cur_v
        out[k] = {'plan': prev, 'measured': cur_v, 'differs': differs}
        if differs and k in PLAN_PREVIEW_NOTE:
            out[k]['note'] = PLAN_PREVIEW_NOTE[k]
    out['_rule'] = '方案 §10.2 为**写作时预估**；本栏只做题面对照，**不改判据、不写死期望值**，' \
                   '差异项须在方案里就地订正（M0 的产出之一）'
    return out


def git_head():
    try:
        return subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT,
                              capture_output=True, text=True).stdout.strip()
    except Exception:
        return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'data/baseline_zx_20260915.json'))
    a = ap.parse_args()

    db_path = os.path.join(ROOT, DB_REL)
    metrics = collect(db_path)
    now = datetime.now(timezone.utc)
    doc = {
        'round': 'zx_20260915',
        'title': '账要对得上：完成、失败、答复、通知四本账',
        'capturedAt': now.strftime('%Y-%m-%d %H:%M:%S') + ' UTC (= 本地 ' + now.astimezone(CST).strftime('%Y-%m-%d %H:%M:%S') + ' +0800)',
        'generator': 'scripts/m0_zx_20260915.py（本文件全部数字由它机器产出，**非手抄**）',
        'db': DB_REL + '（dev 主库，只读：file:...?mode=ro）',
        'gitHead': git_head(),
        'method': {
            'readonly': 'sqlite3（python3）以 URI mode=ro 打开，不写库、不启 WAL 写',
            'rule': '凡能对应代码判据者**镜像代码本身**（逐字），不另立一套尺；镜像点在每条 metrics[*].rule 注明',
            'rerun': 'M7 收口重跑同一脚本，用方向性比较（< / >）说明改没改到；**不写死期望值**',
        },
        'metrics': metrics,
        'planPreviewVsMeasured': diff_against_plan(metrics),
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    print(f'✅ 基线已写入 {os.path.relpath(a.out, ROOT)}')
    for k in ('p0_1_noOutputEvidence', 'p0_2_acceptanceCriteriaEmpty', 'p0_6_notificationRows',
              'p0_7_rejectNonlegalChar', 'p0_7_rejectNotInWhitelist',
              'p0_8_probeDeliverablesNotRetired', 'p0_9_verificationTasksWithBoard'):
        print(f'   {k} = {metrics[k]["value"]}')


if __name__ == '__main__':
    main()
