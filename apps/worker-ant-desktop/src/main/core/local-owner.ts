/**
 * 本机所有者自动登录的唯一判据（zx_20261023_4）。
 *
 * 病根：桌面端所有主路由都过登录闸，而干净库里只有种子管理员
 * `admin@worker-ant.local`；community/pro 席位各 1，用户既不知道密码（只在主进程日志里）
 * 也注册不了（`assertSeatAvailable` 拒第 2 人）——首启是死路。
 *
 * 判据只认库里能证明的三件事，任一不成立即拒绝：
 *   1) `wa_users` 恰一行；
 *   2) 该行就是种子所有者（邮箱与角色）；
 *   3) 其密码仍是种子写入的旧格式（`salt:sha256`）——首次登录或改密都会升级为 bcrypt。
 * 因此用户一旦设了自己的密码、或库里有了第二个人，自动登录**永久失效**，不会因 token 过期复活。
 *
 * 本模块零依赖：rr 可直跑，`database.ts` 也引这里的邮箱常量（唯一字面量落点）。
 */

/** 种子管理员邮箱：`database.ts` 的写入与登录自动放行的判定同用这一个常量。 */
export const SEED_OWNER_EMAIL = 'admin@worker-ant.local';

/** 只读最小库接口（可脱 better-sqlite3 被 rr 直跑）。 */
export interface LocalOwnerDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export type LocalOwnerRefusal =
  | 'no_users'
  | 'multi_user'
  | 'not_seed_owner'
  | 'no_credentials'
  | 'password_changed';

export type LocalOwnerState =
  | { kind: 'untouched_seed_owner'; userId: string }
  | { kind: 'not_local_owner'; reason: LocalOwnerRefusal };

/** 种子密码的形态：`<32位hex盐>:<64位hex sha256>`。bcrypt 为 `$2...`，一律视为已改密。 */
const LEGACY_SEED_HASH = /^[0-9a-f]{32}:[0-9a-f]{64}$/;

/**
 * 判定当前库是否仍是「未改密的单一本机所有者」。
 * 只读；不抛（表缺失时由调用方决定如何降级，本函数只回 `not_local_owner`）。
 */
export function localOwnerState(db: LocalOwnerDb): LocalOwnerState {
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM wa_users').get() as { n?: number } | undefined;
  const count = typeof countRow?.n === 'number' ? countRow.n : 0;
  if (count === 0) return { kind: 'not_local_owner', reason: 'no_users' };
  if (count !== 1) return { kind: 'not_local_owner', reason: 'multi_user' };

  const user = db.prepare('SELECT id, email, role FROM wa_users LIMIT 1').get() as
    | { id?: string; email?: string; role?: string }
    | undefined;
  if (!user?.id || user.email !== SEED_OWNER_EMAIL || user.role !== 'super_admin') {
    return { kind: 'not_local_owner', reason: 'not_seed_owner' };
  }

  const cred = db
    .prepare('SELECT password_hash FROM wa_user_credentials WHERE user_id = ?')
    .get(user.id) as { password_hash?: string } | undefined;
  if (!cred?.password_hash) return { kind: 'not_local_owner', reason: 'no_credentials' };
  if (!LEGACY_SEED_HASH.test(cred.password_hash)) {
    return { kind: 'not_local_owner', reason: 'password_changed' };
  }

  return { kind: 'untouched_seed_owner', userId: user.id };
}
