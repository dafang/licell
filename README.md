# Licell CLI (`licell`)

[English README](./README.en.md)

Licell 是一个面向阿里云的部署与运维 CLI，同时兼顾人类用户与 AI Agent。

它不是把一堆云资源命令简单堆在一起，而是围绕一条主线工作流来设计：

- 一个主入口：`deploy`
- 一份项目状态：`.licell/project.json`
- 一套可组合的资源原子命令：`fn` / `oss` / `dns` / `domain`
- 一套面向 Agent 的统一表面：`catalog` / `--help` / `--output json` / `skills`

默认地域为 `cn-hangzhou`。用于 Agent 自动化时，建议使用独立测试账号或独立地域，不要直接共用生产环境。团队协作下，推荐采用后文的“团队授权分发”模式。

---

## 这是什么

如果你把 Vercel CLI 的“单主线体验”搬到阿里云，大致就是 Licell 想做的事情：

- **人类友好**：`init -> deploy -> release -> rollback`
- **Agent 友好**：命令自描述、结构化帮助、结构化输出、catalog、skills
- **架构清晰**：workflow 命令负责“得到结果”，原子命令负责“精确控制资源”

Licell 当前覆盖的核心能力包括：

- FC API 部署与发布
- FC Task 部署、异步触发与任务追踪
- OSS 静态站部署
- 自定义域名、HTTPS、CDN、DNS
- ACR / Docker 镜像部署
- Serverless 数据库与缓存辅助能力
- ECS 实例查询、详情诊断与生命周期操作（启动 / 重启 / 停止 / 删除）
- 面向 Agent 的 Skills / catalog / JSON 输出 / 文档共源生成

---

## 核心设计

### 1. 主线 workflow 优先

大多数场景，先用面向结果的命令：

- `licell deploy --type api`
- `licell deploy --type static`
- `licell domain app bind`
- `licell domain static bind`
- `licell release promote`
- `licell release rollback`

这些命令的目标是让你更少思考底层资源编排。

### 2. 原子资源命令兜底

当你需要精确控制某个资源时，再用资源级命令：

- `licell fn domain ...`
- `licell oss domain ...`
- `licell dns records ...`
- `licell oss ...`
- `licell fn ...`

这层命令更适合：

- 做精细化排障
- 写定制化自动化脚本
- 让 Agent 逐步拆解复杂任务

### 3. 一份命令元数据，多处复用

Licell 最新架构里，命令不再只是“能执行”，还要“能自我描述”。

同一套命令注册表会驱动：

- CLI `catalog`
- CLI `--help`
- 结构化 help
- skills 脚手架
- README 生成区块
- Agent surface 文档
- shell completion

也就是说：**命令面变了，catalog、帮助、skills、文档会跟着一起收敛**。

---

## 安装

### 推荐：npm 全局安装

```bash
npm install -g licell
```

安装完成后，可直接运行：

```bash
licell
```

裸执行 `licell` 会进入首次引导流程。

### 安装后下一步：先完成授权

安装完成后，先完成授权即可开始使用。

持有 AK/SK 时，可直接执行：

```bash
licell login --bootstrap-ram
```

如果由 SRE / 平台团队统一分发授权，可直接执行：

```bash
licell auth restore '<token>' '<passkey>' --yes
```

