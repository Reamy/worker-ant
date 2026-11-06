/**
 * zx_20260906_2 批3 受控复跑（源码静态接线 + node:sqlite 内存库 SQL 语义冒烟；绝不触碰开发库；经桌面 node_modules/.bin/tsx 运行）。
 * S1 3a 服务端：deliverable:list handler 解构含 keyword；LIKE 谓词覆盖 名称/描述/类型/路径/registry_id；追加于 status 之后（projectId 空即跨项目）。
 * S2 3a IPC：renderer deliverables.list 三参透传 keyword。
 * S3 3a 页面：keyword/appliedKeyword state + 250ms 防抖 + load 依赖并传第三参 + 搜索框输入 + 空态文案。
 * S4 3a 语义冒烟：内存库复制 handler LIKE 谓词执行，验证 name/description/registry_id 命中、跨项目与无匹配空集。
 * （GUI 搜索框输入/组合筛选交互归桌面实机复核 §十 F1。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => { exec: (s: string) => void } };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const ipc = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/ipc/project.ipc.ts'), 'utf-8');
const lipc = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/lib/ipc.ts'), 'utf-8');
const dp = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/pages/DeliverablesPage.tsx'), 'utf-8');

console.log('S1 3a 服务端 handler');
const listStart = ipc.indexOf('ipcMain.handle(\'deliverable:list\'');
// zx_20260930 M4-2: 分页后返回体由裸数组变 `{ rows, total, retiredCount, limit, offset }`，
//   故边界锚点**改钉更强的真源**（原来的 `return { data }` 已不存在；若只改数字而不换锚，
//   `indexOf` 返 -1 会让切片吞掉整份文件，后面的 `includes` 断言反而更容易假绿）。
const listSeg = ipc.slice(listStart, ipc.indexOf('return { data: { rows: data', listStart));
ok(listSeg.includes('keyword?: string'), '解构含 keyword(可选)');
ok(listSeg.includes('d.name LIKE ? OR d.description LIKE ? OR d.type LIKE ? OR d.file_path LIKE ?') && listSeg.includes("COALESCE(d.registry_id, '') LIKE ?"), 'LIKE 谓词覆盖 名称/描述/类型/路径/registry_id');
ok(listSeg.indexOf('if (kw)') > listSeg.indexOf("if (status)"), 'keyword 分支追加于 项目/类型/状态 之后(可叠加；projectId 空即跨项目)');
ok(!listSeg.includes('d.content_snapshot'), '不检索大字段 content_snapshot');

console.log('S2 3a renderer IPC');
// zx_20260930 M4-2: 签名尾追 `page?: { limit?; offset? }`，故 pin 到**完整新签名**（三参+分页可选）；
//   只 pin 前缀 `…keyword?: string)` 会因少了 `)` 直接判红，而放宽成"含 keyword"又退化成不设闸。
ok(lipc.includes('list: (projectId?: string, type?: string, keyword?: string, page?: { limit?: number; offset?: number })'), 'deliverables.list 三参+分页签名');
ok(lipc.includes("'deliverable:list', { projectId, type, keyword, ...page }"), 'keyword 与分页参数透传 IPC');

console.log('S3 3a DeliverablesPage');
ok(dp.includes("const [keyword, setKeyword] = useState('')") && dp.includes("const [appliedKeyword, setAppliedKeyword] = useState('')"), 'keyword/appliedKeyword state');
ok(dp.includes('setAppliedKeyword(keyword.trim()), 250'), '250ms 防抖');
ok(dp.includes('appliedKeyword || undefined'), 'load 向服务端传 keyword(空则不带)');
ok(dp.includes('[filterProj, filterType, appliedKeyword]'), 'load 依赖含 appliedKeyword(输入触发刷新)');
ok(dp.includes('placeholder="搜名称/描述/类型/路径（跨项目）"'), '搜索框存在(跨项目占位)');
ok(dp.includes('appliedKeyword ? \'无匹配产出物\' : \'暂无产出物\''), '空态区分「无匹配产出物」');

console.log('S4 3a SQL 语义冒烟(复制 handler LIKE 谓词)');
const db = new DatabaseSync(':memory:') as any;
db.exec('CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, description TEXT, type TEXT, file_path TEXT, registry_id TEXT, status TEXT);');
db.prepare('INSERT INTO wa_deliverables (id, project_id, name, description, type, file_path, registry_id, status) VALUES (?,?,?,?,?,?,?,?)').run('a', 'p1', '部署指南.md', '教部署流程', 'doc', '/w/deploy.md', '', 'completed');
db.prepare('INSERT INTO wa_deliverables (id, project_id, name, description, type, file_path, registry_id, status) VALUES (?,?,?,?,?,?,?,?)').run('b', 'p2', 'monitor', '爬虫数据采集服务', 'mcp', '/w/mcp/monitor.js', 'reg-monitor-01', 'registered');
db.prepare('INSERT INTO wa_deliverables (id, project_id, name, description, type, file_path, registry_id, status) VALUES (?,?,?,?,?,?,?,?)').run('c', 'p2', 'report.docx', '', 'doc', '/w/r/report.docx', '', 'draft');
type R = { id: string };
const q = (kw: string): R[] => { const like = `%${kw}%`; return db.prepare("SELECT d.id FROM wa_deliverables d WHERE (d.name LIKE ? OR d.description LIKE ? OR d.type LIKE ? OR d.file_path LIKE ? OR COALESCE(d.registry_id, '') LIKE ?)").all(like, like, like, like, like) as R[]; };
ok(q('指南').some((x) => x.id === 'a'), '名称命中');
ok(q('数据采集').some((x) => x.id === 'b'), '描述命中');
ok(q('reg-monitor').some((x) => x.id === 'b'), 'registry_id 命中');
ok(q('部署').some((x) => x.id === 'a'), '路径/内容相关词命中');
ok(q('不存在的词xyz').length === 0, '无匹配 → 空集(前端显示无匹配空态)');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
