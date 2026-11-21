<h1 align="center">pi-superagent</h1>

<p align="center">基于 Pi SDK 的本地策略治理型编码与任务 Agent。</p>

<p align="center"><a href="docs/README.en.md">English</a></p>

## 这是什么

`pi-superagent` 将领域模型与授权规则独立于运行时之外。单个进程持有一个状态目录，从 Source 接收事件、评估任务、为 Ticket 运行持久化 Pi 会话，并通过 Channel 上报结果。它不是 DSH 运行时，也不依赖 `@deepseek-ai/*` 包。

| 模块 | 实现位置 |
| --- | --- |
| 领域模型、Ticket、Eval、Mandate | `src/core/` |
| 授权与策略版本控制 | `src/policy.ts`、`src/admission.ts` |
| 协调与路由 | `src/agents/pi-coordinator.ts` 中的持久化 `PiCoordinator` |
| Ticket 执行 | `src/agents/pi-executor.ts` 中的持久化 Pi worker 会话 |
| 存储与持久化效应队列 | `src/store/`、`src/runtime/` |
| Source 接入 | `src/sources/` 中的 GitHub、本地 IM 与通用 Inbox |
| CLI 与管理 | `src/cli.ts`、`src/cli/commands/`、`src/runtime/management.ts` |
| Web 面板 | 仅作为 CLI 管理桥接，由 `pi-superagent web` 提供服务 |

持久化协调器为主会话，可路由显式请求、评估推断候选、读取领域资源、回复、挂载或停止任务并协调 Ticket。Worker 为按 Ticket 隔离的持久化会话，通过类型化工具调用 Engine；模型输出文本本身不构成状态迁移。

实现基于 Pi SDK（`@earendil-works/pi-coding-agent` 1.5.0）与持久化会话文件。会话初始化会从工作目录与 Pi agent 目录动态加载 MCP、skills、extensions、codemode 与 tool search 等 Pi 资源；提示词文本由实例持有的提示词修订版本动态提供。本项目未内置后台任务监管器或子 Agent 框架；常规委派可通过 Pi 维护的 [subagent extension example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) 启用，但应用默认不开启且不提供持久化子任务恢复。

执行策略不限于编码任务：当部署环境授权时，Inbox 与 IM Source、协调器工具及通用 worker 提示词同样支持答疑、运维、Issue 处理等非编码任务。Worker 支持回合中引导（`session.steer()`）：纠偏指令会在当前助手回合及其工具调用完成后、下一次模型请求前进入；Ticket 保留自身状态，可在重启后恢复持久化 worker 会话。

## 功能

- **多 Source 事件接入**：
  - **GitHub**：可选 Source，使用 `gh` 轮询与写入；不配置仓库或 `gh` 账号亦可独立运行。
  - **IM**：面向脚本与交互式工作的本地通道 Source。
  - **Inbox**：通用外部事件 Source，接收 IM、Issue 追踪器或其他适配器的标准 JSON 事件，并将适配器回复写入 JSONL 供外部脚本读取；无网络轮询循环。Inbox 与 IM 均不引入网络服务或插件平台。
- **持久化协调与状态隔离**：协调器与 Ticket worker 均以持久化会话运行，通过本地只读 SQLite 与效应队列保证状态一致。
- **配置与提示词热更新**：配置与提示词变更可通过本地 IPC 通知运行中的实例。提示词修订以不可变版本存储，可热应用至下一次会话回合；`config set` 与提示词变更会向持久化协调器发送下一轮通知。
- **本地 Basalt 管理面板**：`pi-superagent web` 为 React 管理面板提供回环 CLI 桥接，常规部署中由 `https://superagent.dev.hexly.ai` 转发至 `127.0.0.1:7062`。

## 使用

启用 Inbox 并接收事件：

```sh
pi-superagent config set --inbox --inbox-allowed 'linear:alice@example.com' --inbox-observed linear

cat > event.json <<'EOF'
{"system":"linear","id":"evt-1","thread":"LIN-42","actor":"alice@example.com","text":"Fix the login button","human":true,"addressed":true}
EOF

pi-superagent source receive --file event.json
pi-superagent source replies --system linear --limit 20
```

`source receive --file -` 支持从标准输入读取事件 JSON；`source replies` 读取本地适配器投递记录，不代表远端系统已确认接收。

常用 CLI 命令涵盖状态、Source、Thread、Trigger、Decision、Ticket、配置、协调器、提示词、Inbox、对话与运行 Agent：

```sh
pi-superagent status
pi-superagent source
pi-superagent source receive --file event.json
pi-superagent source replies --system linear --limit 20
pi-superagent coordinator show
pi-superagent coordinator read --lines 40
pi-superagent config set --mode observe
pi-superagent prompt show
pi-superagent prompt set --file prompts.json --base-revision 1
pi-superagent web --port 7062
pi-superagent run --verbose
```

配置通过 `pi-superagent config set`、`config edit` 或 `config import` 修改；`run` 命令不提供仓库或允许登录名初始化参数。GitHub 通过 `config set --repository` 与 `--allowed` 配置，Inbox 通过 `--inbox`、`--inbox-allowed` 与 `--inbox-observed` 配置。

## 开发

运行环境要求 Node >=22.19.0（CI 锁定 `26.12.1`）与 `pnpm 11.6.0`：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm dev
pi-superagent run
```

`pnpm dev` 会执行构建并以本地 Web 管理面板模式启动（`127.0.0.1:7062`）。

## 测试

```sh
pnpm test
pnpm check
pnpm exec vitest run tests/docs.spec.ts
```

- `pnpm check` 依次执行类型检查（`pnpm typecheck`）、构建（`pnpm build`）与 Vitest 测试套件（`pnpm test`）。
- `pnpm exec vitest run tests/docs.spec.ts` 用于在仓库变动期间执行限定范围的文档链接检查。
- 实机探针位于 `scripts/probe-system.ts`，仅在操作员主动执行 `pnpm test:live` 时运行，使用本地配置的 `127.0.0.1:3425` 上 `magpie/group/coding` 模型（不纳入 CI）。

以下为历史验证实验记录，不代表当前测试计数或所有特性均已重跑：

- 回合中引导曾通过 `scripts/probe-steer.ts` 实测：纠偏指令出现在会话文件的工具调用之间，并中止了剩余工作。
- 早期针对本仓库的自举运行产出过独立 worktree、worker 会话、单行修复与 Pull Request。
- 账本、GitHub 与引导探针作为可复现证据保留在仓库脚本中。

## 技术栈

| 领域 | 选型 |
| --- | --- |
| 运行时与 CLI | Node.js（>=22.19.0）、TypeScript、Commander、Zod、TypeBox、proper-lockfile |
| Agent SDK | `@earendil-works/pi-coding-agent`（1.5.0） |
| Web 面板 | React 19、Vite、Tailwind CSS、`@nocoo/basalt` |
| 测试 | Vitest、Playwright |

## 文档

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 CLI](docs/005-cli.md)
- [006 Deployment](docs/006-deployment.md)
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md)
- [009 Bootstrap](docs/009-bootstrap.md)
- [010 CLI-first supervision](docs/010-cli-first-superagent.md)
- [011 Basalt dashboard](docs/011-basalt-dashboard.md)
- [项目工程约束与检查口径](AGENTS.md)
- [事故复盘](Retrospective.md)

## 许可证

MIT（见 [LICENSE](LICENSE)）。`src/core/`、`src/policy.ts`、`src/admission.ts`、`src/runtime/`、`src/store/` 与 `src/sources/` 保留其原有治理与 Source 谱系。
