/**
 * zx_20261029_2 M1（庄子·不预设 / 维特根斯坦·意义即用法）: **设备品类归一**的单一真源。
 *
 * 问题：四条发现协议各说各的词——HA 说 `cover/climate`，涂鸦说 `cl/kt/dj`，米家只说 `unknown`，
 * mDNS/SSDP 给的是自述关键词。意图规则若逐协议认词，就等于把"同一件事"写了四遍且必然漂开。
 *
 * 口径（三条硬规矩）：
 *   ① **不覆盖设备自述的 `kind`**——那是设备说的话，原样留在台账；本模块只产出**派生列** `kind_class`；
 *   ② 计算依据**只许**协议自述（HA component/device_class、涂鸦 category、mDNS/SSDP 关键词）
 *      与**已配置凭据可查到的 model**（米家 `miio.info`）；**绝不用设备名字猜**；
 *   ③ 认不出就 `unknown`（"不知道"不是"其它设备"），并在人话里如实说"品类未识别"。
 *
 * ⚠ 零 electron / 零网络 / 零库：渲染层与 rr 都能直接引用。
 */

/** 归一类目表——**唯一真源**；`DEVICE_KIND_CLASS_LABELS` 必须逐项齐（漏一项是编译期错）。 */
export const DEVICE_KIND_CLASSES = [
  'curtain',
  'aircon',
  'light',
  'fan',
  'switch',
  'sensor',
  'lock',
  'camera',
  'speaker',
  'display',
  'vacuum',
  'other',
  'unknown',
] as const;

export type DeviceKindClass = (typeof DEVICE_KIND_CLASSES)[number];

/** 人话标签（面板与意图失败原因共用；`unknown` 不等于 `other`）。 */
export const DEVICE_KIND_CLASS_LABELS: Record<DeviceKindClass, string> = {
  curtain: '窗帘',
  aircon: '空调',
  light: '灯',
  fan: '风扇',
  switch: '开关/插座',
  sensor: '传感器',
  lock: '门锁',
  camera: '摄像头',
  speaker: '音箱',
  display: '屏幕',
  vacuum: '扫地机',
  other: '其它设备',
  unknown: '品类未识别',
};

export function isDeviceKindClass(value: string): value is DeviceKindClass {
  return (DEVICE_KIND_CLASSES as readonly string[]).includes(value);
}

/** 类目 → 人话；表外（含空串/历史脏值）一律按"品类未识别"，不冒充其它。 */
export function kindClassLabel(value: string): string {
  return isDeviceKindClass(value) ? DEVICE_KIND_CLASS_LABELS[value] : DEVICE_KIND_CLASS_LABELS.unknown;
}

/** 品类判定的**来源**（面板如实标注"它是怎么被认出来的"）。 */
export function kindClassSource(protocol: string): string {
  switch (protocol) {
    case 'mdns':
      return '局域网 mDNS 自述';
    case 'ssdp':
      return '局域网 SSDP 自述';
    case 'http':
      return 'HTTP 自述';
    case 'mqtt':
      return 'Home Assistant / MQTT 自述';
    case 'cloud':
      return '厂商云品类';
    case 'miio':
      return '米家设备型号';
    default:
      return '来源未知';
  }
}

