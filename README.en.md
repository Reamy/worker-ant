# 🐜 Worker Ant

> **A self-hosted AI agent crew you command from your phone.**

<!-- TODO: 30-second demo GIF (one chat message → real work done on your machine → a deliverable) -->

Describe a task in plain language. It **actually** edits files, runs commands, and commits to git — **on your own machine**.
Deliverables are registered as first-class artifacts. And when you're away from your desk, one message on WeChat / DingTalk / Feishu gets you progress, approvals, and results.

**Your code never leaves home. Your tasks never sleep.**

[中文](README.md) · [Contributing](CONTRIBUTING.md) · [License](#license)

---

## Why Worker Ant

| The problem                                                  | How most tools do it           | How Worker Ant does it                                                   |
| ------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------ |
| You need real work done, but your code can't go to the cloud | Cloud agents upload your repos | **Executes locally** — code and data never leave your machine            |
| You want to check on a task while away                       | Only from your desk            | **Command it from IM**: WeChat / DingTalk / Feishu / WeCom / QQ          |
| Finished work is buried in chat logs                         | Output is a wall of text       | **Deliverables as first-class artifacts** — registered, rated, traceable |
| You can't tell what the agent actually did                   | Black box                      | **Event sourcing** — every action auditable and replayable               |

---

## Core capabilities

- **62 tools across 8 categories**: shell, file I/O, git, memory, search, MCP, subagents, device control…
- **Multi-agent**: automatic task decomposition; subagents (deploy / explorer / builder / verifier), debate, and swarm modes
- **Memory & knowledge graph**: episodic / semantic / procedural / retrospective memory that improves with use
- **IM-native**: WeChat / QQ / DingTalk / WeCom / Feishu — send a message to assign, track, approve, and receive
- **Bring your own model**: BYO key, point it at any OpenAI-compatible endpoint or your own gateway
- **Event-sourced engine**: pause / resume / replay, rateable deliverables, full audit trail

---

## Quick start

### Run from source (available today)

```bash
# Requirements: Node.js >= 22, pnpm >= 9
pnpm install

# Terminal 1 — start the AI resource center (ANS)
pnpm dev:ans

# Terminal 2 — start the desktop app (run in macOS Terminal.app, not an IDE terminal)
#   ⚠ Terminal 1 must be started first: run.sh rebuilds the shared native module
#     better-sqlite3 for the Electron ABI, while ANS needs the Node ABI — the two
#     are mutually exclusive. See "About ANS".
cd apps/worker-ant-desktop && bash run.sh
```

On first launch a **setup wizard** walks you through adding a model API key (or pointing at your own gateway) → verifying the ANS connection → creating a project → describing a task in one sentence.

> 📦 **Installers (macOS / Windows) are in preparation** — once the first public release ships, you'll be able to install without the source.

### About ANS (AI Resource Center)

The desktop app needs ANS to route models. **When running from source, start ANS first in a separate terminal: `pnpm dev:ans`** (it starts ANS with the Node ABI).

The desktop app has an on-demand auto-start, but **it does not work in source mode**: `run.sh` / `desktop:dev` rebuild the **shared** native module `better-sqlite3` for the **Electron ABI**, while ANS needs the **Node ABI** — the two are mutually exclusive, so auto-start **fails honestly and tells you to run `pnpm dev:ans` first** rather than hanging silently (a packaged build ships no ANS entry point and likewise falls back). Default port `27183`, overridable with `ANS_SERVER_PORT`. All desktop→ANS calls are **HMAC-signed outbound**.

---

## Three real use cases

1. **Weekly report automation** — "Summarize this repo's git commits from the past week into a report, grouped by module."
2. **Repo health check** — "Scan the whole repo for TODO/FIXME, group by file, and draft GitHub issues."
3. **Service watchdog** — "Check these services every 30 minutes and alert me on WeChat if anything is down."

(The template library ships more ready-to-run examples.)

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Desktop (Electron)                          │
│  ┌────────────┐   IPC   ┌──────────────────┐ │
│  │  renderer  │◀────────▶│  main process     │ │
│  │  (React)   │          │  · task engine    │ │
│  └────────────┘          │  · agent loop     │ │
│                          │  · memory / KG    │ │
│                          │  · IM adapters    │ │
│                          │  · deliverables   │ │
│                          └────────┬─────────┘ │
└───────────────────────────────────┼───────────┘
                                    │ signed (HMAC)
                          ┌─────────▼─────────┐
                          │  ANS :27183        │
                          │  model match / gw  │
                          └─────────┬─────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  Your model        │
                          │  (OpenAI-compat)   │
                          └───────────────────┘
```

> The current main form is the **Electron desktop app: the whole engine runs inside the main process**. `apps/_archive/` holds a historical (pre-2026-08) web/server form and is excluded from build and release.

---

## Editions & pricing

| Edition                      | Price                                      | What you get                                     |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------ |
| **Community** (this repo)    | Free                                       | Full engine, BYO key                             |
| **Pro**                      | ¥99/mo · ¥899/yr                           | Cloud sync, premium templates, priority support  |
| **Team**                     | ¥199/seat/mo (planned — not yet available) | Shared memory/templates/deliverables, audit view |
| **Enterprise (self-hosted)** | Custom (planned — not yet available)       | Air-gapped deploy + SLA                          |

> Pro/Team value lives in the cloud service; **this repository (desktop + engine) stays open source.** Prices are in CNY (¥).

---

## Community & contributing

- Issues & ideas: GitHub Issues
- Chat: Discord (coming soon)
- Guide: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## License

[AGPL-3.0](LICENSE). Commercial multi-tenant use requires a separate commercial license — see [`COMMERCIAL_LICENSE.md`](COMMERCIAL_LICENSE.md).

---

<sub>Worker Ant System</sub>
