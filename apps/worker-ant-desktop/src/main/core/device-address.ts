/**
 * 局域网出站地址判据（SSRF 围栏）——**零依赖单一真源**。
 *
 * 病根：判据原先住在 `tools/device.ts`，而 `device-discovery.ts` 也要用它（SSDP `LOCATION` 取描述前）。
 * 若 discovery 直接引 tools/device，会把 AI SDK / 工具注册表整条模块图拉进纯发现层。
 * 故上移至本文件：控制面、探活面、发现面**同引一份**，不再各写一条私网正则。
 */

/** 云元数据地址黑名单（zx_20261022_3 批四）。 */
const CLOUD_METADATA_ADDRS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure / OpenStack IMDS
  '169.254.170.2',   // AWS ECS task metadata
  'fd00:ec2::254',   // AWS IMDSv2 over IPv6
]);

/** 地址归一（去方括号/空白/大小写）——判黑名单用。 */
export function normalizeAddr(raw: string): string {
  return String(raw ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

/** 是否云元数据端点（显式拒绝，因由单独说）。 */
export function isCloudMetadataAddress(addr: string): boolean {
  return CLOUD_METADATA_ADDRS.has(normalizeAddr(addr));
}

/** 是否局域网地址（私有 IPv4 / 链路本地 / 回环 / IPv6 LL / `.local`）。 */
export function isLanAddress(addr: string): boolean {
  return lanAddressRefusal(addr) == null;
}

/**
 * 拒绝因由（放行回 `null`）：元数据端点单独一句，其余非局域网一句。
 * ⚠ 只判**字面地址**，不解析 DNS——`evil.example` 不会被放行，`foo.local` 放行（mDNS 名）。
 */
export function lanAddressRefusal(addr: string): string | null {
  if (!addr) return '地址为空';
  const norm = normalizeAddr(addr);
  if (isCloudMetadataAddress(norm)) {
    return `地址 ${norm} 是云元数据端点（实例凭据服务），出于安全**拒绝出站**（不替设备去取本机云身份）。`;
  }
  const m = norm.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127) return null;
    if (a === 192 && b === 168) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 169 && b === 254) return null;
    return `地址 ${addr} 非局域网地址（私网/链路本地/回环），出于安全**拒绝出站**。`;
  }
  if (/^fe80:/i.test(norm) || norm === '::1') return null;
  if (/\.local$/i.test(norm)) return null;
  return `地址 ${addr} 非局域网地址（私网/链路本地/.local），出于安全**拒绝出站**。`;
}
