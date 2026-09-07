# Agent Surface Reference

> 本文档由 licell 的共享 CLI 注册表自动生成；命令变更会同步到 README / Skills / shell completion / 本页。

## Recommended Agent Flow

- 始终先发现领域命令：`licell catalog --output json`。
- 命中领域命令：读取 `licell <command> --help --output json`，再执行该命令。
- 未命中领域命令：依次执行 `capability products/search/describe --output json`，并读取 `execution.preferred`。
- raw 读操作可在参数明确后执行；raw 写操作必须先 `--dry-run`，再显式 `--yes`，最后按 `nextActions[]` 回读验证。
- 领域命令与 raw capability 都未命中后，才可判定当前请求不受支持。
- 对于流式输出：过滤 `@@LICELL_JSON@@` 前缀，再按 `type=event|result|error` 消费。

## Schema Contracts

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

## CLI 命令目录

> 下表直接来自共享 CLI 注册表；Skills、catalog、help、shell completion 与文档都从同一份目录派生。

### Setup & Identity

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

### Delivery Workflow

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

### Data Services

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

### Cloud Infrastructure

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

### Automation & Tooling

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

## 同步机制

- CLI 命令、子命令、选项：来自共享 `cac` 注册表。
- Skills 使用说明、`licell catalog`、`--help --output json`、shell completion、README 命令速查：全部从同一份命令目录派生。
- 若新增命令或 tool，只需更新对应注册表并执行 `bun run docs:sync`。
