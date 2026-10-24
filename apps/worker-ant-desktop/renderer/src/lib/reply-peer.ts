/**
 * IM 手工回话的**收件人判定** —— zx_20261002 M3(维特根斯坦·意义即使用 / 管子·度量衡)。
 *
 * 病根（方案 §1.1-6）：收件人恒取 `convs[0]`（列表最新一条），而 `convs` 受服务端搜索/方向筛选
 * （`convFilter`）与入站前插（`prependNewConvs`）影响 —— 开着筛选、或**输入时来了新入站**，
 * 「发送给 X」就被**静默顶成另一个人**：用户什么都没改，收件人却变了（说出去的话寄错了人）。
 *
 * 定为：**显式选择优先，永不被列表变化顶替**。
 *   - `selected` 非空 ⇒ 就用它，**哪怕它已不在当前列表里**——宁可如实提示"不在筛选结果中，仍将发给他"，
 *     也不替用户改人（"不猜、不给裸 id 输入口"的同一口径）；
 *   - `selected` 为空 ⇒ 取列表最新一条作**默认**（与既有"明写最新一条"一致，只是它现在**只在未被显式选定**时生效）。
 *
 * 判定收在此一处：界面的标签、发送、发件都读同一个函数；rr 直跑它（先例 `convDelivery.ts`）。
 */
export interface ReplyPeerView {
  /** 实际将发送到的对象（空串 = 无可回话对象）。 */
  peer: string;
  /** 是否来自**显式选择**（true ⇒ 列表变化不会顶替它）。 */
  selected: boolean;
  /** 显式选定的对象**不在当前列表**中（须如实提示，不得静默改人）。 */
  missing: boolean;
}

export function resolveReplyPeer(
  selected: string | null,
  list: Array<{ external_user_id?: string | null }>,
): ReplyPeerView {
  const present = (u: string): boolean => list.some((c) => (c.external_user_id || '') === u);
  if (selected) return { peer: selected, selected: true, missing: !present(selected) };
  const head = list[0]?.external_user_id || '';
  return { peer: head, selected: false, missing: false };
}

/** 「已选定的对象不在当前筛选结果里」的如实提示；其余情形无话可说（返回 null，界面不啰嗦）。 */
export function replyPeerNotice(view: ReplyPeerView): string | null {
  return view.selected && view.missing ? '所选对象不在当前筛选结果中，仍将发给他' : null;
}
