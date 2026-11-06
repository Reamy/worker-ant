/**
 * zx_20261017_1 批八: 涂鸦云的**区域词表**——main 与 renderer 同引一份（零依赖、零 node 内置）。
 *
 * ⚠ 从 `tuya-cloud.ts` 拆出：适配层要用 `node:crypto`，渲染层**不能**跟着把 node 内置拉进包；
 *   而区域选项/设置键又是"词表的第二落点"（面板下拉框）。故把**纯词表**单独放这里。
 */

export const TUYA_SETTING_REGION = 'device.tuya.region';
export const TUYA_SETTING_ACCESS_ID = 'device.tuya.access_id';
export const TUYA_SETTING_ACCESS_SECRET = 'device.tuya.access_secret';

export const TUYA_REGIONS = ['cn', 'us', 'eu', 'in'] as const;
export type TuyaRegion = (typeof TUYA_REGIONS)[number];

/** 人话区域名（界面直接上屏；键类型取 `TuyaRegion` ⇒ 漏一项是编译期错）。 */
export const TUYA_REGION_LABEL: Record<TuyaRegion, string> = {
  cn: '中国',
  us: '美国',
  eu: '欧洲',
  in: '印度',
};