团队协作场景，可参考下方的[团队授权分发（推荐）](#团队授权分发推荐)。

### 其他安装方式与升级

- 不希望依赖 Node.js 时，可改用 GitHub Release 安装脚本：`curl -fsSL https://github.com/team-harness/licell/releases/latest/download/install.sh | bash`
- npm 与安装脚本二选一，不要同时安装；PATH 中第一条 `licell` 会遮蔽另一份
- 升级时直接运行 `licell upgrade`
- 如需了解升级来源或升级渠道，再看下面这份说明

<details>
<summary>安装与升级的详细说明</summary>

<!-- BEGIN GENERATED:README_UPGRADE_GUIDANCE -->
- `licell upgrade` 会优先按“当前正在执行的安装来源”升级
- 不要同时保留多个全局安装来源；PATH 中排在最前的 `licell` 会遮蔽其它已升级版本，可用 `licell upgrade --dry-run --output json` 查看冲突入口
- 如果当前是 `npm` / `pnpm` / `yarn` / `bun` 全局安装，会调用对应包管理器执行全局升级
- 如果当前是项目内依赖、`node_modules/.bin/licell` 或开发链接，默认不会自动做全局升级
- 安装脚本和二进制都来自同一个 `releases/latest`，优先下载预构建单文件可执行；若当前平台暂无预构建资产，自动回退源码安装
- 如显式传入 `--repo` 或 `--script-url`，则强制走 GitHub release 升级渠道
- 可通过 `--channel auto|release|npm|pnpm|yarn|bun` 显式覆盖升级渠道；推荐先用 `licell upgrade --dry-run` 预览计划
<!-- END GENERATED:README_UPGRADE_GUIDANCE -->

</details>

---

## 3 分钟上手

### 给人类用户

```bash
licell login --region cn-hangzhou
licell init --runtime nodejs22
licell deploy --type api --target preview
```

### 给 Task 项目

```bash
licell login --region cn-hangzhou
licell init --runtime nodejs22 --kind task
licell deploy --type task --target preview
licell task invoke <appName> --target preview --payload '{"job":"demo"}'
```

### 给 Agent / 自动化调用方

推荐固定顺序：

```bash
licell deploy spec nodejs22 --output json
licell deploy check --runtime nodejs22 --entry src/index.ts --output json
licell deploy --type api --runtime nodejs22 --entry src/index.ts --target preview --output json
```

这样可以避免“部署成功但运行失败”的无效操作。

---

## 配置与状态模型

Licell 有三类核心状态：

| 类型 | 默认位置 | 说明 |
|------|----------|------|
| 全局认证 | `~/.licell-cli/auth.json` | 阿里云凭证与默认 region |
| 项目状态 | `<project>/.licell/project.json` | appName、环境变量、网络、部署状态；也可在 repo 根切换为 workspace 形式管理多个 component |

兼容性说明：

- Licell 仍兼容历史上的 `~/.ali-cli/auth.json` 等旧路径
- 当前主路径以 `~/.licell-cli/*` 为准

### Workspace / Monorepo

当同一个 repo 里有多个可部署目录（例如 `apps/web` 静态站 + `apps/api` FC API）时，
推荐在 repo 根维护一份 workspace 形态的 `.licell/project.json`：

```json
{
  "defaultComponent": "api",
  "components": {
    "web": {
      "path": "apps/web",
      "appName": "demo-web",
      "deployType": "static",
      "dist": "dist",
      "domain": "www.example.com"
    },
    "api": {
      "path": "apps/api",
      "appName": "demo-api",
      "deployType": "api",
      "runtime": "nodejs22",
      "entry": "src/index.ts",
      "target": "prod"
    }
  }
}
```

- 在 `apps/web` 目录执行 `licell deploy` 时，会自动解析到 `web` component。
- 在 `apps/api` 目录执行 `licell deploy` 时，会自动解析到 `api` component。
- deploy 成功后，Licell 会把稳定重跑所需的 deploy intent（如 `domain` / `domainSuffix` / `entry` / `dist` / `target` / `enableCdn` / `enableSSL` / `useVpc`）回写到对应 component，而不是只写少量字段。

## 团队授权分发（推荐）

当团队中只有少数人直接持有高权限 AK/SK 时，可以把“授权”和“使用”分开：

- SRE / 平台团队在受控机器上执行一次 `licell login`
- 然后执行 `licell auth export <passkey>`
- 把导出的 restore token 分发给团队成员
- 把 `passkey` 通过另一条通道单独发送，不要和 token 放在同一条消息里
- 其他机器直接执行 `licell auth restore <token> <passkey>`，不需要再次 `login`

示例流程：

```bash
# SRE 机器
licell login --region cn-hangzhou
licell auth export 'Team-Shared-Passkey'

# 成员机器
licell auth restore 'licell-auth-v1....' 'Team-Shared-Passkey' --yes
```

适用场景：

- 团队内部批量分发已授权的 `licell` 使用环境
- 让不直接持有高权限凭证的成员快速开始使用
- 给临时机器、CI 调试机、协作设备快速恢复环境

使用与安全建议：

- `token` 和 `passkey` 应分开发送，不要放在同一条消息里
- `restore token` 虽然不是明文凭证，但仍应按敏感信息处理
- `passkey` 至少 12 位，建议通过密码管理器或单独 IM 通道发送
- 若需要失效某次分发，可删除对应导出对象，或重新导出新的 token
- 若团队凭证轮换，应重新执行 `login` / `auth export`，不要继续分发旧 token

---

## 面向 Agent 的接口

## 1) 结构化帮助

Licell 的帮助信息不只是给人看，也要给 Agent 读。

```bash
licell --help
licell domain app --help
licell deploy spec --help
licell domain app bind --help --output json
```

建议：

- 人类交互时用普通 `--help`
- Agent 自动化时优先用 `--help --output json`

## 2) 结构化输出 `--output json`

几乎所有命令都支持结构化 JSON 结果：

```bash
licell deploy --type api --output json
licell domain app bind api.example.com --output json
licell oss info my-bucket --output json
```

典型字段包括：

- `stage`
- `type`（`event` / `result` / `error`）
- `error.code`
- `error.category`
- `retryable`
- `provider.requestId`

## 3) 命令目录 `catalog`

如果你希望 Claude Code、Codex、Cursor 等 Agent 直接驱动 `licell`，推荐走这条固定链路：

```bash
licell catalog --output json
licell deploy --help --output json
licell deploy --type api --output json
```

含义分别是：

- `catalog`：发现稳定 command key、选项、schema 与 CLI record contract
- `--help --output json`：读取单命令的参数、结果、推荐流程与下一步
- `--output json`：真正执行命令，并消费 `event / result / error` records

## 4) Skills

如果你希望 Agent 在项目里拥有一份更偏“执行说明书”的上下文，可以生成 skills：

```bash
licell skills init codex
licell skills init claude
licell skills init codex --global
```

默认会把 skills 写入当前项目；只有显式传 `--global` 时，才会写到用户级全局技能目录。

`licell setup` 是交互式包装命令，底层仍然复用同一套 skills 写入逻辑。

Skills 与 catalog、help、README 共享同一套命令描述体系，所以更容易保持一致。

---

## 推荐工作流

## API 部署（FC）

```bash
licell deploy spec nodejs22
licell deploy check --runtime nodejs22 --entry src/index.ts
licell deploy --type api --runtime nodejs22 --entry src/index.ts --target preview
```

常见增强参数：

```bash
licell deploy --type api \
  --runtime nodejs22 \
  --entry src/index.ts \
  --target preview \
  --memory 1024 \
  --vcpu 1 \
  --timeout 60
```

常见域名方式：

```bash
# 自动生成 <appName>.<suffix>
licell deploy --type api --runtime nodejs22 --entry src/index.ts --domain-suffix your-domain.xyz --ssl

# 指定完整域名
licell deploy --type api --runtime nodejs22 --entry src/index.ts --domain api.your-domain.xyz --ssl
```

### Agent 建议顺序

1. `deploy spec`
2. `deploy check`
3. `deploy`
4. 必要时再 `release promote` / `rollback`

运行时说明：

- `nodejs22` / `python3.13` 当前都部署为 `custom.debian12`
- 启动时优先使用 FC 托管运行时：`/var/fc/lang/nodejs22/bin/node`、`/var/fc/lang/python3.13/bin/python3.13`
- 默认不再把大体积 fallback runtime 打进代码包，避免放大 FC 上传体积
- 如需额外打包 fallback runtime，可显式设置 `LICELL_FC_INCLUDE_RUNTIME_FALLBACK=1`

## 静态站部署（OSS）

```bash
licell deploy --type static --dist dist
```

如果提供域名，Licell 会自动走“静态域名 workflow”：

```bash
licell deploy --type static --dist dist --domain-suffix your-domain.xyz
# 或
licell deploy --type static --dist dist --domain static.your-domain.xyz
# 如需更重的缓存失效策略，也可显式指定：
licell deploy --type static --dist dist --domain static.your-domain.xyz --cdn-refresh all
```

这条 workflow 会串起：

- OSS 上传
- CDN 接入
- DNS CNAME 收敛
- HTTPS 证书签发与 CDN 边缘证书配置
- CDN 缓存刷新（默认 `entrypoints`，会自动刷新 `/`、HTML、manifest 与 service worker 等入口文件）

### CDN Refresh 说明

- 只要 static deploy 绑定了固定域名并走 CDN，Licell 默认就会执行 `--cdn-refresh entrypoints`
- `entrypoints` 适合现代前端站点：只刷新 `/`、根层 HTML、`manifest.json`、`asset-manifest.json`、`sw.js`、`service-worker.js`
- `all` 会对根目录做目录级刷新，适合你明确知道整站缓存都要立即失效的场景
- `off` 会关闭自动刷新；这通常只适合你自己在外部另有缓存治理流程时使用
- 部署完成后的结构化结果里会返回 `cdnRefreshMode` 与 `cdnRefreshTaskIds[]`，便于 Agent / CI 继续追踪

### HTTPS / ACME 说明

- 默认优先使用 `Let's Encrypt` 通过 `DNS-01` 自动签发证书
- 当 `Let's Encrypt` 命中 ACME rate limit 时，会自动 fallback 到 `ZeroSSL ACME` 继续签发
- ZeroSSL fallback 默认会基于 ACME 账户邮箱自动获取 EAB；也可显式提供 `LICELL_SSL_ZEROSSL_EAB_KID` / `LICELL_SSL_ZEROSSL_EAB_HMAC_KEY`
- 如需走显式 API key 路径，也可设置 `LICELL_SSL_ZEROSSL_ACCESS_KEY`
- ZeroSSL 的 EAB 凭据会安全缓存到 `~/.licell-cli/acme/zerossl-eab.json`，后续签发可复用

## 发布、回滚、环境

```bash
licell release list
licell release promote --from preview --to prod
licell rollback
```

如果你把预览 / 生产环境都托管给 Agent，建议把 `release` 层放在部署成功之后再执行，而不是直接让 Agent 每次都改 `prod`。

---

## 域名能力如何理解

这是现在最容易让人一眼看上去“有点多”的部分，但分层其实很清晰。

## workflow 层：面向结果

| 命令 | 适合谁 | 作用 |
|------|--------|------|
| `licell domain app bind` | 人类 / Agent | 给 FC 应用绑定域名，必要时串 DNS / SSL / CDN |
| `licell domain static bind` | 人类 / Agent | 给静态站绑定域名，必要时串 CDN / DNS / SSL |
| `licell deploy --type static --domain ...` | 人类 / Agent | 直接得到“可访问的静态域名结果” |

## 原子层：面向资源

| 命令 | 作用 |
|------|------|
| `licell fn domain ...` | 管理 FC 自定义域名绑定 |
| `licell oss domain token/bind/unbind` | 管理 OSS 原生域名验证与绑定 |
| `licell dns records ...` | 精确管理 DNS 记录 |

推荐理解方式：

- **想要结果**：先用 `domain app/static` 或 `deploy`
- **要精细控制**：再落到 `fn domain` / `oss domain` / `dns records`

---

## 示例与教程

### 场景教程

1. [**5 分钟上线第一个应用**](./docs/scenarios/01-quick-start.md)
2. [**让 AI Agent 驱动部署**](./docs/scenarios/02-ai-driven-deployment.md)
3. [**域名、HTTPS 与 CDN**](./docs/scenarios/03-domain-and-https.md)
4. [**数据库与缓存**](./docs/scenarios/04-database-and-cache.md)
5. [**Preview / Prod 环境管理**](./docs/scenarios/05-environments-and-releases.md)

### 示例项目

- `examples/node22-express-api`
- `examples/python313-flask-api`
- `examples/docker-bun-hono-api`
- `examples/node22-task-worker`
- `examples/python313-task-worker`
- `examples/static-oss-site`

---

## 测试、CI 与真实验证

Licell 当前把验证拆成三层：

### 1. 默认 CI

GitHub Actions 默认跑：

- `typecheck`
- 文档同步校验
- 稳定单元 / 集成内核测试

默认 **不跑真实云资源 e2e**，也 **不跑慢的 CLI 进程级集成测试**。

### 2. 本地集成测试

本地如果要验证真实 CLI 帮助、参数、结构化输出这类进程级行为：

```bash
bun run test:integration
```

### 3. 云上真实验证

在需要发布前做一轮真实阿里云回归时：

```bash
licell e2e run
licell e2e run --suite full
licell e2e list
licell e2e cleanup <runId>
```

说明：

- `e2e run --suite full` 会覆盖更完整的资源 CRUD 与 workflow 链路
- 这类验证默认不放进 GitHub Actions，因为它依赖真实云环境、域名、证书与外部收敛时间

---

## 命令速查

<!-- BEGIN GENERATED:README_QUICK_REFERENCE -->
> 本节由 licell CLI 注册表自动生成；命令变更会同步到 README / docs/reference/agent-surfaces.md / Skills / Shell Completion。

### Agent Contract

- 始终先发现领域命令：`licell catalog --output json`。
- 命中领域命令：读取 `licell <command> --help --output json`，再执行该命令。
- 未命中领域命令：依次执行 `capability products/search/describe --output json`，并读取 `execution.preferred`。
- raw 写操作必须先 `--dry-run`，再显式 `--yes`，最后按 `nextActions[]` 回读验证。
- 解析执行结果时，只消费带 `@@LICELL_JSON@@` 前缀的逐行 JSON record。
- 对 `type=event` 的 record，优先读取稳定字段 `stage` / `action` / `status` / `source` / `terminal`。
- 对 `type=error` 的 record，优先读取 `nextActions[]` 获取首选补救步骤。

#### Schema Contracts

- 原始 CLI JSON 流会使用前缀 `@@LICELL_JSON@@` 输出逐行 JSON record；每条 record 当前都满足 `licell-cli-record@1.0`，再通过 `type=event|result|error` 区分记录类型。
- `licell <command> --help --output json`：读取 `help.kind` / `help.schemaVersion`；当前为 `licell-help@1.0`。
- `licell catalog --output json`：读取 `kind` / `schemaVersion`；当前为 `licell-agent-command-catalog@1.0`。
- `licell catalog --output json` 还会显式声明 help schema 与 CLI record schema：`licell-help@1.0` / `licell-cli-record@1.0`。
- 读取 `catalog.agentWorkflow` 获取“领域命令优先、raw capability 兜底”的自然语言路由契约；只有两层发现都失败，才可判定不支持。
- Agent 优先读取 `nextActions[]` 作为稳定下一步入口；`recommendedFlow` / `decisionGuide` / `remediation[]` 作为补充语义层。
- 命令自己的业务结果字段继续读取对应命令 help / catalog 里的 `result`；下面三组 contract 只描述公共 CLI record 包络。

### CLI Event Record · licell-cli-record@1.0

- CLI 流式事件 record；适合驱动 Agent 的进度感知、日志桥接和阶段判断。
- `kind`：固定为 `licell-cli-record`。
- `schemaVersion`：CLI record schema 版本；当前为 `1.0`。
- `type`：固定为 `event`。
- `ts`：事件发出时间（ISO 8601）。
- `command`：当前命令 key，例如 `deploy`、`oss upload`。
- `stage`：稳定阶段标识，例如 `deploy`、`deploy.api`、`auth.restore`。
- `action`：稳定动作标识，例如 `run`、`execute`、`stdout`。
- `status`：`start` / `ok` / `failed` / `skipped` / `info`。
- `source`：`command` / `console` / `stream`。
- `terminal`：该事件是否代表当前动作进入终态。
- `ok`（可选）：仅在终态成功/失败事件中出现；`true` 表示成功，`false` 表示失败。
- `message`（可选）：面向人类的补充消息。
- `data`（可选）：附加结构化上下文对象。
  - `stream`（可选）：当 `action=stdout|stderr` 时给出流类型。

### CLI Result Record Envelope

- CLI 成功结果 record；公共包络固定，命令自定义 payload 字段请继续读取对应命令 help/catalog 中的 `result`。
- `kind`：固定为 `licell-cli-record`。
- `schemaVersion`：CLI record schema 版本；当前为 `1.0`。
- `type`：固定为 `result`。
- `ts`：结果发出时间（ISO 8601）。
- `command`：当前命令 key。
- `stage`：命令阶段标识；通常与命令 key 或子阶段一致。
- `ok`：固定为 `true`。

### CLI Error Record

- CLI 错误结果 record；同时提供兼容层 remediation/nextCommands 和首选的 nextActions。
- `kind`：固定为 `licell-cli-record`。
- `schemaVersion`：CLI record schema 版本；当前为 `1.0`。
- `type`：固定为 `error`。
- `ts`：错误发出时间（ISO 8601）。
- `command`：当前命令 key。
- `stage`：错误阶段，例如 `parse`、`runtime`、`deploy`。
- `ok`：固定为 `false`。
- `error`：稳定错误对象。
  - `code`：稳定错误码，例如 `CLI_INVALID_INPUT`、`AUTH_MISSING_CREDENTIAL`。
  - `category`：`auth` / `permission` / `input` / `network` / `quota` / `conflict` / `not_found` / `internal`。
  - `message`：错误主消息。
  - `retryable`：该错误是否适合直接重试。
- `provider`（可选）：阿里云 provider 侧上下文。
  - `service`（可选）：云产品名，例如 `fc`、`oss`、`alidns`。
  - `action`（可选）：云 API 动作名。
  - `code`（可选）：云侧原始错误码。
  - `requestId`（可选）：云侧 requestId。
  - `httpStatus`（可选）：云侧 HTTP 状态码。
  - `endpoint`（可选）：命中的云 API endpoint。
- `details`（可选）：额外结构化错误上下文。
- `remediation[]`：兼容层修复建议数组。
  - `type`：建议类型，例如 `note` / `command`。
  - `title`：修复建议标题。
  - `reason`：为什么建议这样做。
  - `commandTemplate`：建议命令模板。
  - `commandKey`（可选）：若可匹配 CLI 注册表，则给出稳定 command key。
  - `commandDescription`（可选）：匹配到的命令说明。
  - `phase`：修复阶段，例如 `inspect` / `mutate` / `verify`。
  - `priority`：`primary` / `secondary`。
  - `order`：稳定排序值。
- `nextCommands[]`：兼容层命令建议数组。
  - `commandTemplate`：建议命令模板。
  - `commandKey`（可选）：若可匹配 CLI 注册表，则给出稳定 command key。
  - `description`（可选）：命令建议说明。
  - `intent`：命令意图，例如 `inspect` / `repair` / `bind`。
  - `priority`：`primary` / `secondary`。
- `nextActions[]`：推荐优先消费的统一下一步数组。
  - `title`：下一步动作标题。
  - `description`：为什么建议执行这一步。
  - `commandTemplate`：建议命令模板。
  - `commandKey`（可选）：若可匹配 CLI 注册表，则给出稳定 command key。
  - `phase`：动作阶段，例如 `inspect` / `verify` / `mutate`。
  - `priority`：`primary` / `secondary`。
  - `source`：动作来源，例如 `error-remediation`。

- Agent 侧做强约束解析时，先匹配 `kind`，再检查 `schemaVersion`；未知更高版本应走兼容分支或降级为文本解析。

### 命令总览

#### Setup & Identity

认证、项目初始化与默认配置相关命令。

| 命令 | 说明 | 关键选项 |
|------|------|----------|
| `licell login` | 配置阿里云凭证 | `--account-id`, `--ak`, `--sk` |
| `licell auth export [passkey]` | 加密打包当前 licell 全局凭证状态到私有 OSS，并生成 restore token | `--region`, `--bucket`, `--expires` |
| `licell auth inspect <token>` | 解析并查看 restore token 的内容与有效期 | — |
| `licell auth repair` | 修复凭证权限（推荐：用超级 AK/SK 自动补齐 licell 最小权限并继续使用） | `--account-id`, `--ak`, `--sk` |
| `licell auth restore <token> [passkey]` | 使用 restore token + passkey 一键恢复 licell 全局凭证状态 | `--yes` |
| `licell logout` | 清除本地凭证 | — |
| `licell whoami` | 查看当前登录身份 | — |
| `licell switch` | 切换默认 region | `--region` |
| `licell init` | 初始化 FC 项目（空目录生成脚手架，已有项目写入 licell 配置） | `--runtime`, `--kind`, `--app` |
| `licell bootstrap` | 把已确认的部署方案初始化到 `.licell/project.json` / `.licell/state.json` | `--component`, `--path`, `--type` |
| `licell workspace discover` | 扫描 repo，给出候选 components 与部署提案 | — |
| `licell workspace doctor` | 在 workspace / monorepo 根目录诊断全部或指定 component | `--region`, `--component`, `--runtime` |
| `licell workspace init` | 在 repo 根目录创建或更新 licell workspace component | `--component`, `--path`, `--type` |
| `licell workspace list` | 列出当前 repo / workspace 中可部署的 components | `--component` |
| `licell workspace migrate` | 把旧单项目 `.licell/project.json` 升级成兼容旧版的 workspace/component 格式 | `--component`, `--path`, `--default` |
| `licell config domain [suffix]` | 查看或设置全局默认域名后缀 | `--unset` |

#### Delivery Workflow

围绕应用部署、发布、函数管理、环境变量、域名、DNS、日志和对象存储的交付链路。

- Agent 在 FC API 部署前，优先执行 `licell deploy spec` 与 `licell deploy check`。
- 涉及删除或清理的命令通常需要显式传入 `--yes`。
- 任务函数通过 `licell deploy --type task` 交付；部署成功后不返回固定 URL，而是继续用 `licell task invoke / info / list / stop` 完成调用与排查。

| 命令 | 说明 | 关键选项 |
|------|------|----------|
| `licell deploy` | 一键极速打包部署 | `--region`, `--component`, `--type` |
| `licell deploy check` | 本地预检 FC API 入口与 runtime 约束（建议 deploy 前执行） | `--component`, `--runtime`, `--entry` |
| `licell deploy plan` | 基于 `.licell/project.json` 生成部署计划（不执行云端变更） | `--region`, `--component`, `--include` |
| `licell deploy spec [runtime]` | 查看 FC API 部署规格（给 Agent/开发者在 deploy 前对照） | `--all` |
| `licell task config [name]` | 查看任务函数的异步调用配置 | `--region`, `--component`, `--target` |
| `licell task info <taskId> [name]` | 查看单个异步任务详情 | `--region`, `--component`, `--target` |
| `licell task invoke [name]` | 异步调用任务函数 | `--region`, `--component`, `--target` |
| `licell task list [name]` | 查看任务函数的异步任务列表 | `--region`, `--component`, `--target` |
| `licell task stop <taskId> [name]` | 停止正在运行的异步任务 | `--region`, `--component`, `--target` |
| `licell task config rm [name]` | 删除任务函数的异步调用配置 | `--region`, `--component`, `--target` |
| `licell task config set [name]` | 写入任务函数的异步调用配置 | `--region`, `--component`, `--target` |
| `licell release list` | 查看函数版本列表 | `--region`, `--component`, `--limit` |
| `licell release promote [versionId]` | 发布并切流到目标别名 | `--region`, `--component`, `--target` |
| `licell release prune` | 清理历史函数版本（默认仅预览） | `--region`, `--component`, `--keep` |
| `licell release rollback <versionId>` | 回滚到指定函数版本 | `--region`, `--component`, `--target` |
| `licell acr instances` | 列出 ACR 企业版实例（只读） | `--region`, `--status`, `--limit` |
| `licell acr namespaces <instanceId>` | 列出 ACR 企业版命名空间（只读） | `--region`, `--name`, `--status` |
| `licell acr repositories <instanceId>` | 列出 ACR 企业版镜像仓库（只读） | `--region`, `--namespace`, `--name` |
| `licell acr scan <instanceId> <repositoryId> <tag>` | 查看 ACR 企业版镜像的已有安全扫描结果（只读） | `--region`, `--digest`, `--task-id` |
| `licell acr tags <instanceId> <repositoryId>` | 列出 ACR 企业版镜像标签（只读） | `--region`, `--limit` |
| `licell cert list` | 列出阿里云证书摘要（只读） | `--region`, `--keyword`, `--status` |
| `licell cdn domains` | 列出 CDN 加速域名（只读） | `--region`, `--domain`, `--status` |
| `licell logs index <project> <logstore>` | 查看 SLS logstore 索引（只读） | `--region` |
| `licell logs logstores <project>` | 列出 SLS 项目下的 logstore（只读） | `--region`, `--name`, `--mode` |
| `licell logs projects` | 列出 SLS 日志项目（只读） | `--region`, `--project`, `--resource-group` |
| `licell logs query [query]` | 按 SLS project/logstore/query 一次性检索日志 | `--region`, `--project`, `--store` |
| `licell logs tail [query]` | 按 SLS project/logstore/query 持续跟随日志流 | `--region`, `--project`, `--store` |
| `licell fn aliases <name>` | 查看函数别名和版本路由（只读） | `--region`, `--limit`, `--prefix` |
| `licell fn capacity [name]` | 查看函数并发、预留实例和伸缩配置（只读） | `--region`, `--limit` |
| `licell fn info [name]` | 查看函数详情 | `--region`, `--component`, `--target` |
| `licell fn instances <name>` | 查看函数执行实例（只读） | `--region`, `--qualifier`, `--status` |
| `licell fn invoke [name]` | 调用函数（同步） | `--region`, `--component`, `--target` |
| `licell fn layers` | 查看 FC 层列表（只读） | `--region`, `--limit`, `--prefix` |
| `licell fn list` | 查看函数列表 | `--region`, `--limit`, `--prefix` |
| `licell fn logs [name]` | 查看函数日志（默认实时流式） | `--region`, `--component`, `--once` |
| `licell fn rm [name]` | 删除函数 | `--region`, `--component`, `--force` |
| `licell fn sessions <name>` | 查看函数显式会话（只读） | `--region`, `--qualifier`, `--status` |
| `licell fn tags [name]` | 查看函数资源标签（只读） | `--region`, `--tag`, `--limit` |
| `licell fn triggers <name>` | 查看函数触发器（只读） | `--region`, `--limit`, `--prefix` |
| `licell fn vpc-bindings <name>` | 查看函数绑定的 VPC（只读） | `--region` |
| `licell fn domain bind <domain>` | 绑定或更新 FC 自定义域名（资源级，不默认改 DNS） | `--region`, `--function`, `--component` |
| `licell fn domain info <domain>` | 查看 FC 自定义域名详情 | `--region` |
| `licell fn domain list` | 查看 FC 自定义域名列表 | `--region`, `--limit`, `--prefix` |
| `licell fn domain unbind <domain>` | 解绑 FC 自定义域名 | `--region`, `--cleanup-dns`, `--yes` |
| `licell env list` | 查看云端环境变量 | `--region`, `--component`, `--target` |
| `licell env pull` | 拉取云端环境变量 | `--region`, `--component`, `--target` |
| `licell env rm <key>` | 删除云端环境变量（并同步本地 .licell/project.json） | `--region`, `--component`, `--yes` |
| `licell env set <key> <value>` | 设置云端环境变量（并同步本地 .licell/project.json） | `--region`, `--component` |
| `licell domain app bind <domain>` | 为当前应用编排 DNS、函数域名与可选 SSL | `--region`, `--component`, `--ssl` |
| `licell domain app unbind <domain>` | 解绑当前应用域名，并清理 FC custom domain / DNS CNAME | `--region`, `--yes` |
| `licell domain static bind <domain>` | 为静态站点编排 CDN、DNS 与可选 HTTPS | `--region`, `--component`, `--bucket` |
| `licell domain static unbind <domain>` | 解绑静态站点域名，并清理 CDN / DNS | `--region`, `--yes` |
| `licell dns records add <domain>` | 添加域名解析记录 | `--rr`, `--type`, `--value` |
| `licell dns records list [domain]` | 查看域名解析记录 | `--limit` |
| `licell dns records rm <recordId>` | 删除域名解析记录 | `--yes` |
| `licell oss bucket [bucket]` | 上传本地目录到 OSS Bucket 指定目录（兼容命令，等同 oss upload） | `--region`, `--bucket`, `--source-dir` |
| `licell oss config <bucket>` | 查看 OSS Bucket 生命周期、CORS、服务端加密和静态网站配置（只读） | `--region` |
| `licell oss create <bucket>` | 创建 OSS Bucket | `--region`, `--acl`, `--storage-class` |
| `licell oss info <bucket>` | 查看 OSS Bucket 详情（含 ACL / 公共访问阻止 / 域名） | `--region` |
| `licell oss list` | 查看 OSS Bucket 列表 | `--region`, `--limit` |
| `licell oss ls <bucket> [prefix]` | 列出 Bucket 对象 | `--region`, `--limit` |
| `licell oss rm <bucket>` | 删除 OSS Bucket（默认仅删空 Bucket） | `--region`, `--recursive`, `--yes` |
| `licell oss update <bucket>` | 更新 OSS Bucket 属性（ACL / 公共访问阻止） | `--region`, `--acl`, `--public-access-block` |
| `licell oss upload [bucket]` | 上传本地目录到 OSS Bucket 指定目录 | `--region`, `--bucket`, `--source-dir` |
| `licell oss config apply <bucket>` | 按 desired-state 设置或删除 OSS Bucket 高级配置 | `--region`, `--dry-run`, `--yes` |
| `licell oss domain bind <bucket> <domain>` | 为 Bucket 绑定原生 OSS 自定义域名 | `--region` |
| `licell oss domain list <bucket>` | 查看 Bucket 已绑定的原生 OSS 域名 | `--region` |
| `licell oss domain token <bucket> <domain>` | 为 Bucket 自定义域名生成 TXT 验证 token | `--region` |
| `licell oss domain unbind <bucket> <domain>` | 解绑 Bucket 原生 OSS 自定义域名 | `--region`, `--yes` |
| `licell oss object get <bucket> <key> [file]` | 下载 OSS 对象到本地文件 | `--region`, `--file` |
| `licell oss object info <bucket> <key>` | 查看 OSS 对象元数据 | `--region` |
| `licell oss object rm <bucket> <key>` | 删除 OSS 对象 | `--region`, `--yes` |
| `licell oss sync down <bucket> [prefix]` | 批量下载 Bucket 对象到本地目录 | `--region`, `--dest-dir` |
| `licell oss sync up [bucket]` | 同步本地目录到 OSS Bucket（等同 oss upload） | `--region`, `--bucket`, `--source-dir` |

#### Data Services

数据库、缓存与 Supabase 实例的创建、连接、白名单和生命周期管理。

| 命令 | 说明 | 关键选项 |
|------|------|----------|
| `licell db accounts <instanceId>` | 查看 RDS 账号和数据库权限（只读） | `--region`, `--name`, `--limit` |
| `licell db add` | 分配数据库实例 | `--region`, `--type`, `--engine-version` |
| `licell db backups <instanceId>` | 查看 RDS 备份集和备份策略（只读） | `--region`, `--days`, `--status` |
| `licell db class [type]` | 查询数据库可用规格（给 Agent/开发者在 db add 前对照） | `--region`, `--engine-version`, `--category` |
| `licell db connect [instanceId]` | 输出数据库连接信息 | `--region` |
| `licell db databases <instanceId>` | 查看 RDS 逻辑数据库和授权（只读） | `--region`, `--name`, `--status` |
| `licell db info <instanceId>` | 查看数据库实例详情 | `--region` |
| `licell db list` | 查看数据库实例列表 | `--region`, `--limit` |
| `licell db parameters <instanceId>` | 查看 RDS 运行与待生效参数（只读） | `--region`, `--prefix`, `--limit` |
| `licell db public-access [instanceId]` | 开通数据库公网访问并添加当前 IP 到白名单 | `--region`, `--ip` |
| `licell db rm <instanceId>` | 删除数据库实例 | `--region`, `--yes` |
| `licell db config apply <instanceId>` | 规划并应用 RDS 实例描述 desired-state 变更 | `--region`, `--dry-run`, `--yes` |
| `licell db restore plan <instanceId>` | 检查 RDS 恢复条件并生成新实例请求草案（只读） | `--region`, `--backup-id`, `--restore-time` |
| `licell cache accounts <instanceId>` | 查看 Redis/Tair 账号和权限（只读） | `--region`, `--name`, `--limit` |
| `licell cache add` | 分配 Redis 缓存 | `--region`, `--type`, `--mode` |
| `licell cache backups <instanceId>` | 查看 Redis/Tair 备份集和备份策略（只读） | `--region`, `--days`, `--limit` |
| `licell cache class [mode]` | 查询缓存可用规格（给 Agent/开发者在 cache add 前对照） | `--region`, `--zone`, `--limit` |
| `licell cache connect [instanceId]` | 输出缓存连接信息 | `--region` |
| `licell cache info <instanceId>` | 查看缓存实例详情 | `--region` |
| `licell cache list` | 查看缓存实例列表 | `--region`, `--limit` |
| `licell cache parameters <instanceId>` | 查看 Redis/Tair 运行与待生效参数（只读） | `--region`, `--node`, `--prefix` |
| `licell cache public-access [instanceId]` | 开通 Redis 公网访问并添加当前 IP 到白名单 | `--region`, `--ip` |
| `licell cache rm <instanceId>` | 删除缓存实例 | `--region`, `--yes` |
| `licell cache rotate-password` | 轮换 Redis 密码 | `--region`, `--instance` |
| `licell cache topology <instanceId>` | 查看 Redis/Tair 集群节点拓扑（只读） | `--region`, `--limit` |
| `licell cache backup-policy apply <instanceId>` | 按 desired-state 设置 Redis/Tair 自动备份策略 | `--region`, `--dry-run`, `--yes` |
| `licell supa add` | 创建 RDS Supabase 实例 | `--region`, `--name`, `--vsw` |
| `licell supa config <instanceName>` | 查看 Supabase 实例配置（auth/storage/rag） | `--region`, `--set-auth`, `--set-storage` |
| `licell supa connect <instanceName>` | 查看 Supabase 连接信息和 API Keys | `--region` |
| `licell supa info <instanceName>` | 查看 Supabase 实例详情 | `--region` |
| `licell supa list` | 查看 Supabase 实例列表 | `--region`, `--limit` |
| `licell supa reset-password <instanceName>` | 重置 Supabase Dashboard 或数据库密码 | `--region`, `--dashboard-password`, `--db-password` |
| `licell supa restart <instanceName>` | 重启 Supabase 实例 | `--region` |
| `licell supa rm <instanceName>` | 删除 Supabase 实例 | `--region`, `--yes` |
| `licell supa start <instanceName>` | 启动 Supabase 实例 | `--region` |
| `licell supa stop <instanceName>` | 暂停 Supabase 实例 | `--region` |
| `licell supa whitelist <instanceName>` | 查看/修改 Supabase IP 白名单 | `--region`, `--set`, `--add` |

#### Cloud Infrastructure

云服务器、网络与基础设施资源的查询和运维命令。

| 命令 | 说明 | 关键选项 |
|------|------|----------|
| `licell ecs delete <instanceId>` | 删除（释放）ECS 实例 | `--region`, `--dry-run`, `--yes` |
| `licell ecs info <instanceId>` | 查看 ECS 实例基础详情 | `--region` |
| `licell ecs list` | 查看 ECS 实例列表 | `--region`, `--limit`, `--status` |
| `licell ecs reboot <instanceId>` | 重启 ECS 实例 | `--region`, `--dry-run`, `--yes` |
| `licell ecs rm <instanceId>` | 删除（释放）ECS 实例（delete 的别名） | `--region`, `--dry-run`, `--yes` |
| `licell ecs start <instanceId>` | 启动 ECS 实例 | `--region`, `--dry-run` |
| `licell ecs stop <instanceId>` | 停止 ECS 实例 | `--region`, `--dry-run`, `--yes` |
| `licell k8s clusters` | 列出当前地域的 ACK / ACS Kubernetes 集群 | `--region`, `--name` |
| `licell k8s logs <cluster> <target>` | 只读读取 ACK / ACS 集群内工作负载日志 | `--region`, `--namespace`, `--container` |
| `licell k8s workloads <cluster>` | 只读查询 ACK / ACS 集群内已部署的工作负载和 Service | `--region`, `--private`, `--request-timeout` |
| `licell vpc info <vpc>` | 按 VPC ID 或唯一名称查看网络详情 | `--region` |
| `licell vpc list` | 列出当前地域的 VPC 网络 | `--region`, `--name`, `--limit` |
| `licell vpc topology <vpc>` | 聚合查看 VPC、交换机、路由表、NAT 网关和 EIP 拓扑 | `--region` |
| `licell vpc config apply <vpc>` | 按 desired-state 设置 VPC 名称和描述 | `--region`, `--dry-run`, `--yes` |
| `licell ram users` | 列出 RAM 用户（只读） | `--limit` |

#### Automation & Tooling

面向 Agent、开发体验与 CLI 生命周期的自动化命令。

- `licell skills init`、`licell onboard`、`licell catalog`、`licell capability`、`licell completion` 都基于版本化的本地注册表或 protocol 快照生成外部表面。
- `licell skills init` / `setup` / `onboard` 写入的是 agent-facing 的 licell skill contract；命令参考与字段细节应继续通过 `catalog` / `--help --output json` 获取。
- `licell onboard` 默认会同时安装 Codex + Claude 的全局 licell skill contract；当安装目标包含 Codex 时，还会额外安装 `licell-glab` subagent。
- `licell api invoke` 优先使用 PATH 中的 aliyun；缺失时按固定版本下载并校验后缓存到 `~/.licell/bin`。
- `licell completion` 的候选命令同样来自共享命令目录。

| 命令 | 说明 | 关键选项 |
|------|------|----------|
| `licell doctor` | 诊断本机 licell 登录态、云端权限/目标资源/域名入口、项目配置与部署前置条件 | `--region`, `--component`, `--all-components` |
| `licell catalog` | 输出共享 CLI 命令目录，供 Agent / 自动化发现命令、选项和结构化契约 | `--root-command`, `--command-key` |
| `licell api invoke <ref>` | 通过固定版本 aliyun-cli runner 调用 raw API | `--region`, `--params-file`, `--param` |
| `licell api scaffold <ref>` | 从 raw capability 生成 API 请求模板 | — |
| `licell capability describe <ref>` | 查看一个 raw capability 的完整 OpenAPI 输入和来源 | — |
| `licell capability products [query]` | 列出 protocol 快照覆盖的阿里云产品和 capability 数量 | `--limit`, `--offset` |
| `licell capability search [query]` | 从仓库内阿里云 OpenAPI 快照搜索原始 capability | `--intent`, `--product`, `--action` |
| `licell ci init github` | 生成 GitHub Actions 的 deploy-only workflow（只调用 licell，不负责编译） | `--apply`, `--force`, `--workflow` |
| `licell ci init gitlab` | 生成 GitLab CI 的 deploy-only pipeline（只调用 licell，不负责编译） | `--apply`, `--force`, `--pipeline` |
| `licell onboard` | 全局安装 licell 的 agent-facing skill contract；默认同时安装 Codex 与 Claude | `--agent`, `--force` |
| `licell skills init [agent]` | 为 AI Agent 写入 licell skill contract（claude / codex） | `--global`, `--project-root`, `--force` |
| `licell setup` | 安装后引导：交互式配置 AI Agent 的 licell skill contract | `--agent`, `--global`, `--project-root` |
| `licell state show` | 查看当前 repo 的 `.licell/state.json` | `--component` |
| `licell completion [shell]` | 输出 shell 补全脚本（bash/zsh） | `--engine` |
| `licell upgrade` | 按当前安装来源升级 licell | `--channel`, `--target-version`, `--repo` |
| `licell e2e cleanup [runId]` | 清理指定 E2E run 产生的资源 | `--region`, `--manifest`, `--keep-workspace` |
| `licell e2e list` | 查看本项目 e2e 运行记录 | — |
| `licell e2e run` | 执行固定 E2E 套件（默认 smoke） | `--region`, `--suite`, `--run-id` |

### 常用工作流片段

**Task 函数工作流**

```bash
licell deploy --type task --runtime nodejs22 --entry src/task.ts --target preview --output json
licell task config <appName> --target preview --output json
licell task invoke <appName> --target preview --payload '{"job":"demo"}' --output json
licell task info <taskId> <appName> --target preview --output json
licell task list <appName> --target preview --status Running --output json
```

说明：`deploy --type task` 成功后不会返回固定 URL；请读取结果里的 `invokeCommand`，或继续执行 `licell task invoke` / `task info` / `task list` 完成任务闭环。

**Shell 补全（bash / zsh）**

```bash
mkdir -p ~/.local/share/licell/completions

# 生成 bash 补全脚本
licell completion bash > ~/.local/share/licell/completions/licell.bash
echo '[[ -f "$HOME/.local/share/licell/completions/licell.bash" ]] && source "$HOME/.local/share/licell/completions/licell.bash"' >> ~/.bashrc

# 生成 zsh 补全脚本
licell completion zsh > ~/.local/share/licell/completions/_licell
echo '[[ -f "$HOME/.local/share/licell/completions/_licell" ]] && source "$HOME/.local/share/licell/completions/_licell"' >> ~/.zshrc
```

**固定 E2E 套件（发布前建议）**

```bash
licell e2e run
licell e2e run --suite full
licell e2e run --enable-vpc
licell e2e run --runtime nodejs22 --domain-suffix your-domain.xyz --enable-cdn --cleanup
licell e2e list
licell e2e cleanup <runId>
```

说明：默认 smoke 套件会覆盖 API deploy/invoke 与 task deploy/config/invoke/list/info/stop；`licell e2e run --suite full` 会在此基础上额外覆盖 DNS add/rm、OSS bucket/object CRUD、OSS 原生域名 token/bind/unbind、`domain app bind/unbind`、`deploy --type static --domain ...` 与 `domain static bind/unbind`。如需连同云上资源一起收口，建议配合 `--cleanup`。

**删除 / 清理说明**

- 涉及删除、解绑、清理的命令在非交互模式下通常需要显式传入 `--yes`。
- API 部署前建议固定执行 `licell deploy spec` 与 `licell deploy check`。
- `licell upgrade --dry-run` 可先查看当前安装来源与升级计划。
<!-- END GENERATED:README_QUICK_REFERENCE -->

---

## 什么时候该用什么

### 我只想尽快上线

```bash
licell login
licell init --runtime nodejs22
licell deploy --type api --target preview
```

### 我希望 Agent 自动、安全地部署

```bash
licell setup --agent codex
licell catalog --output json
licell deploy spec nodejs22 --output json
licell deploy check --runtime nodejs22 --entry src/index.ts --output json
licell deploy --type api --runtime nodejs22 --entry src/index.ts --target preview --output json
```

### 我需要精细控制域名、DNS、OSS

```bash
licell dns records list bazhuayu.xyz
licell oss domain token my-bucket static.example.com
licell fn domain list
```

### 我准备正式发布前做真实校验

```bash
licell e2e run --suite full --cleanup
```

---

## 相关文档

- Agent surface 参考：`docs/reference/agent-surfaces.md`
- 场景教程：`docs/scenarios/`
- 示例项目：`examples/`

如果你把 Licell 当作“阿里云上的 Agent-first deployment runtime”，会更容易理解它现在的架构：

- workflow 优先
- 原子命令兜底
- 命令自描述
- catalog / skills / docs 共源收敛
