# 贡献指南（Contributing to Worker Ant / 工蚁）

> 感谢你有兴趣参与。本仓以 **AGPL-3.0** 开源（见 [`LICENSE`](LICENSE)），并保留商业许可（见 [`COMMERCIAL_LICENSE.md`](COMMERCIAL_LICENSE.md)）。
> 为了让项目所有者能够**双许可**发布（AGPL + 商业），贡献者须同意下文的 **CLA**。

---

## 1. 贡献许可：CLA（已决策）

**决策：采用 CLA（贡献者许可协议），而非仅 DCO。**

**理由**：本仓保留一条"闭源商业版"路径（云端/团队/企业特性，见 `COMMERCIAL_LICENSE.md` §3）。若只用 DCO（`Signed-off-by`），外部贡献仍归属贡献者本人，所有者**无权**将其并入闭源商业版——等于自断商业路。CLA 则明确：贡献者授予所有者以**任意许可**（含闭源）再许可该贡献的权利，同时贡献者保留自己的著作权。

**当前机制（轻量起步）**：

- 本仓目前**尚未接受外部 PR**（项目处于早期，尚无正式 CLA 流程）。在此之前，请先开 Issue 讨论。
- 待开放外部 PR 时，将启用 **CLA 助手**（如 [CLA Assistant](https://cla-assistant.io/)）——首次 PR 时以评论形式一键签署，无需邮寄纸质文件。
- **在此之前**，任何被合并的贡献都必须同时包含：
  - `Signed-off-by: 你的名字 <邮箱>`（DCO 形式，声明你有权提交且同意 CLA），且
  - PR 描述中一句明确声明：`I agree to the Contributor License Agreement of this project.`

> 简言之：**CLA 是决策，DCO 的 `Signed-off-by` 只是签署动作的载体。** 两者并存，不冲突。

---

## 2. 开发流程

1. **先开 Issue**（或先看有没有现成的）——说明你要解决的问题、你的思路；避免重复劳动。
2. **Fork → 分支 → 提交**：分支名建议 `feat/…` / `fix/…`。
3. **本地验证**（务必全绿再提 PR）：
   ```bash
   pnpm install
   pnpm typecheck                       # 类型
   pnpm --filter @worker-ant/desktop-renderer build
   pnpm rr:all                          # 受控回归（并行；需先 tsup，见下）
   ```
   - 引擎核心改动**先构建**再回归：`pnpm --filter @worker-ant/desktop build`（部分断言读 `dist`）。
   - 单个回归脚本：`npx tsx scripts/rr_zx_XXXX.ts`。
4. **提交信息**：约定式提交（`feat:` / `fix:` / `docs:` / `refactor:` …），说明**为什么**而不只是做了什么。
5. **开 PR**：描述里写清改动、验证方式、影响面；带上 `Signed-off-by` 与 CLA 声明（见 §1）。

---

## 3. 代码与文档约定

- **TypeScript strict**；不引入未使用依赖；不为"假想需求"提前抽象。
- **真源唯一**：同一事实只写一处（价格、端口、档位上限、build 标识等都有既定真源，改动须同步其"第二落点"，详见 `CLAUDE.md`）。
- **回归脚本（`scripts/rr_*.ts`）是本项目的核心资产**：修 bug / 加功能时，优先补一条能**复现该缺陷**的断言，而不是只改实现。判据要"能被合法数据满足"，且用**两侧标本**（该命中的与不该命中的）。
- **文档**：`docs/` 内含**归档前形态**的旧文档（:9410/:9411 三服务架构已归档），修改请以源码与 `CLAUDE.md` 为准，并标注清楚。
- **品牌与在先使用**：本项目以「工蚁」／「Worker Ant」**两枚标识**公开使用；品牌**在先使用**的固证台账见 [`docs/prior-use-evidence.md`](docs/prior-use-evidence.md)（**首发当日起追加留痕**，**只追加、不修改历史行**）。改动项目名称 / 品牌表述时，请同步该台账与 README（中英两版）。

---

## 4. 报告问题

- **Bug / 功能建议**：开 GitHub Issue，附版本、复现步骤、期望行为、实际行为、日志。
- **安全漏洞**：请**不要**开公开 Issue，见 [`docs/SECURITY.md`](docs/SECURITY.md)。

---

## 5. 行为准则

保持专业与尊重。技术分歧对事不对人；审查意见聚焦代码与设计，不针对个人。

---

<sub>工蚁系统 · Worker Ant System</sub>
