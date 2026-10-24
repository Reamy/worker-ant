/**
 * zx_20261022_3 批四（维特根斯坦·意义即用法 / 管子·度量衡）: **密钥类设置的唯一词表**。
 *
 * 病：`settings:getAll` / `settings:get` 是 IPC 通用读口，把 `wa_settings` **整表**递给渲染层——
 *   `ans_secret_key`、`device.mqtt.password`、`device.tuya.access_secret` 一并过界。
 *   任何渲染层代码（含第三方插件页）都能读到明文，而界面根本不需要它。
 *
 * 一处真源：读口脱敏（`settings:get`/`getAll`）、写口挡回（拒收占位符）、广播脱敏、
 *   「是否已配置」状态（`settings:secretStatus`）都从这里取名单与判据。
 * 零依赖（只字符串）⇒ 渲染层可直接引 `SECRET_MASK`，不拖 main 的依赖图。
 *
 * ⚠ 外部终端的凭据**不在** `wa_settings`（表里只有 `key_prefix` + `secret_hash`），故此处无对应键；
 *   后缀规则（`_api_key` / `_secret` / `.password` / `.token` …）为将来那类键兜底。
 */
export const SECRET_MASK = '***';

/** 已知的密钥类设置键（显式名单；前缀/后缀规则另作兜底，三者取并）。 */
export const SECRET_SETTING_KEYS = [
  'ans_api_key',
  'ans_secret_key',
  'device.mqtt.password',
  'device.tuya.access_secret',
] as const;

/**
 * 前缀兜底（zx_20261023_5 批三）：**每设备一 key** 的凭据——名字尾部是设备地址，
 * 后缀规则够不着（`device.miio.token.192.168.1.5` 结尾是 `.5`）。
 */
const SECRET_PREFIXES = [
  'device.miio.token.',
] as const;

/** 后缀兜底：名字像密钥的新键（如将来 `im_x.app_secret`）不必再改名单。 */
const SECRET_SUFFIXES = [
  '.password', '_password',
  '.secret', '_secret',
  '.access_secret', '.token', '_token',
  '_secret_key', '_api_key',
];

export function isSecretSettingKey(key: string): boolean {
  const k = String(key ?? '').trim();
  if (!k) return false;
  if ((SECRET_SETTING_KEYS as readonly string[]).includes(k)) return true;
  if (SECRET_PREFIXES.some((p) => k.startsWith(p))) return true;
  return SECRET_SUFFIXES.some((s) => k.endsWith(s));
}

/**
 * 读口的**唯一脱敏判据**：密钥键回 `***`；**未配置回 `null`**（不拿占位符谎称"已配置"——
 * 界面据此显示「未配置」而非「留空不修改」）。非密钥键原样。
 */
export function redactedSettingValue(key: string, value: string | null): string | null {
  if (!isSecretSettingKey(key)) return value;
  if (value == null || value === '') return null;
  return SECRET_MASK;
}

/**
 * 写口守卫：渲染层若把读到的占位符原样写回（旧版界面 / 漏改的调用点），**拒绝写入**。
 * 否则一次「打开设置点保存」就会把真密钥覆盖成 `***`——脱敏反而成了数据丢失。
 * 合法的密钥值不会是 `***`，故此判据无副作用。
 */
export function isSecretMaskValue(key: string, value: string): boolean {
  return isSecretSettingKey(key) && value === SECRET_MASK;
}
