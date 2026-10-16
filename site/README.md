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

- 「下载 macOS」按钮**不是**真下载链接——安装包尚未交付，页面上如实标为「即将推出」。
- 付费档位（Pro / Team / 早鸟）**标为「即将开放」**——支付通道未通，只有 Community 现在可用。
- 主 CTA 指向 GitHub 源码仓库，与「方式二：从源码运行」一致，这是**当前唯一可走的路**。

改动前先读 `business-plan/materials/landing-page.md` 的 `[待落地]` 标注。
