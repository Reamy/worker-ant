/**
 * zx_20260924 §2c UI-3（维特根斯坦·语言游戏 / 一处真源）: 产出物**盘上路径 → 目录树**的唯一实现。
 *
 * 为什么单独立模块、且**零依赖**（不引 electron / better-sqlite3 / node:*，同 `attachment-kinds` /
 * `settings-bool` / `attachment-outcome` 范式）：它承载的是**三条规则**，不是一段 JSX——
 *   ① **公共前缀要剥掉**：真库里 `file_path` 是绝对路径，同任务各件共享一长段前缀
 *      （如 `/Users/…/workrepo/代码/`），逐段原样展开会让每个叶子挂 5–8 层纯噪音目录，反而看不出结构；
 *   ② **没有盘上路径的件不许塞进假目录**：那会凭空造出一个"这些件在哪个目录下"的事实；
 *   ③ **单子目录链要并段**（`freezeNode`，详见其注释）：只有一条路的中间层名字不算结构。
 * 规则要能被受控复跑按**两侧标本**钉住（rr 引不动 React 页面），故实现放这里、渲染层引同一份。
 */

/** 树里的一个**文件叶**。`name` 是**相对**名（公共前缀已剥），`fullPath` 是原样的完整路径（悬停用）。 */
export interface DeliverableTreeLeaf<T> {
  kind: 'file';
  name: string;
  fullPath: string;
  item: T;
}

/** 树里的一个**目录节点**。`count` 是**其后代文件数**（不只是直接子文件）——折叠/缩进时靠它看出分量。 */
export interface DeliverableTreeDir<T> {
  kind: 'dir';
  name: string;
  count: number;
  children: DeliverableTreeChild<T>[];
}

export type DeliverableTreeChild<T> = DeliverableTreeLeaf<T> | DeliverableTreeDir<T>;

export interface DeliverableTree<T> {
  /** 有盘上路径的件构成的树：**目录在前、文件叶在后**，同层各按名字序（目录树的常规读法）。 */
  root: DeliverableTreeChild<T>[];
  /** **没有**盘上路径的件——如实单列。**不塞进任何目录**（塞了就是编造"它在哪"）。 */
  noPath: T[];
  /** 被剥掉的公共目录前缀（分段原样）。供界面如实说明"相对哪个根"，也让"剥了什么"可被断言。 */
  commonPrefix: string[];
}

/** `[/\\]+` 两处分隔符都认（盘上路径可能出自 Windows 侧）。 */
const SEP = /[\\/]+/;

/** 路径 → 非空分段（连续分隔符与首尾分隔符都不产生空段）。 */
function segmentsOf(p: string): string[] {
  return p.split(SEP).filter((s) => s.length > 0);
}

/**
 * 求**目录段**的最长公共前缀——**末段（文件名）不参与**。
 *
 * 末段一旦参与，同一目录下的 `a.md` 与 `b.txt` 就没有公共前缀了，等于白剥；
 * 而"目录相同"恰恰是要剥掉的那部分。**只有一个件时，它的目录即前缀**（叶子只剩文件名，全路径在悬停里）。
 */
export function commonDirPrefix(allSegs: ReadonlyArray<readonly string[]>): string[] {
  if (allSegs.length === 0) return [];
  const dirs = allSegs.map((s) => s.slice(0, Math.max(s.length - 1, 0)));
  let n = dirs[0]?.length ?? 0;
  for (const d of dirs) n = Math.min(n, d.length);
  let i = 0;
  for (; i < n; i++) {
    const seg = dirs[0]![i];
    if (!dirs.every((d) => d[i] === seg)) break;
  }
  return dirs[0]!.slice(0, i);
}

interface RawNode<T> {
  dirs: Map<string, RawNode<T>>;
  files: Array<{ name: string; fullPath: string; item: T }>;
}

function emptyNode<T>(): RawNode<T> { return { dirs: new Map(), files: [] }; }

/**
 * `RawNode` → 排好序的对外结构（目录在前、文件叶在后；同层按名字序，`localeCompare` 认中文）。
 *
 * 顺带做 **③ 单子目录链合并**：某目录**只**有一个子目录、且自身没有文件叶时，两段并成一段
 * （`src` → `main/java/com/sfi/…` 逐级合并），因为**中间那些只有一条路的段不构成"结构"**，
 * 只是一条被拆成 N 行的名字——真库标本里 Java 包路径会挂到 8–10 层单链，
 * 缩进吃掉半个版面，正是本模块第①条要治的同一种噪音（那里是"公共前缀"，这里是"公共中缀"）。
 * 递归天然处理长链：子树已合并到自身极限，故每个节点只需看**直接**子节点一次。
 * ⚠ 合并的是**名字**，不是**层级语义**：`count` 仍是后代件数，路径分段仍原样，只是连写。
 */
function freezeNode<T>(node: RawNode<T>): { children: DeliverableTreeChild<T>[]; count: number } {
  const dirs = [...node.dirs.entries()]
    .map(([name, child]) => ({ name, ...freezeNode(child) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  const children: DeliverableTreeChild<T>[] = [
    ...dirs.map((d): DeliverableTreeDir<T> => {
      const only = d.children.length === 1 ? d.children[0]! : null;
      // 唯一的子节点仍是目录 ⇒ 并段。子节点若已自己并过（`b/c`），这里就成了 `a/b/c`，故长链一次遍历即到底。
      return only && only.kind === 'dir'
        ? { kind: 'dir', name: `${d.name}/${only.name}`, count: only.count, children: only.children }
        : { kind: 'dir', name: d.name, count: d.count, children: d.children };
    }),
    ...files.map((f): DeliverableTreeLeaf<T> => ({ kind: 'file', name: f.name, fullPath: f.fullPath, item: f.item })),
  ];
  return { children, count: dirs.reduce((s, d) => s + d.count, 0) + files.length };
}

/**
 * 产出物列表 → 目录树。
 *
 * 纯函数：**不筛不重不丢**——把 `root` 展平后加上 `noPath`，条目集合与传入**逐条相等**
 * （"换个摆法"不许变成"少了几个件"；这条由 rr 的两侧标本钉住）。
 */
export function buildDeliverableTree<T extends { file_path?: string }>(items: readonly T[]): DeliverableTree<T> {
  const withPath: Array<{ segs: string[]; item: T }> = [];
  const noPath: T[] = [];
  for (const item of items) {
    const p = (item.file_path || '').trim();
    if (!p) { noPath.push(item); continue; }
    const segs = segmentsOf(p);
    // 全由分隔符组成的路径（`/`、`\\`）没有文件名可言 ⇒ 与"没有路径"同处——**不造一个空名叶子**。
    if (segs.length === 0) { noPath.push(item); continue; }
    withPath.push({ segs, item });
  }

  const commonPrefix = commonDirPrefix(withPath.map((w) => w.segs));
  const root = emptyNode<T>();
  for (const { segs, item } of withPath) {
    const rel = segs.slice(commonPrefix.length);
    // 公共前缀**理论上**绝不会吃掉末段（末段不参与前缀比对）；万一为空（病态输入），退回"只剩文件名"而不是丢件。
    const use = rel.length > 0 ? rel : [segs[segs.length - 1]!];
    let node = root;
    for (const seg of use.slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) { next = emptyNode<T>(); node.dirs.set(seg, next); }
      node = next;
    }
    node.files.push({ name: use[use.length - 1]!, fullPath: (item.file_path || '').trim(), item });
  }
  return { root: freezeNode(root).children, noPath, commonPrefix };
}
