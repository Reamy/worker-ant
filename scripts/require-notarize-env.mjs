#!/usr/bin/env node
/**
 * macOS 发布前置检查：公证凭据必须就位。
 *
 * 为什么需要它：electron-builder 在 `notarize: true` 但**没有**凭据时只打一条 warn 就跳过公证，
 * 产物照样生成——已签名、未公证的包首次打开会被 Gatekeeper 拦，且从产物本身看不出来。
 * 发布路径（`pnpm dist:mac`）因此先跑本检查，缺凭据直接停，不产出会误导用户的发布件。
 */
const sets = [
  { name: 'API Key（推荐）', keys: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] },
  { name: 'Apple ID', keys: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] },
  { name: '钥匙串 profile', keys: ['APPLE_KEYCHAIN_PROFILE'] },
];

const satisfied = sets.find((s) => s.keys.every((k) => Boolean(process.env[k])));
if (satisfied) {
  console.log(`✓ 公证凭据就位（${satisfied.name}）`);
  process.exit(0);
}

console.error('✗ 未找到完整的 Apple 公证凭据，已停止发布构建（不会产出未公证的包）。');
console.error('  三选一（在终端里 export，或写进不提交的本地 .env 后 source）：');
console.error('  ① APPLE_API_KEY=<.p8 路径> APPLE_API_KEY_ID=<Key ID> APPLE_API_ISSUER=<Issuer ID>');
console.error('  ② APPLE_ID=<Apple ID> APPLE_APP_SPECIFIC_PASSWORD=<App 专用密码> APPLE_TEAM_ID=XRZNWLDU86');
console.error('  ③ xcrun notarytool store-credentials <profile> --apple-id ... --team-id XRZNWLDU86 --password ...');
console.error('     然后 export APPLE_KEYCHAIN_PROFILE=<profile>');
process.exit(1);
