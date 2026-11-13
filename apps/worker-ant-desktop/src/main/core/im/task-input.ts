/**
 * zx_20261031_1 M1（道德经·名亦既有，夫亦将知止 / 维特根斯坦·意义即使用）:
 * **IM 建任务时「标题/描述」如何切**，只此一处。
 *
 * 病根：旧实现在 `im-router.ts` 内联 `cleaned.search(/[\s，,。．.！!？?；;、:：]/)`，
 * 把**任何空白**都当句界。中文句子夹英文词时，空格是排版而非分句——
 * 用户原话 `把这周本仓库的 git 提交整理成一份周报，…` 落库标题成了 `把这周本仓库的`。
 * 英文句子里空格确实是词/句的分界（`fix login bug` → `fix`），故规则按**两侧字符**判：
 * 只有空白**两侧都不是汉字**时，空白才算界；中文句读永远是界。
 */

/** 标题长度上限（旧实现即 50，语义未变）。 */
export const TASK_TITLE_MAX = 50;

/** `@项目名` 提及（不含空白与中文句读）。 */
const MENTION_RE = /@[^\s@，。,\.！!？?：:；;、]+/g;

/**
 * 建任务命令脚手架：`创建任务:` / `新建任务 ` / `帮我做 ` 等。
 *
 * zx_20261112_2 B2：**长词优先 + 量词可选**。旧写法把 `创建一个任务：写周报` 只剥掉「创建」，
 *   留下「一个任务：写周报」⇒ 标题成了「一个任务」。现在 `创建一个?` 先吃掉「创建一个」，
 *   再由 `(任务)?` 吃掉「任务」，标题才是「写周报」。
 */
const SCAFFOLD_RE = /^(帮我做|帮我|创建一个?|创建|新建一个?|新建|建一个|建个|做一个|做)\s*(任务)?\s*[:：]?\s*/i;

/** 无论两侧是什么，这些句读一律为界。 */
const HARD_BOUNDARY = new Set(['，', ',', '。', '．', '.', '！', '!', '？', '?', '；', ';', '、', ':', '：']);

/** 汉字（含 `一-龥` 常用区）。用于判「空格是不是排版」。 */
function isHan(ch: string): boolean {
  return /[一-龥]/.test(ch);
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * 标题的起点之后，第一处**真正的句界**下标；没有则返回 -1。
 *
 * 规则（与旧行为的关系）：
 *   - 中文句读：一律为界（旧行为不变）；
 *   - 空白：仅当**左右两侧都不是汉字**时为界——纯英文句子（`fix login bug`）切法不变；
 *     中文里夹英文词时（`的 git 提交`）空格不是界，继续取到中文句读。
 */
export function findTitleBoundary(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (HARD_BOUNDARY.has(ch)) return i;
    if (!isSpace(ch)) continue;
    const left = text[i - 1];
    const right = text[i + 1];
    const leftHan = left !== undefined && isHan(left);
    const rightHan = right !== undefined && isHan(right);
    if (!leftHan && !rightHan) return i;
  }
  return -1;
}

export interface SplitTaskInput {
  /** 首句，≤ `TASK_TITLE_MAX`。空标题表示用户没给正文。 */
  title: string;
  /** 余下正文；无余下时为 `''`。 */
  description: string;
}

/**
 * IM 消息 → `{ title, description }`。清洗顺序与旧实现逐字一致：
 * 先清 `@提及`、再清建任务脚手架、再 `trim`、再按首句拆、最后封顶标题。
 *
 * 未切分时（文本只有一句 / 首字符即句读）整段作标题——**与旧实现同**（旧代码只认 `> 0`）。
 */
export function splitTaskInput(raw: string): SplitTaskInput {
  const cleaned = raw.replace(MENTION_RE, '').replace(SCAFFOLD_RE, '').trim();
  let title = cleaned;
  let description = '';
  const boundary = findTitleBoundary(cleaned);
  if (boundary > 0) {
    title = cleaned.slice(0, boundary).trim();
    description = cleaned.slice(boundary).trim();
  }
  return { title: title.slice(0, TASK_TITLE_MAX), description };
}
