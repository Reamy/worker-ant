# 工蚁 · 官网落地页（`site/`）

静态单页，**零构建步骤、零外部依赖**（字体走系统栈，离线可用）。文案真源是
`business-plan/materials/landing-page.md`；本目录是它的**可部署形态**。

## 结构

```
site/
├── index.html      # 单页全部内容（九节：Hero / 痛点 / 三根矛 / 原理 / 用例 / 快速开始 / 竞品 / 定价 / FAQ）
├── styles.css      # 全部样式（含 prefers-color-scheme 深色模式与响应式）
├── 404.html        # Cloudflare Pages 的兜底页
├── brand-icon.png  # 品牌标 128px（取自 apps/worker-ant-desktop/assets/icon.png）
├── favicon-32.png / favicon-16.png / apple-touch-icon.png  # 同源派生
├── robots.txt / sitemap.xml
└── _headers        # Cloudflare Pages 安全响应头
```

## 本地预览

```bash
cd site && python3 -m http.server 8080
# 打开 http://127.0.0.1:8080
```

## 部署（Cloudflare Pages 直传）

```bash
npx wrangler pages deploy site --project-name worker-ant
```

→ 产出 `https://worker-ant.pages.dev`。随后在 Cloudflare 控制台把 `workerant.cn`
绑为该项目的自定义域；`worker-ant.cn` 配 301 永久重定向到 `workerant.cn`。

## ⚠ 诚实纪律（改文案前必读）

落地页**不许承诺产品还没做到的事**（承 `landing-page.md` 首条纪律）：

- 「下载 macOS 版」按钮指向 **GitHub Releases v0.2.0 的真实 dmg**（Apple Silicon，macOS 13+），Release 页附 SHA-256 校验值；zip 作为备用入口。**不放假的下载链接**——页面上的每个下载入口都必须真能下载到已发布的安装包。
- 付费档位：**Pro 与早鸟终身标「已开售」**，链接指向面包多店铺（与桌面端 `core/pricing.ts` 的 `PURCHASE_URL` 同一落点）；**Team 授权包标「已开售」**（¥599/月 · ¥5990/年，每包 ≤20 节点，人工开通）；**企业私有化标「路线图」**。
- **两件事分开说**：授权已开售，安装包**已发布**（macOS 已完成 Developer ID 签名与 Apple 公证，仅 arm64、macOS 13+；Intel Mac 与 Windows 暂未提供）。桌面端自带 14 天 Pro 试用。
- 主 CTA 是下载安装包；次 CTA 指向 GitHub 源码仓库，「方式二：从源码运行」仍然保留，两条路都可以走。

改动前先读 `business-plan/materials/landing-page.md` 的 `[待落地]` 标注。
