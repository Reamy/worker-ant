/**
 * zx_20261023_4 受控复跑 —— 「启」：**首启不是死路**。
 *
 * 病根：干净机器上没有 token，库里只有种子管理员（密码只写在主进程日志里），
 * 而 community/pro 各 1 席 ⇒ 既登录不了、也注册不了。治法不是"告诉用户密码"，
 * 而是让 main 在**可被库证明**的条件下自动以本机所有者身份登录，并给一次设自己密码的机会。
 *
 * 三组判据（全部直引生产导出跑真实现）：
 *   A「判据」：`localOwnerState` 只认三件事——恰一人 / 就是种子所有者 / 密码仍是种子旧格式。
 *      七个否定标本逐一出名；只读不写（计数两侧相等）。
 *   B「服务」：`ensureLocalOwnerSession` 签发真 JWT（载荷逐项对账）；判据不成立回 null；
 *      `setLocalOwnerPassword` 写入即 bcrypt ⇒ 旧密码失效、自动登录永久关闸（不因 token 过期复活）。
 *   C「接线」：三个 IPC 通道恰一处登记；`App.tsx` 回退**先于** `setAuthed(false)` 且落两枚 token；
 *      向导页与设置页各挂一次卡片；邮箱字面量只在 `local-owner.ts` 一处。
 *
 * 纪律（承 auto-memory）：
 *   G-1 真源直 import（删/改名 ⇒ 编译期失败）。
 *   G-2 两只标本（该放行的放行 / 该拒绝的拒绝）。
 *   G-4 计数器正面断言（令牌/密码写入 0→1）。
 *   G-5 静态判据读去注释后的原文（`stripKeepingLines`）；"某字面量不在"类读原文。
 *   G-6 无轮次字面量：方案名/脚本名由 `path.basename(__filename)` 派生。
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）。
 *   ⚠ 末尾 build 钉读 `dist` ⇒ 常规须 `tsup` 先于本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  SEED_OWNER_EMAIL, localOwnerState, type LocalOwnerDb,
} from '../apps/worker-ant-desktop/src/main/core/local-owner.js';
import { AuthService, verifyToken } from '../apps/worker-ant-desktop/src/main/core/auth.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const STRIPPED = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/** 种子旧格式：`<32位hex盐>:<64位hex sha256>`（生产 `database.ts` 种子块同形）。
 *  **按生产的算法算真值**（sha256(盐 + 'admin123')）——手写 `a…:b…` 只能过正则，
 *  过不了 B-5 的"默认密码仍可登录"（那才是兜底是否真在的判据）。 */
const SEED_SALT = 'c'.repeat(32);
const LEGACY_HASH = `${SEED_SALT}:${createHash('sha256').update(SEED_SALT + 'admin123').digest('hex')}`;
const BCRYPT_HASH = `$2b$12$${'x'.repeat(53)}`;

