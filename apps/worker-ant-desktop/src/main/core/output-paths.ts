/**
 * zx_20261021_4 批一：从任务文本里解析「应产出的文件路径」——**唯一一处**。
 *
 * 患者是两条都要用同一把尺的判据：
 *   ① 执行器的「产出未落盘」闸（`expectedOutputMiss`）；
 *   ② 拆解器的「同产出路径必须串行」推断（`inferSubtaskDeps`）。
 * 若两处各写一份正则，必然分家：一个把 `保存到 X.md` 当产出、另一个只认 `写入 X.md`，
 * 于是拆分说「互不依赖」而执行器说「两处都在改同一个文件」。
 *
 * 只匹配**明确的产出动词** + 文件扩展名，避免把「读取参考文件」误判为产出。
 */
// ⚠ 文件名里常见中文（本项目 `docs/排期方案.md` 这类是常态）：`\w` 不含 CJK ⇒ 单用它会把
//   中文文件名整条漏掉，于是「同产出路径须串行」与「产出未落盘」两道尺都对中文产出失效。
//   故显式并入 `一-龥`（CJK 统一汉字），其余仍是"无空白、无引号括号路径字符"。
const OUTPUT_VERB_RE = /(?:写入|写到|写回|写出|落盘|落到|保存到|保存为|输出到|生成到|生成文件|产出到|写至)\s*(?:指定文件|目标文件|输出文件|文件)?\s*[`"《【【\[]?\s*([\w./\\\-一-龥]+\.(?:md|txt|json|py|ts|tsx|js|jsx|sql|yaml|yml|csv|log|toml|xml))\s*[`"》】\]]?/g;

/** 任务文本中显式声明的产出路径（去重、保持出现顺序）。空文本返回 []。 */
export function extractExpectedOutputPaths(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const m of text.matchAll(OUTPUT_VERB_RE)) {
    const p = m[1]?.trim();
    if (p && !found.includes(p)) found.push(p);
  }
  return found;
}

/**
 * 路径归一，仅用于「是不是同一个产出目标」的比较：
 * 去掉开头的 `./`、把反斜杠统一成正斜杠。**不做实路径解析**（拆解时文件还不存在）。
 */
export function normalizeOutputPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}