export interface KindClassInput {
  /** 设备**自述**的类别（HA component、涂鸦 category、mDNS/SSDP 归纳词）。 */
  kind: string;
  /** 发现协议（决定用哪套自述词汇）。 */
  protocol: string;
  /** 设备自述的能力清单（仅 mdns/ssdp/http 会在 kind 认不出时作补充线索）。 */
  capabilities?: string[];
  /** 米家 `miio.info` 返回的 model（**须已配置 token 才能查到**；查不到就不传）。 */
  model?: string | null;
  /** HA `device_class`（用于区分 `cover` 是窗帘还是车库门/大门）。 */
  deviceClass?: string | null;
  /** 云 Provider id（当前仅 `tuya` 有真实现，未知时按涂鸦表尽力识别）。 */
  provider?: string | null;
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** 涂鸦 category → 类目（表外 `null`——**不猜**）。 */
const TUYA_CATEGORY_CLASS: Record<string, DeviceKindClass> = {
  cl: 'curtain',
  clkg: 'curtain',
  kt: 'aircon',
  ktkg: 'aircon',
  wk: 'aircon',
  dj: 'light',
  dd: 'light',
  xdd: 'light',
  tyd: 'light',
  tdd: 'light',
  tgq: 'light',
  kg: 'switch',
  cz: 'switch',
  pc: 'switch',
  fs: 'fan',
  fsd: 'fan',
  wsq: 'sensor',
  jwbj: 'sensor',
  mcs: 'sensor',
  pir: 'sensor',
  sb: 'vacuum',
  xdj: 'vacuum',
};

/** HA `cover` 的 device_class 里属于「门窗/车库/大门」的——**不归窗帘**（舒适规则不去开它）。 */
const COVER_NON_CURTAIN_CLASSES: ReadonlySet<string> = new Set([
  'garage',
  'gate',
  'door',
  'garage_door',
]);

/** 自述 kind 的**精确**词表（按协议自述原文，不做名字猜测）。 */
const EXACT_KIND_CLASS: Record<string, DeviceKindClass> = {
  // HA / 通用 component
  light: 'light',
  switch: 'switch',
  fan: 'fan',
  climate: 'aircon',
  cover: 'curtain',
  vacuum: 'vacuum',
  media_player: 'speaker',
  camera: 'camera',
  lock: 'lock',
  sensor: 'sensor',
  binary_sensor: 'sensor',
  humidifier: 'other',
  water_heater: 'other',
  siren: 'other',
  valve: 'other',
  scene: 'other',
  button: 'other',
  number: 'other',
  select: 'other',
  device_tracker: 'other',
  update: 'other',
  text: 'other',
  // 语义别名（设备自述里常见的同义词）
  curtain: 'curtain',
  blind: 'curtain',
  shade: 'curtain',
  window_cover: 'curtain',
  aircon: 'aircon',
  air_conditioner: 'aircon',
  hvac: 'aircon',
  bulb: 'light',
  lamp: 'light',
  plug: 'switch',
  socket: 'switch',
  outlet: 'switch',
  relay: 'switch',
  display: 'display',
  tv: 'display',
  speaker: 'speaker',
  printer: 'other',
  robot: 'vacuum',
};

/** 关键词兜底（只在精确表未命中时用；仍是**自述文本**，不是设备名）。 */
function keywordClassOf(text: string): DeviceKindClass {
  const k = norm(text);
  if (!k) return 'unknown';
  if (/(lock|doorlock|deadbolt)/.test(k)) return 'lock';
  if (/(camera|\bcam\b|ipcam|doorbell)/.test(k)) return 'camera';
  if (/(curtain|blind|shade|window_cover|windowcover|\bcover\b)/.test(k)) return 'curtain';
  if (/(aircon|air_conditioner|air conditioner|climate|hvac|conditioner)/.test(k)) return 'aircon';
  if (/(vacuum|robotclean|cleaner|sweeper)/.test(k)) return 'vacuum';
  if (/(light|\blamp\b|bulb|dimmer|ceiling)/.test(k)) return 'light';
  if (/(\bfan\b|ventilat)/.test(k)) return 'fan';
  if (/(switch|relay|socket|plug|outlet|powerstrip)/.test(k)) return 'switch';
  if (/(sensor|\btemp\b|humid|thermo|meter|probe|motion)/.test(k)) return 'sensor';
  if (/(speaker|audio|\bmedia\b|music|sound)/.test(k)) return 'speaker';
  if (/(display|\bscreen\b|\btv\b|monitor)/.test(k)) return 'display';
  return 'unknown';
}

/** 米家 model → 类目（`miio.info` 可查时）；表外 `unknown`。 */
function miioModelClass(model: string): DeviceKindClass {
  const m = norm(model);
  if (!m) return 'unknown';
  if (/(aircondition|air_conditioner|acpartner|conditioner)/.test(m)) return 'aircon';
  if (/(curtain|windowcover|window_cover|motor)/.test(m)) return 'curtain';
  if (/(light|lamp|ceil)/.test(m)) return 'light';
  if (/(plug|socket|outlet|powerstrip)/.test(m)) return 'switch';
  if (/(vacuum|cleaner|sweeper|robot)/.test(m)) return 'vacuum';
  if (/(\bfan\b|ventilat)/.test(m)) return 'fan';
  if (/humidifier/.test(m)) return 'other';
  return 'unknown';
}

/**
 * **唯一**品类归一函数。
 *
 * 次序：米家 model → 涂鸦 category → 自述 kind 精确表 → 自述 kind 关键词 →（仅 mdns/ssdp/http）能力文本兜底 → `unknown`。
 * ⚠ HA `cover` 的 `device_class` 为车库门/大门/门 ⇒ `other`，避免「有点亮/有点热」去开院门。
 */
export function kindClassOf(input: KindClassInput): DeviceKindClass {
  const protocol = norm(input.protocol);
  const kind = norm(input.kind);

  if (protocol === 'miio') {
    return miioModelClass(String(input.model ?? ''));
  }

  if (protocol === 'cloud') {
    const provider = norm(input.provider);
    if (provider === 'tuya' || provider === '') {
      const hit = TUYA_CATEGORY_CLASS[kind];
      if (hit) return hit;
    }
  }

  // HA cover 的 device_class **先于**精确表：车库门/大门不是窗帘（否则会被 `cover ⇒ curtain` 吃掉）。
  const deviceClass = norm(input.deviceClass);
  if (kind === 'cover' && deviceClass) {
    return COVER_NON_CURTAIN_CLASSES.has(deviceClass) ? 'other' : 'curtain';
  }

  if (EXACT_KIND_CLASS[kind]) return EXACT_KIND_CLASS[kind];

  const byKind = keywordClassOf(kind);
  if (byKind !== 'unknown') return byKind;

  // mDNS/SSDP/HTTP 的 service type / TXT 键是设备自述元数据——kind 认不出时用它兜底（不读设备名字）。
  if (protocol === 'mdns' || protocol === 'ssdp' || protocol === 'http') {
    const capText = (input.capabilities ?? []).map((c) => String(c ?? '')).join(' ');
    return keywordClassOf(capText);
  }

  return 'unknown';
}

/**
 * 台账设备可判定品类的**最小形状**（`AnsDevice` / rr 夹具 / 门牌入参同形）。
 * 只取判据真正读到的字段——不绑在 `AnsDevice` 上，纯数据模块不因此拉进库层。
 */
export interface KindClassDeviceLike {
  kind: string;
  kind_class?: string;
  protocol?: string;
  capabilities?: string[];
}

/**
 * 台账设备 → 类目：**优先读派生列** `kind_class`（M1 已归一），旧行/夹具缺列时按 `kindClassOf` 现算。
 * 这是「台账这一侧」的**唯一**入口；意图、能力卡、门牌三处都经它，不各写一份"先看列再看 kind"。
 */
export function deviceKindClassOf(dev: KindClassDeviceLike): DeviceKindClass {
  const stored = String(dev.kind_class ?? '').trim();
  if (stored) return isDeviceKindClass(stored) ? stored : 'unknown';
  return kindClassOf({
    kind: dev.kind,
    protocol: String(dev.protocol ?? ''),
    capabilities: dev.capabilities ?? [],
  });
}