/** 生产同形的两张表（列取 `database.ts` 真 DDL）。 */
function mkdb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
      avatar_url TEXT, role TEXT DEFAULT 'viewer', auth_provider TEXT DEFAULT 'authjs',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_user_credentials (
      user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedOwner(db: DatabaseSync, opts: { id?: string; email?: string; role?: string; hash?: string | null } = {}): void {
  const id = opts.id ?? 'u1';
  db.prepare('INSERT INTO wa_users (id, email, name, role) VALUES (?, ?, ?, ?)')
    .run(id, opts.email ?? SEED_OWNER_EMAIL, '管理员', opts.role ?? 'super_admin');
  if (opts.hash !== null) {
    db.prepare('INSERT INTO wa_user_credentials (user_id, password_hash) VALUES (?, ?)')
      .run(id, opts.hash ?? LEGACY_HASH);
  }
}

const asOwnerDb = (db: DatabaseSync): LocalOwnerDb => db as unknown as LocalOwnerDb;
type AuthDb = ConstructorParameters<typeof AuthService>[0];
const asAuthDb = (db: DatabaseSync): AuthDb => db as unknown as AuthDb;
const credCount = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM wa_user_credentials').get() as { n: number }).n;

async function main(): Promise<void> {
  // ═══ A｜判据：只认库里能证明的三件事 ═════════════════════════════════════════
  console.log('\n【A】判据：恰一人 / 就是种子所有者 / 密码仍是种子旧格式');
  {
    const d1 = mkdb();
    eq(localOwnerState(asOwnerDb(d1)), { kind: 'not_local_owner', reason: 'no_users' },
      'A-1 空库 ⇒ no_users（"没人"不等于"本机所有者"）');

    const d2 = mkdb(); seedOwner(d2);
    eq(localOwnerState(asOwnerDb(d2)), { kind: 'untouched_seed_owner', userId: 'u1' },
      'A-2 未改密的单一所有者 ⇒ 成立，且回他的 userId');

    const d3 = mkdb(); seedOwner(d3);
    d3.prepare('INSERT INTO wa_users (id, email) VALUES (?, ?)').run('u2', 'second@x.test');
    eq(localOwnerState(asOwnerDb(d3)), { kind: 'not_local_owner', reason: 'multi_user' },
      'A-3 库里出现第二人 ⇒ multi_user（不再自动登录）');

    const d4 = mkdb(); seedOwner(d4, { email: 'someone@x.test' });
    eq(localOwnerState(asOwnerDb(d4)), { kind: 'not_local_owner', reason: 'not_seed_owner' },
      'A-4a 唯一用户不是种子邮箱 ⇒ not_seed_owner');

    const d5 = mkdb(); seedOwner(d5, { role: 'viewer' });
    eq(localOwnerState(asOwnerDb(d5)), { kind: 'not_local_owner', reason: 'not_seed_owner' },
      'A-4b 邮箱是种子但角色不是 super_admin ⇒ 同样拒绝');

    const d6 = mkdb(); seedOwner(d6, { hash: null });
    eq(localOwnerState(asOwnerDb(d6)), { kind: 'not_local_owner', reason: 'no_credentials' },
      'A-5 没有密码行 ⇒ no_credentials');

    const d7 = mkdb(); seedOwner(d7, { hash: BCRYPT_HASH });
    eq(localOwnerState(asOwnerDb(d7)), { kind: 'not_local_owner', reason: 'password_changed' },
      'A-6 已是 bcrypt ⇒ password_changed');

    const d8 = mkdb(); seedOwner(d8, { hash: `${'a'.repeat(31)}:${'b'.repeat(64)}` });
    eq(localOwnerState(asOwnerDb(d8)), { kind: 'not_local_owner', reason: 'password_changed' },
      'A-7 形状不符（盐 31 位）也不算"种子旧格式"（正则从严，不宽松放行）');

    const before = credCount(d2);
    localOwnerState(asOwnerDb(d2));
    localOwnerState(asOwnerDb(d2));
    eq(credCount(d2), before, 'A-8 判据只读：调用两次后密码行数不变（不写、不升级）');
  }

  // ═══ B｜服务：签发真 JWT / 失效即 null / 设密码即永久关闸 ═════════════════════
  console.log('\n【B】服务：真 JWT / 判据不成立回 null / 设密码后旧密码失效');
  {
    const d1 = mkdb(); seedOwner(d1);
    const svc1 = new AuthService(asAuthDb(d1));
    const r1 = await svc1.ensureLocalOwnerSession();
    ok(r1 !== null && typeof r1.accessToken === 'string' && typeof r1.refreshToken === 'string',
      'B-1a 未改密 ⇒ 自动登录签发两枚 token');
    const payload = await verifyToken(r1!.accessToken);
    eq(
      { sub: payload.sub, email: payload.email, role: payload.role },
      { sub: 'u1', email: SEED_OWNER_EMAIL, role: 'super_admin' },
      'B-1b JWT 载荷与库内所有者逐项一致（不是"随便签一个"）',
    );
    eq(
      { id: r1!.user.id, email: r1!.user.email, role: r1!.user.role },
      { id: 'u1', email: SEED_OWNER_EMAIL, role: 'super_admin' },
      'B-1c 回给渲染层的 user 同源同值',
    );

    const d2 = mkdb(); seedOwner(d2);
    d2.prepare('INSERT INTO wa_users (id, email) VALUES (?, ?)').run('u2', 'second@x.test');
    eq(await new AuthService(asAuthDb(d2)).ensureLocalOwnerSession(), null,
      'B-2 多人库 ⇒ 回 null（调用方如实落到登录页，不降级放行）');

    const d3 = mkdb(); seedOwner(d3);
    const svc3 = new AuthService(asAuthDb(d3));
    const set3 = await svc3.setLocalOwnerPassword('newpass1');
    ok(set3.success === true, 'B-3a 首次使用可直接设自己的密码（免旧密码）');
    const state3 = localOwnerState(asOwnerDb(d3));
    eq(
      state3.kind === 'not_local_owner' ? state3.reason : state3.kind,
      'password_changed',
      'B-3b 写入后判据即失效（自动登录永久关闭，不因 token 过期复活）',
    );
    eq(await svc3.ensureLocalOwnerSession(), null, 'B-3c 失效后不再签发自动登录 token');
    ok(await svc3.login(SEED_OWNER_EMAIL, 'newpass1') !== null, 'B-3d 新密码可登录');
    eq(await svc3.login(SEED_OWNER_EMAIL, 'admin123'), null, 'B-3e 旧默认密码不再可用（写的是 bcrypt）');
    const again3 = await svc3.setLocalOwnerPassword('another1');
    ok(again3.success === false, 'B-3f 改密后不能再免旧密码覆盖（判据已不成立）');

    const d4 = mkdb(); seedOwner(d4);
    const short4 = await new AuthService(asAuthDb(d4)).setLocalOwnerPassword('12345');
    ok(short4.success === false && credCount(d4) === 1,
      'B-4a 短密码被拒且不落库（0→0，不是"先写后判"）');
    const set4 = await new AuthService(asAuthDb(d4)).setLocalOwnerPassword('123456');
    ok(set4.success === true, 'B-4b 恰好 6 位放行（门槛两侧标本）');

    const d5 = mkdb(); seedOwner(d5);
    const svc5 = new AuthService(asAuthDb(d5));
    ok(await svc5.login(SEED_OWNER_EMAIL, 'admin123') !== null,
      'B-5a 默认密码仍可作兜底登录（换机恢复后不至于进不去）');
    eq(await svc5.ensureLocalOwnerSession(), null,
      'B-5b 兜底登录一次即升级 bcrypt ⇒ 自动登录随之永久失效（不会与默认密码并存）');
  }

  // ═══ C｜接线：三层各恰一处，渲染层不自行放行 ═════════════════════════════════
  console.log('\n【C】接线：IPC 三通道 / 回退次序 / 两处挂载 / 字面量一处');
  {
    const ipc = STRIPPED(`${A}/src/main/ipc/auth.ipc.ts`);
    for (const ch of ['auth:localOwnerState', 'auth:ensureLocalOwner', 'auth:setLocalOwnerPassword']) {
      ok(ipc.includes(`'${ch}'`), `C-1 ${ch} 在 IPC 层登记`, ch);
    }

    const app = STRIPPED(`${A}/renderer/src/App.tsx`);
    ok(app.includes("invoke('auth:ensureLocalOwner')"), 'C-2a 渲染层确实走自动登录回退');
    ok(app.includes('setToken(res.data.accessToken)') && app.includes('setRefreshToken(res.data.refreshToken)'),
      'C-2b 成功后两枚 token 都落盘（下次启动走正常刷新路径）');
    const iEnsure = app.indexOf('auth:ensureLocalOwner');
    const iFalse = app.indexOf('setAuthed(false)');
    ok(iEnsure > -1 && iFalse > -1 && iEnsure < iFalse,
      'C-2c 回退落在 setAuthed(false) 之前（先试自动登录，再判未登录）');
    ok(app.includes('res?.data?.accessToken'), 'C-2d 只在 main 给出 token 时放行（渲染层不自行决定）');

    const setup = STRIPPED(`${A}/renderer/src/pages/SetupPage.tsx`);
    const settings = STRIPPED(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(setup.includes("components/LocalOwnerPasswordCard") && setup.includes('<LocalOwnerPasswordCard />'),
      'C-3a 向导页挂载设密码卡片');
    ok(settings.includes("components/LocalOwnerPasswordCard") && settings.includes('<LocalOwnerPasswordCard />'),
      'C-3b 设置页同样挂载（软跳过向导后仍能设）');

    const card = STRIPPED(`${A}/renderer/src/components/LocalOwnerPasswordCard.tsx`);
    ok(card.includes("invoke<LocalOwnerState>('auth:localOwnerState')"),
      'C-4a 卡片是否出现由 main 判据回答');
    ok(card.includes('if (!owner?.eligible) return null'),
      'C-4b 不适用即整卡不渲染（不缓存、不猜）');
    ok(card.includes('不设置密码也不影响使用') && card.includes('没有找回入口'),
      'C-4c 卡面如实写清两条边界（不设也能用 / 设了没法找回）');

    const dbRaw = RD(`${A}/src/main/database.ts`);
    ok(!dbRaw.includes("'admin@worker-ant.local'"), 'C-5a database.ts 不再持有邮箱字面量（真源已收口）');
    ok(STRIPPED(`${A}/src/main/database.ts`).includes('SEED_OWNER_EMAIL'),
      'C-5b 种子块改用 `SEED_OWNER_EMAIL`（同一常量）');

    const mainDir = path.join(root, A, 'src/main');
    const literalHits: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.ts') && fs.readFileSync(p, 'utf-8').includes("'admin@worker-ant.local'")) {
          literalHits.push(path.relative(mainDir, p).split(path.sep).join('/'));
        }
      }
    };
    walk(mainDir);
    eq(literalHits, ['core/local-owner.ts'], 'C-6 邮箱字面量在 src/main 中恰一处（唯一真源）');

    const authSrc = STRIPPED(`${A}/src/main/core/auth.ts`);
    const iEnsureMethod = authSrc.indexOf('async ensureLocalOwnerSession');
    const iSetMethod = authSrc.indexOf('async setLocalOwnerPassword');
    const iOauth = authSrc.indexOf('async findOrCreateOAuth');
    const ensureBody = authSrc.slice(iEnsureMethod, iSetMethod);
    ok(iEnsureMethod > -1 && iSetMethod > iEnsureMethod, 'C-7a 两个方法在场且可切段');
    ok(ensureBody.includes('localOwnerState(this.db)') &&
      ensureBody.indexOf('localOwnerState(this.db)') < ensureBody.indexOf('signAccessToken'),
      'C-7b 先验判据、再签发（不先签后判）');
    ok(/state\.kind !== 'untouched_seed_owner'\) return null/.test(ensureBody),
      'C-7c 判据不成立如实回 null（不降级）');

    const setBody = authSrc.slice(iSetMethod, iOauth);
    ok(setBody.indexOf("state.kind !== 'untouched_seed_owner'") > -1 &&
      setBody.indexOf("state.kind !== 'untouched_seed_owner'") < setBody.indexOf('UPDATE wa_user_credentials'),
      'C-7d 设密码同样先验判据、后写库');

    for (const rel of ['core/auth.ts', 'ipc/auth.ipc.ts']) {
      ok(STRIPPED(`${A}/src/main/${rel}`).includes("core/local-owner.js") ||
        STRIPPED(`${A}/src/main/${rel}`).includes("'./local-owner.js'") ||
        STRIPPED(`${A}/src/main/${rel}`).includes("'../core/local-owner.js'"),
      `C-8 ${rel} 引判据真源（不另写一份）`, rel);
    }
  }

  // ═══ S｜哑雷自检 + build 钉 ═══════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfPath = `scripts/${path.basename(__filename)}`;
    const selfLines = stripKeepingLines(RD(selfPath)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S3 本套件在册（脚本名由载体派生）');

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection 之前把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\nrr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
