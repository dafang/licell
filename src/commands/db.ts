import type { CAC } from 'cac';
import { defineCommandModule, commandInvocation, defineCliCommand, registerCliCommand } from './module';
import { select, confirm, isCancel } from '@clack/prompts';
import pc from 'picocolors';
import { maskConnectionString } from '../utils/cli-helpers';
import { executeWithAuthRecovery } from '../utils/auth-recovery';
import { Config } from '../utils/config';
import {
  getDatabaseInstanceDetail,
  listDatabaseClasses,
  listDatabaseInstances,
  provisionDatabase,
  resolveDatabaseConnectInfo,
  deleteDatabaseInstance,
  allocateDbPublicConnection,
  applyDbPublicWhitelist,
  listDatabaseBackups,
  listDatabaseParameters,
  listDatabaseAccounts,
  listDatabases,
  applyDatabaseConfig,
  planDatabaseConfig,
  planDatabaseRestore
} from '../providers/infra';
import {
  ensureAuthOrExit,
  ensureMutatingActionConfirmed,
  createSpinner,
  isInteractiveTTY,
  showIntro,
  showOutro,
  toPromptValue,
  toOptionalString,
  parseListLimit,
  normalizeDbType,
  parseOptionalNumber,
  parseOptionalPositiveInt,
  normalizeAutoPause,
  withSpinner,
  type DbTypeInput
} from '../utils/cli-shared';
import { emitCommandResult, isJsonOutput } from '../utils/output';
import { resolveOptionalPayloadInput } from '../utils/payload-input';
import { DATA_SECTION } from './sections';

const DATABASE_PROJECT_ENV_KEYS = ['DATABASE_URL'] as const;

const dbAddOptions = [
  { rawName: '--type <type>', description: '数据库类型：postgresql 或 mysql（默认 serverless-postgresql，即将上线）' },
  { rawName: '--engine-version <version>', description: '数据库引擎版本（postgres 默认 18.0，mysql 默认 8.0）' },
  { rawName: '--category <category>', description: 'RDS Category（默认 serverless_basic）' },
  { rawName: '--class <instanceClass>', description: '实例规格（如 pg.n2.serverless.1c）' },
  { rawName: '--storage <gb>', description: '存储空间 GB（默认 20）' },
  { rawName: '--storage-type <storageType>', description: '存储类型（默认 cloud_essd）' },
  { rawName: '--min-rcu <n>', description: 'Serverless 最小 RCU（如 0.5）' },
  { rawName: '--max-rcu <n>', description: 'Serverless 最大 RCU（如 8）' },
  { rawName: '--auto-pause <mode>', description: '自动启停：on/off' },
  { rawName: '--zone <zoneId>', description: '主可用区（如 cn-hangzhou-b）' },
  { rawName: '--zone-slave1 <zoneId>', description: '备可用区 1（多可用区部署）' },
  { rawName: '--zone-slave2 <zoneId>', description: '备可用区 2（多可用区部署）' },
  { rawName: '--vpc <vpcId>', description: '指定 VPC ID' },
  { rawName: '--vsw <vSwitchId>', description: '指定 VSwitch ID' },
  { rawName: '--security-ip-list <cidrs>', description: '白名单 CIDR（逗号分隔）' },
  { rawName: '--description <text>', description: '实例描述' }
] as const;

const dbAddCommand = defineCliCommand({
  rawName: 'db add',
  description: '分配数据库实例',
  region: { scope: 'auth' },
  options: dbAddOptions
});

const dbListCommand = defineCliCommand({
  rawName: 'db list',
  description: '查看数据库实例列表',
  region: { scope: 'auth' },
  options: [
    { rawName: '--limit <n>', description: '返回数量，默认 20' }
  ]
});

const dbBackupsCommand = defineCliCommand({
  rawName: 'db backups <instanceId>',
  description: '查看 RDS 备份集和备份策略（只读）',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [
    { rawName: '--days <n>', description: '查询最近天数，默认 7，最大 365' },
    { rawName: '--status <status>', description: '按备份状态过滤，例如 Success' },
    { rawName: '--limit <n>', description: '返回数量，默认 50，最大 200' }
  ],
  descriptor: {
    title: 'Inspect RDS backups',
    summary: '同时读取 RDS DescribeBackups 和 DescribeBackupPolicy，用于恢复前盘点。',
    examples: ['licell db backups rm-xxx --days 30 --output json'],
    argumentHints: { instanceId: 'RDS 实例 ID；先用 `licell db list` 获取。' },
    related: ['db list', 'db info', 'capability search'],
    agentTips: ['输出不包含带签名的备份下载 URL 和 checksum。', '执行恢复前先核对 `backupId/status/endTime` 及 `policy`。'],
    automation: { preferredOutput: 'json', explicitInputs: ['instanceId', '--region', '--days', '--status', '--limit'] },
    safety: { level: 'safe', reason: '只调用 RDS DescribeBackups 和 DescribeBackupPolicy。', confirmFlags: [] },
    recommendedFlow: [
      { title: '查看实例', command: 'licell db info <instanceId> --output json', reason: '确认引擎和状态。' },
      { title: '盘点备份', command: 'licell db backups <instanceId> --days 30 --output json', reason: '确认可恢复备份集和保留策略。' }
    ],
    result: { outcomeKey: 'backups', fields: [
      { name: 'instanceId', description: 'RDS 实例 ID。', required: true },
      { name: 'policy', description: '备份时段、保留天数、日志备份和 PITR 摘要。', required: true },
      { name: 'count', description: '返回备份数量。', required: true },
      { name: 'truncated', description: '结果是否截断。', required: true },
      { name: 'backups[]', description: '备份 ID、状态、类型、大小和时间摘要。', required: true }
    ] }
  }
});

const dbConfigApplyCommand = defineCliCommand({
  rawName: 'db config apply <instanceId>',
  description: '规划并应用 RDS 实例描述 desired-state 变更',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [
    { rawName: '--dry-run', description: '读取现状并生成差异计划，不修改 RDS 实例' },
    { rawName: '--yes', description: '确认执行 RDS 实例描述修改' },
    { rawName: '--payload <json>', description: '内联 JSON desired-state，当前仅支持 description' },
    { rawName: '--file <path>', description: '从当前工作目录内的文件读取 JSON desired-state' }
  ],
  descriptor: {
    title: 'Apply RDS instance config changes',
    summary: '读取 RDS 实例描述并生成字段级 desired-state 计划；确认后修改并读回验证。',
    examples: [
      `licell db config apply rm-xxx --payload '{"description":"managed-by-licell"}' --dry-run --output json`,
      `licell db config apply rm-xxx --payload '{"description":"managed-by-licell"}' --yes --output json`,
      'licell db config apply rm-xxx --file ./rds-config.json --dry-run --output json'
    ],
    argumentHints: { instanceId: 'RDS 实例 ID；先用 `licell db list` 获取。' },
    related: ['db info', 'db list', 'capability search'],
    agentTips: [
      'desired-state 当前仅支持非空 description；其他字段会被拒绝。',
      '先执行 --dry-run 检查 plan.changes[].before/after，再使用相同 desired-state 加 --yes 应用。',
      '写入只发起一次，命令会自动读回验证；验证未完成时不要立即重复写入。'
    ],
    automation: {
      preferredOutput: 'json',
      explicitInputs: ['instanceId', '--region', '--dry-run', '--yes', '--payload|--file']
    },
    safety: {
      level: 'mutating',
      reason: '会修改 RDS 实例描述；先审查 dry-run 计划，再使用 --yes 确认并执行。',
      confirmFlags: ['--yes']
    },
    optionInsights: {
      '--dry-run': { whenToUse: '执行前预览字段级差异。', cautions: ['只生成计划，不修改实例描述。'] },
      '--yes': { whenToUse: '确认已审查的 dry-run 计划后执行。', cautions: ['必须与已审查的 desired-state 保持一致。'] },
      '--payload': { whenToUse: '预览单个短 description 时使用。', cautions: ['不要与 --file 同时使用。'] },
      '--file': { whenToUse: '希望审查或版本化 desired-state 时使用。', cautions: ['文件必须位于当前工作目录内。'] }
    },
    recommendedFlow: [
      { title: '定位实例', command: 'licell db list --output json', reason: '获取准确实例 ID 和地域。' },
      { title: '检查实例', command: 'licell db info <instanceId> --output json', reason: '确认当前状态和描述。' },
      { title: '预览变更', command: 'licell db config apply <instanceId> --file <path> --dry-run --output json', reason: '检查字段级 before/after，不执行写入。' },
      { title: '应用并验证', command: 'licell db config apply <instanceId> --file <path> --yes --output json', reason: '修改描述并自动读回验证。' }
    ],
    result: {
      summary: '返回实例描述的当前值、期望值、差异计划、执行结果和读回验证。',
      outcomeKey: 'plan.changes',
      fields: [
        { name: 'plan.instanceId', description: '目标 RDS 实例 ID。', required: true },
        { name: 'plan.changes[]', description: 'description 的 before、after 和 set/noop 动作。', required: true },
        { name: 'plan.willExecute', description: '计划是否包含需要执行的变更。', required: true },
        { name: 'execution.performed', description: '是否调用了 ModifyDBInstanceDescription。', required: true },
        { name: 'verify.performed', description: '是否执行了写后读回验证。', required: true },
        { name: 'verify.attributes', description: '最终读回的实例配置。', required: true }
      ]
    }
  }
});

const dbRestorePlanCommand = defineCliCommand({
  rawName: 'db restore plan <instanceId>',
  description: '检查 RDS 恢复条件并生成新实例请求草案（只读）',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [
    { rawName: '--backup-id <backupId>', description: '使用指定成功备份集恢复' },
    { rawName: '--restore-time <time>', description: '使用 ISO 8601 UTC 时间点恢复' },
    { rawName: '--days <n>', description: '未选择恢复源时列出最近天数，默认 30，最大 365' },
    { rawName: '--pay-type <type>', description: '目标实例计费方式：Postpaid 或 Prepaid，默认 Postpaid' }
  ],
  descriptor: {
    title: 'Plan RDS restore to a new instance',
    summary: '读取源实例、备份集和 PITR 时间窗口，生成 CloneDBInstance 请求草案，但不执行恢复。',
    examples: [
      'licell db restore plan rm-xxx --output json',
      'licell db restore plan rm-xxx --backup-id b-xxx --output json',
      'licell db restore plan rm-xxx --restore-time 2026-09-01T08:00:00Z --output json'
    ],
    argumentHints: { instanceId: 'RDS 源实例 ID；先用 `licell db list` 获取。' },
    related: ['db backups', 'db info', 'db class', 'capability describe'],
    agentTips: [
      '先不传恢复源读取 `availability.backups[]` 和 `availability.pitr`，再显式选择 `--backup-id` 或 `--restore-time`。',
      '`requestDraft` 仅是 CloneDBInstance 参数草案；本命令不调用写 API，也不建议直接 raw invoke。',
      '表级恢复、跨地域恢复和 SQL Server 原地 recovery 不在当前范围。'
    ],
    automation: {
      preferredOutput: 'json',
      explicitInputs: ['instanceId', '--region', '--backup-id|--restore-time', '--days', '--pay-type']
    },
    safety: {
      level: 'safe',
      reason: '只调用 DescribeDBInstanceAttribute、DescribeBackups 和 DescribeLocalAvailableRecoveryTime，不调用 CloneDBInstance。',
      confirmFlags: []
    },
    optionInsights: {
      '--backup-id': { whenToUse: '从 `db backups` 或本命令的可用备份中选定一个恢复点。', conflictsWith: ['--restore-time'] },
      '--restore-time': { whenToUse: '需要恢复到精确时间点时使用，必须落在 PITR 窗口内。', conflictsWith: ['--backup-id'] },
      '--pay-type': { whenToUse: '生成目标计费参数；未传时使用 Postpaid 并输出告警。' }
    },
    recommendedFlow: [
      { title: '盘点恢复源', command: 'licell db restore plan <instanceId> --output json', reason: '获取可用备份和 PITR 时间窗口。' },
      { title: '选择恢复点', command: 'licell db restore plan <instanceId> --backup-id <backupId> --output json', reason: '校验备份状态并生成请求草案。' },
      { title: '确认目标资源', command: 'licell db class --output json', reason: '在后续受控恢复命令中显式确认规格、存储、网络和费用。' }
    ],
    result: { outcomeKey: 'validation.valid', fields: [
      { name: 'operation', description: '后续恢复对应的 RDS operation：`rds.CloneDBInstance`。', required: true },
      { name: 'source', description: '源实例引擎、状态、规格和网络摘要。', required: true },
      { name: 'availability.backups[]', description: '安全投影的备份集候选，不包含下载 URL。', required: true },
      { name: 'availability.backupsTruncated', description: '备份候选是否因单页上限而截断。', required: true },
      { name: 'availability.pitr', description: '本地时间点恢复支持状态和可用窗口。', required: true },
      { name: 'requestDraft', description: '已选恢复源时生成的 CloneDBInstance 非敏感参数草案。', required: false },
      { name: 'validation', description: '恢复源校验结果、阻断项和告警。', required: true },
      { name: 'execution', description: '固定表明本命令未执行任何恢复写操作。', required: true }
    ] }
  }
});

const dbParametersCommand = defineCliCommand({
  rawName: 'db parameters <instanceId>',
  description: '查看 RDS 运行与待生效参数（只读）',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [
    { rawName: '--prefix <prefix>', description: '按参数名前缀过滤' },
    { rawName: '--limit <n>', description: '每类返回数量，默认 50，最大 200' }
  ],
  descriptor: {
    title: 'Inspect RDS parameters', summary: '读取 RDS DescribeParameters，区分当前运行值和已配置值。',
    examples: ['licell db parameters rm-xxx --prefix max_ --output json'],
    argumentHints: { instanceId: 'RDS 实例 ID。' }, related: ['db info', 'db backups', 'capability search'],
    agentTips: ['先比较 `running[]` 与 `configured[]`，再决定是否修改参数或重启。'],
    automation: { preferredOutput: 'json', explicitInputs: ['instanceId', '--region', '--prefix', '--limit'] },
    safety: { level: 'safe', reason: '只调用 RDS DescribeParameters。', confirmFlags: [] },
    result: { outcomeKey: 'parameters', fields: [
      { name: 'instanceId', description: 'RDS 实例 ID。', required: true },
      { name: 'engine', description: '引擎和版本。', required: true },
      { name: 'parameterGroup', description: '参数模板摘要。', required: true },
      { name: 'running[]', description: '当前运行参数。', required: true },
      { name: 'configured[]', description: '已配置的待生效参数。', required: true },
      { name: 'truncated', description: '结果是否截断。', required: true }
    ] }
  }
});

const dbAccountsCommand = defineCliCommand({
  rawName: 'db accounts <instanceId>', description: '查看 RDS 账号和数据库权限（只读）',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [{ rawName: '--name <name>', description: '按账号名过滤' }, { rawName: '--limit <n>', description: '返回数量，默认 50，最大 200' }],
  descriptor: {
    title: 'List RDS accounts', summary: '读取 RDS DescribeAccounts 的账号状态与数据库权限摘要。',
    examples: ['licell db accounts rm-xxx --output json'], argumentHints: { instanceId: 'RDS 实例 ID。' },
    related: ['db databases', 'db info', 'capability search'],
    agentTips: ['本命令不读取或输出账号密码。'],
    automation: { preferredOutput: 'json', explicitInputs: ['instanceId', '--region', '--name', '--limit'] },
    safety: { level: 'safe', reason: '只调用 RDS DescribeAccounts。', confirmFlags: [] },
    result: { outcomeKey: 'accounts', fields: [
      { name: 'instanceId', description: 'RDS 实例 ID。', required: true }, { name: 'count', description: '返回账号数。', required: true },
      { name: 'truncated', description: '结果是否截断。', required: true }, { name: 'accounts[]', description: '账号名、类型、状态和数据库权限。', required: true }
    ] }
  }
});

const dbDatabasesCommand = defineCliCommand({
  rawName: 'db databases <instanceId>', description: '查看 RDS 逻辑数据库和授权（只读）',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [{ rawName: '--name <name>', description: '按数据库名过滤' }, { rawName: '--status <status>', description: '按数据库状态过滤' }, { rawName: '--limit <n>', description: '返回数量，默认 50，最大 200' }],
  descriptor: {
    title: 'List RDS databases', summary: '读取 RDS DescribeDatabases 的逻辑库、字符集及账号授权摘要。',
    examples: ['licell db databases rm-xxx --output json'], argumentHints: { instanceId: 'RDS 实例 ID。' },
    related: ['db accounts', 'db info', 'capability search'],
    agentTips: ['不输出 SDK 中未定型的 advanced/runtime 属性。'],
    automation: { preferredOutput: 'json', explicitInputs: ['instanceId', '--region', '--name', '--status', '--limit'] },
    safety: { level: 'safe', reason: '只调用 RDS DescribeDatabases。', confirmFlags: [] },
    result: { outcomeKey: 'databases', fields: [
      { name: 'instanceId', description: 'RDS 实例 ID。', required: true }, { name: 'count', description: '返回数据库数。', required: true },
      { name: 'truncated', description: '结果是否截断。', required: true }, { name: 'databases[]', description: '数据库名、状态、字符集和账号权限。', required: true }
    ] }
  }
});

const dbClassCommand = defineCliCommand({
  rawName: 'db class [type]',
  description: '查询数据库可用规格（给 Agent/开发者在 db add 前对照）',
  region: { scope: 'auth' },
  options: [
    { rawName: '--engine-version <version>', description: '数据库引擎版本（默认 postgresql=18.0，mysql=8.0）' },
    { rawName: '--category <category>', description: 'RDS Category（默认 postgresql=Basic，mysql=serverless_basic）' },
    { rawName: '--storage-type <storageType>', description: '存储类型（默认 cloud_essd）' },
    { rawName: '--zone <zoneId>', description: '按可用区过滤（如 cn-hangzhou-b）' },
    { rawName: '--all-zones', description: '聚合当前地域全部可用 zone 的 class，并标明每个 zone 有哪些规格' },
    { rawName: '--limit <n>', description: '输出数量，默认 20' }
  ],
  descriptor: {
    title: 'List database instance classes',
    notes: ['查询口径与当前 `db add` 默认创建参数保持一致。', '未传 `--zone` 且未开启 `--all-zones` 时，默认查询首个可用 zone。', '开启 `--all-zones` 后，会同时返回 `class -> zoneIds` 和 `zone -> classes` 两种聚合视角。'],
    examples: ['licell db class', 'licell db class postgresql --all-zones --limit 50', 'licell db class mysql --zone cn-hangzhou-b --output json'],
    related: ['db add', 'db list'],
    recommendedFlow: [
      { title: '先看可用规格', command: 'licell db class', reason: '确认当前地域/可用区下有哪些 class 可选，再决定 `db add --class`。' },
      { title: '再执行创建', command: 'licell db add --class <instanceClass>', reason: '把选中的规格显式传给 db add。' }
    ]
  }
});

const dbInfoCommand = defineCliCommand({
  rawName: 'db info <instanceId>',
  description: '查看数据库实例详情',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [
    { rawName: '--region <regionId>', description: '查询地域；不传则优先使用匹配的项目 database binding region，否则使用 licell 默认 region' }
  ],
  descriptor: {
    title: 'Show RDS instance detail',
    summary: '按实例 ID 聚合 RDS 属性、网络拓扑、连接端点、IP 白名单和安全组信息。',
    examples: [
      'licell db info <instanceId> --output json',
      'licell db info <instanceId> --region cn-shanghai --output json'
    ],
    related: ['db list', 'db connect', 'db public-access', 'auth repair'],
    agentTips: [
      '自动化调用优先使用 `--output json`，读取 `detail.summary`、`detail.network` 和 `detail.security`。',
      '未传 `--region` 时，若实例 ID 匹配项目 database binding 则使用其 region，否则使用 licell 默认 region；本命令不会跨 region 自动搜索。',
      '`inspectionWarnings[]` 表示白名单或安全组附加检查不可用，其他基础详情仍可使用。'
    ],
    automation: {
      preferredOutput: 'json',
      explicitInputs: ['instanceId', '--region']
    },
    safety: {
      level: 'safe',
      reason: '只调用 RDS Describe 类 API 读取实例信息，不修改云端资源或本地配置。',
      confirmFlags: []
    },
    optionInsights: {
      '--region': {
        whenToUse: '实例不在匹配的项目 database binding region 或当前 licell 默认 region 时显式指定。',
        cautions: ['只影响本次查询，不修改全局默认 region，也不会跨 region 自动搜索。']
      }
    },
    recommendedFlow: [
      { title: '列出当前地域实例', command: 'licell db list --output json', reason: '先确认实例 ID 和当前默认地域是否匹配。' },
      { title: '查看实例详情', command: 'licell db info <instanceId> --output json', reason: '聚合读取实例、网络和安全配置。' },
      { title: '修复权限', command: 'licell auth repair', reason: '若 RDS 读权限不足，补齐 bootstrap RAM policy。' }
    ],
    result: {
      summary: '返回实际查询地域以及 RDS 实例属性、网络、安全配置、数据库和账号摘要。',
      fields: [
        { name: 'regionId', description: '实际查询的 RDS region。', required: true },
        { name: 'instanceId', description: 'RDS 实例 ID。', required: true },
        { name: 'detail.summary', description: '实例引擎、状态、规格、可用区和 VPC 摘要。', required: true },
        { name: 'detail.attributes', description: 'CPU、内存、存储、生命周期和资源组等属性。', required: true },
        { name: 'detail.network', description: 'region、主备可用区、VPC、交换机和网络类型。', required: true },
        { name: 'detail.security.whitelists[]', description: 'RDS IP 白名单分组及 CIDR。', required: true },
        { name: 'detail.security.securityGroups[]', description: '关联的 ECS 安全组。', required: true },
        { name: 'detail.endpoints[]', description: '实例内网/公网连接端点。', required: true },
        { name: 'detail.databases[]', description: '数据库名称列表。', required: true },
        { name: 'detail.accounts[]', description: '数据库账号名称列表。', required: true },
        { name: 'detail.inspectionWarnings[]', description: '附加安全检查失败时的非致命告警。', required: true }
      ]
    }
  }
});

const dbConnectCommand = defineCliCommand({
  rawName: 'db connect [instanceId]',
  description: '输出数据库连接信息',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } }
});

const dbPublicAccessCommand = defineCliCommand({
  rawName: 'db public-access [instanceId]',
  description: '开通数据库公网访问并添加当前 IP 到白名单',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [
    { rawName: '--ip <ip>', description: '手动指定公网 IP（不传则自动获取）' }
  ],
  descriptor: {
    safety: {
      level: 'destructive',
      reason: '会开启数据库公网访问并修改白名单。'
    }
  }
});

const dbRmCommand = defineCliCommand({
  rawName: 'db rm <instanceId>',
  description: '删除数据库实例',
  region: { scope: 'binding', binding: 'database', target: { argumentIndex: 0 } },
  options: [
    { rawName: '--yes', description: '跳过确认' }
  ],
  descriptor: {
    safety: {
      level: 'destructive',
      reason: '会删除数据库实例，请确认实例 ID 与备份策略。'
    }
  }
});

type DbClassMode = 'all' | 'postgres' | 'mysql';

function normalizeDbClassMode(input: string | undefined): DbClassMode {
  const value = (input || '').trim().toLowerCase();
  if (!value || value === 'all') return 'all';
  if (value === 'postgres' || value === 'postgresql') return 'postgres';
  if (value === 'mysql') return 'mysql';
  throw new Error('db class [type] 仅支持 postgresql / mysql / all');
}

function printDatabaseClassCatalog(
  title: string,
  catalog: Awaited<ReturnType<typeof listDatabaseClasses>>,
  limit: number
) {
  const shown = catalog.classes.slice(0, limit);
  console.log(pc.bold(title));
  console.log(`engine:       ${pc.cyan(`${catalog.engine} ${catalog.engineVersion}`)}`);
  console.log(`chargeType:   ${pc.cyan(catalog.chargeType)}`);
  console.log(`category:     ${pc.cyan(catalog.category)}`);
  console.log(`storageType:  ${pc.cyan(catalog.storageType)}`);
  console.log(`queriedZones: ${pc.cyan(catalog.zoneIds.join(', ') || catalog.zoneId || '-')}`);
  if (catalog.queriedAllZones) {
    console.log(`matchedZones: ${pc.cyan(catalog.zones.map((zone) => zone.zoneId).join(', ') || '-')}`);
  }
  console.log(`defaultClass: ${pc.cyan(catalog.defaultClass)}`);
  console.log(`count:        ${pc.cyan(String(catalog.classes.length))}`);
  for (const item of shown) {
    const storageRange = item.storageRange?.minGb
      ? `${item.storageRange.minGb}-${item.storageRange.maxGb || item.storageRange.minGb}GB${item.storageRange.stepGb ? ` step=${item.storageRange.stepGb}` : ''}`
      : '-';
    const zones = item.zoneIds.length > 0 ? item.zoneIds.join(',') : '-';
    console.log(`${pc.cyan(item.instanceClass)}  storage=${pc.gray(storageRange)}  zones=${pc.gray(zones)}`);
  }
  if (catalog.classes.length > shown.length) {
    console.log(pc.gray(`... 仅展示前 ${shown.length} 条，可通过 --limit 查看更多`));
  }
  if (catalog.queriedAllZones && catalog.zones.length > 0) {
    console.log('');
    console.log(pc.bold('Zone Breakdown'));
    for (const zone of catalog.zones) {
      const shownClasses = zone.classes.slice(0, limit);
      console.log(`${pc.cyan(zone.zoneId)}  count=${pc.gray(String(zone.classCount))}`);
      console.log(`  classes=${pc.gray(shownClasses.join(', ') || '-')}`);
      if (zone.classes.length > shownClasses.length) {
        console.log(pc.gray(`  ... 仅展示前 ${shownClasses.length} 条，可通过 --limit 查看更多`));
      }
    }
  }
}

function clearProjectDatabaseBinding(instanceId: string) {
  const project = Config.getProject();
  if (project.database?.instanceId !== instanceId) return;

  const nextEnvs = { ...project.envs };
  for (const key of DATABASE_PROJECT_ENV_KEYS) {
    delete nextEnvs[key];
  }

  Config.setProject({
    database: undefined,
    envs: nextEnvs
  }, { replaceEnvs: true });
}

function parseDatabaseConfigDesiredState(payload: unknown, file: unknown) {
  const raw = resolveOptionalPayloadInput({ payload, file });
  if (!raw) throw new Error('db config apply 需要 --payload 或 --file');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('RDS config desired-state 不是有效 JSON');
  }
}

function printDatabaseConfigPlan(plan: Awaited<ReturnType<typeof planDatabaseConfig>>) {
  console.log(pc.bold(`RDS ${plan.instanceId} config plan`));
  console.log(`region: ${pc.cyan(plan.regionId)}`);
  for (const change of plan.changes) {
    console.log(`- ${change.field}: ${String(change.before ?? '(empty)')} -> ${String(change.after)} [${change.action}]`);
  }
}

export function registerDbCommands(cli: CAC) {
  registerCliCommand(cli, dbConfigApplyCommand)
    .action(async (instanceId: string, options: { dryRun?: unknown; yes?: unknown; payload?: unknown; file?: unknown }) => {
      await executeWithAuthRecovery({
        commandLabel: commandInvocation(dbConfigApplyCommand),
        interactiveTTY: isInteractiveTTY(),
        requiredCapabilities: Boolean(options.dryRun) ? ['rds-config-read'] : ['rds-config-write']
      }, async () => {
        ensureAuthOrExit();
        const id = toPromptValue(instanceId, 'instanceId');
        const desiredState = parseDatabaseConfigDesiredState(options.payload, options.file);
        if (Boolean(options.dryRun)) {
          const plan = await planDatabaseConfig(id, desiredState);
          const result = {
            stage: `db.config.apply.${id}`,
            plan,
            execution: { performed: false },
            verify: { performed: false, attributes: plan.current }
          };
          if (isJsonOutput()) emitCommandResult(result);
          else printDatabaseConfigPlan(plan);
          return result;
        }
        await ensureMutatingActionConfirmed(`修改 RDS ${id} 实例描述`, {
          yes: Boolean(options.yes),
          interactiveTTY: isInteractiveTTY()
        });
        const result = await applyDatabaseConfig(id, desiredState);
        if (isJsonOutput()) emitCommandResult(result);
        else printDatabaseConfigPlan(result.plan);
        return result;
      });
    });

  registerCliCommand(cli, dbRestorePlanCommand)
    .action(async (instanceId: string, options: { backupId?: unknown; restoreTime?: unknown; days?: unknown; payType?: unknown }) => {
      await executeWithAuthRecovery({ commandLabel: commandInvocation(dbRestorePlanCommand), interactiveTTY: isInteractiveTTY(), requiredCapabilities: ['rds'] }, async () => {
        ensureAuthOrExit();
        const days = parseOptionalPositiveInt(options.days, 'days') || 30;
        if (days > 365) throw new Error('days 无效：最大为 365');
        const result = await planDatabaseRestore(instanceId, {
          backupId: toOptionalString(options.backupId),
          restoreTime: toOptionalString(options.restoreTime),
          payType: toOptionalString(options.payType),
          days
        });
        const response = { stage: 'db.restore.plan', ...result };
        if (isJsonOutput()) emitCommandResult(response);
        if (!isJsonOutput()) {
          console.log(pc.bold(`RDS restore plan (${result.mode})`));
          console.log(`source=${pc.cyan(result.source.instanceId)}  engine=${result.source.engine || '-'} ${result.source.engineVersion || ''}  status=${result.source.status || '-'}`);
          console.log(`backups=${result.availability.backupCount}${result.availability.backupsTruncated ? '+' : ''}  pitr=${result.availability.pitr.available ? `${result.availability.pitr.beginTime} ~ ${result.availability.pitr.endTime}` : 'unavailable'}`);
          console.log(`valid=${result.validation.valid ? pc.green('yes') : pc.yellow('no')}  execution=${pc.gray('not performed')}`);
          for (const blocker of result.validation.blockers) console.log(pc.yellow(`- ${blocker.code}: ${blocker.message}`));
        }
      });
    });

  registerCliCommand(cli, dbBackupsCommand)
    .action(async (instanceId: string, options: { days?: unknown; status?: unknown; limit?: unknown }) => {
      await executeWithAuthRecovery({ commandLabel: commandInvocation(dbBackupsCommand), interactiveTTY: isInteractiveTTY(), requiredCapabilities: ['rds'] }, async () => {
        ensureAuthOrExit();
        const limit = parseListLimit(options.limit, 50, 200);
        const days = parseOptionalPositiveInt(options.days, 'days') || 7;
        if (days > 365) throw new Error('days 无效：最大为 365');
        const status = toOptionalString(options.status);
        const response = await listDatabaseBackups(instanceId, { days, status, limit });
        const result = { stage: 'db.backups', ...response, count: response.backups.length, filters: { days, ...(status ? { status } : {}) } };
        if (isJsonOutput()) emitCommandResult(result);
        if (!isJsonOutput()) {
          console.log(pc.bold(`RDS backups (${result.count})`));
          for (const item of result.backups) console.log(`- ${pc.cyan(item.backupId || '-')}  status=${item.status || '-'}  type=${item.type || '-'}  ended=${item.endTime || '-'}`);
        }
      });
    });

  registerCliCommand(cli, dbParametersCommand)
    .action(async (instanceId: string, options: { prefix?: unknown; limit?: unknown }) => {
      await executeWithAuthRecovery({ commandLabel: commandInvocation(dbParametersCommand), interactiveTTY: isInteractiveTTY(), requiredCapabilities: ['rds'] }, async () => {
        ensureAuthOrExit();
        const limit = parseListLimit(options.limit, 50, 200);
        const prefix = toOptionalString(options.prefix);
        const response = await listDatabaseParameters(instanceId, { prefix, limit });
        const result = { stage: 'db.parameters', ...response, filters: prefix ? { prefix } : {}, counts: { running: response.running.length, configured: response.configured.length } };
        if (isJsonOutput()) emitCommandResult(result);
        if (!isJsonOutput()) {
          console.log(pc.bold(`RDS parameters (running=${result.counts.running}, configured=${result.counts.configured})`));
          for (const item of result.running) console.log(`- ${pc.cyan(item.name || '-')}=${item.value ?? ''}`);
        }
      });
    });

  registerCliCommand(cli, dbAccountsCommand)
    .action(async (instanceId: string, options: { name?: unknown; limit?: unknown }) => {
      await executeWithAuthRecovery({ commandLabel: commandInvocation(dbAccountsCommand), interactiveTTY: isInteractiveTTY(), requiredCapabilities: ['rds'] }, async () => {
        ensureAuthOrExit();
        const limit = parseListLimit(options.limit, 50, 200);
        const name = toOptionalString(options.name);
        const response = await listDatabaseAccounts(instanceId, { name, limit });
        const result = { stage: 'db.accounts', ...response, count: response.accounts.length, filters: name ? { name } : {} };
        if (isJsonOutput()) emitCommandResult(result);
        if (!isJsonOutput()) {
          console.log(pc.bold(`RDS accounts (${result.count})`));
          for (const item of result.accounts) console.log(`- ${pc.cyan(String(item.name || '-'))}  type=${item.type || '-'}  status=${item.status || '-'}`);
        }
      });
    });

  registerCliCommand(cli, dbDatabasesCommand)
    .action(async (instanceId: string, options: { name?: unknown; status?: unknown; limit?: unknown }) => {
      await executeWithAuthRecovery({ commandLabel: commandInvocation(dbDatabasesCommand), interactiveTTY: isInteractiveTTY(), requiredCapabilities: ['rds'] }, async () => {
        ensureAuthOrExit();
        const limit = parseListLimit(options.limit, 50, 200);
        const name = toOptionalString(options.name);
        const status = toOptionalString(options.status);
        const response = await listDatabases(instanceId, { name, status, limit });
        const result = { stage: 'db.databases', ...response, count: response.databases.length, filters: { ...(name ? { name } : {}), ...(status ? { status } : {}) } };
        if (isJsonOutput()) emitCommandResult(result);
        if (!isJsonOutput()) {
          console.log(pc.bold(`RDS databases (${result.count})`));
          for (const item of result.databases) console.log(`- ${pc.cyan(String(item.name || '-'))}  status=${item.status || '-'}  charset=${item.characterSet || '-'}`);
        }
      });
    });

  registerCliCommand(cli, dbAddCommand)
    .action(async (options: {
      type?: unknown;
      engineVersion?: unknown;
      category?: unknown;
      class?: unknown;
      storage?: unknown;
      storageType?: unknown;
      minRcu?: unknown;
      maxRcu?: unknown;
      autoPause?: unknown;
      zone?: unknown;
      zoneSlave1?: unknown;
      zoneSlave2?: unknown;
      vpc?: unknown;
      vsw?: unknown;
      securityIpList?: unknown;
      description?: unknown;
    }) => {
      await executeWithAuthRecovery(
        {
          commandLabel: commandInvocation(dbAddCommand),
          interactiveTTY: isInteractiveTTY(),
          requiredCapabilities: ['rds']
        },
        async () => {
          showIntro(pc.bgMagenta(pc.white(' 🗄️ Database Provisioning (IaC) ')));
          ensureAuthOrExit();
          const interactiveTTY = isInteractiveTTY();
          let type: DbTypeInput;
          const dbTypeOption = toOptionalString(options.type);
          if (dbTypeOption) {
            type = normalizeDbType(dbTypeOption);
          } else if (interactiveTTY) {
            const selected = await select({ message: '选择数据库引擎:', options: [
              { value: 'postgres' as const, label: '🐘 RDS PostgreSQL（按量付费）' },
              { value: 'mysql' as const, label: '🐬 RDS Serverless MySQL' },
              { value: 'serverless-postgresql' as const, label: '🐘 RDS Serverless PostgreSQL（即将上线）' }
            ]});
            if (isCancel(selected)) process.exit(0);
            type = selected as DbTypeInput;
          } else {
            throw new Error('非交互模式下请传入 --type postgresql|mysql');
          }

          if (type === 'serverless-postgresql') {
            console.log(pc.yellow('⏳ Serverless PostgreSQL 即将上线，敬请期待。'));
            console.log(pc.gray(`当前支持的类型：${pc.bold('postgresql')}（按量付费）和 ${pc.bold('mysql')}（Serverless）`));
            showOutro('');
            return;
          }

          const dbType = type as 'postgres' | 'mysql';

          const storageGb = parseOptionalPositiveInt(options.storage, 'storage');
          const minCapacity = parseOptionalNumber(options.minRcu, 'min-rcu');
          const maxCapacity = parseOptionalNumber(options.maxRcu, 'max-rcu');
          if (typeof minCapacity === 'number' && minCapacity <= 0) throw new Error('min-rcu 必须大于 0');
          if (typeof maxCapacity === 'number' && maxCapacity <= 0) throw new Error('max-rcu 必须大于 0');
          if (typeof minCapacity === 'number' && typeof maxCapacity === 'number' && minCapacity > maxCapacity) {
            throw new Error('min-rcu 不能大于 max-rcu');
          }
          const autoPause = toOptionalString(options.autoPause) ? normalizeAutoPause(options.autoPause) : undefined;

          const s = createSpinner();
          const dbUrl = await withSpinner(
            s,
            '正在初始化基础设施编排引擎...',
            '❌ 拉起失败',
            () => provisionDatabase(dbType, s, {
              engineVersion: toOptionalString(options.engineVersion),
              category: toOptionalString(options.category),
              instanceClass: toOptionalString(options.class),
              storageGb,
              storageType: toOptionalString(options.storageType),
              minCapacity,
              maxCapacity,
              autoPause,
              zoneId: toOptionalString(options.zone),
              zoneIdSlave1: toOptionalString(options.zoneSlave1),
              zoneIdSlave2: toOptionalString(options.zoneSlave2),
              vpcId: toOptionalString(options.vpc),
              vSwitchId: toOptionalString(options.vsw),
              securityIpList: toOptionalString(options.securityIpList),
              description: toOptionalString(options.description)
            })
          );
          if (!dbUrl) return;
          if (!isJsonOutput()) {
            s.stop(pc.green('✅ 数据库实例已就绪并绑定到本工程内网！'));
          }
          if (isJsonOutput()) {
            emitCommandResult({
              type,
              connectionStringMasked: maskConnectionString(dbUrl)
            });
            return;
          }
          console.log(`\n🔑 内网直连凭证已生成: ${pc.cyan(maskConnectionString(dbUrl))}\n`);
          showOutro('下次执行 licell deploy 时，将自动作为 process.env.DATABASE_URL 注入！');
        }
      );
    });

  registerCliCommand(cli, dbListCommand)
    .action(async (options: { limit?: unknown }) => {
      await executeWithAuthRecovery(
        {
          commandLabel: commandInvocation(dbListCommand),
          interactiveTTY: isInteractiveTTY(),
          requiredCapabilities: ['rds']
        },
        async () => {
          ensureAuthOrExit();
          const limit = parseListLimit(options.limit, 20, 200);

          const s = createSpinner();
          const instances = await withSpinner(
            s,
            '正在拉取数据库实例列表...',
            '❌ 获取数据库实例列表失败',
            () => listDatabaseInstances(limit)
          );
          if (!instances) return;
          if (!isJsonOutput()) {
            s.stop(pc.green(`✅ 共获取 ${instances.length} 个实例`));
          }
          if (isJsonOutput()) {
            emitCommandResult({
              count: instances.length,
              instances
            });
            return;
          }
          if (instances.length === 0) {
            showOutro('当前地域没有数据库实例');
            return;
          }
          for (const item of instances) {
            console.log(
              `${pc.cyan(item.instanceId)}  engine=${pc.gray(`${item.engine || '-'} ${item.engineVersion || ''}`.trim())}  status=${pc.gray(item.status || '-')}  class=${pc.gray(item.instanceClass || '-')}`
            );
          }
          console.log('');
          showOutro('Done.');
        }
      );
    });

  registerCliCommand(cli, dbClassCommand)
    .action(async (typeInput: string | undefined, options: {
      engineVersion?: unknown;
      category?: unknown;
      storageType?: unknown;
      zone?: unknown;
      allZones?: unknown;
      limit?: unknown;
    }) => {
      await executeWithAuthRecovery(
        {
          commandLabel: commandInvocation(dbClassCommand),
          interactiveTTY: isInteractiveTTY(),
          requiredCapabilities: ['rds']
        },
        async () => {
          ensureAuthOrExit();
          const mode = normalizeDbClassMode(toOptionalString(typeInput));
          const limit = parseListLimit(options.limit, 20, 500);
          const queryOptions = {
            engineVersion: toOptionalString(options.engineVersion),
            category: toOptionalString(options.category),
            storageType: toOptionalString(options.storageType),
            zoneId: toOptionalString(options.zone),
            allZones: Boolean(options.allZones)
          };
          const s = createSpinner();
          const result = await withSpinner(
            s,
            '正在查询数据库规格...',
            '❌ 获取数据库规格失败',
            async () => {
              if (mode === 'all') {
                const postgres = await listDatabaseClasses('postgres', queryOptions);
                const mysql = await listDatabaseClasses('mysql', queryOptions);
                return { postgres, mysql };
              }
              const catalog = await listDatabaseClasses(mode, queryOptions);
              return { [mode]: catalog } as { postgres?: typeof catalog; mysql?: typeof catalog };
            }
          );
          if (!result) return;
          const postgres = result.postgres || null;
          const mysql = result.mysql || null;
          if (!isJsonOutput()) {
            s.stop(pc.green('✅ 数据库规格已返回'));
          } else {
            emitCommandResult({
              mode,
              allZones: queryOptions.allZones,
              zoneId: queryOptions.zoneId || null,
              postgres: postgres ? {
                ...postgres,
                matchedZoneIds: postgres.zones.map((zone) => zone.zoneId),
                totalCount: postgres.classes.length,
                shownCount: Math.min(limit, postgres.classes.length),
                truncated: postgres.classes.length > limit,
                classes: postgres.classes.slice(0, limit),
                zones: postgres.zones.map((zone) => ({
                  ...zone,
                  shownCount: Math.min(limit, zone.classes.length),
                  truncated: zone.classes.length > limit,
                  classes: zone.classes.slice(0, limit)
                }))
              } : null,
              mysql: mysql ? {
                ...mysql,
                matchedZoneIds: mysql.zones.map((zone) => zone.zoneId),
                totalCount: mysql.classes.length,
                shownCount: Math.min(limit, mysql.classes.length),
                truncated: mysql.classes.length > limit,
                classes: mysql.classes.slice(0, limit),
                zones: mysql.zones.map((zone) => ({
                  ...zone,
                  shownCount: Math.min(limit, zone.classes.length),
                  truncated: zone.classes.length > limit,
                  classes: zone.classes.slice(0, limit)
                }))
              } : null
            });
            return;
          }
          if (postgres) {
            printDatabaseClassCatalog('PostgreSQL', postgres, limit);
          }
          if (postgres && mysql) console.log('');
          if (mysql) {
            printDatabaseClassCatalog('MySQL', mysql, limit);
          }
          showOutro('Done.');
        }
      );
    });

  registerCliCommand(cli, dbInfoCommand)
    .action(async (instanceId: string, options: { region?: unknown }) => {
      await executeWithAuthRecovery(
        {
          commandLabel: commandInvocation(dbInfoCommand),
          interactiveTTY: isInteractiveTTY(),
          requiredCapabilities: ['rds']
        },
        async () => {
          ensureAuthOrExit();
          const normalizedId = toPromptValue(instanceId, 'instanceId');
          const regionId = toOptionalString(options.region);
          const s = createSpinner();
          const detail = await withSpinner(
            s,
            `正在拉取实例 ${normalizedId} 详情...`,
            '❌ 获取数据库实例详情失败',
            () => getDatabaseInstanceDetail(normalizedId, regionId ? { regionId } : undefined)
          );
          if (!detail) return;
          const summary = detail.summary;
          if (!isJsonOutput()) {
            s.stop(pc.green('✅ 获取成功'));
          } else {
            emitCommandResult({
              regionId: detail.network.regionId,
              instanceId: detail.summary.instanceId,
              detail
            });
            return;
          }
          console.log(`\ninstanceId: ${pc.cyan(summary.instanceId)}`);
          console.log(`engine:     ${pc.cyan(`${summary.engine || '-'} ${summary.engineVersion || ''}`.trim())}`);
          console.log(`status:     ${pc.cyan(summary.status || '-')}`);
          console.log(`class:      ${pc.cyan(summary.instanceClass || '-')}`);
          console.log(`payType:    ${pc.cyan(summary.payType || '-')}`);
          console.log(`region:     ${pc.cyan(detail.network.regionId)}`);
          console.log(`vpc/vsw:    ${pc.cyan(`${summary.vpcId || '-'} / ${summary.vSwitchId || '-'}`)}`);
          console.log(`zone:       ${pc.cyan(summary.zoneId || '-')}`);
          if (detail.network.slaveZoneIds.length > 0) console.log(`slaveZones: ${pc.cyan(detail.network.slaveZoneIds.join(', '))}`);
          console.log(`network:    ${pc.cyan(detail.network.networkType || '-')}`);
          console.log(`storage:    ${pc.cyan(`${detail.attributes.storageGb ?? '-'} GB / ${detail.attributes.storageType || '-'}`)}`);
          if (detail.endpoints.length > 0) {
            console.log(`endpoints:  ${pc.cyan(detail.endpoints.map((item) => `${item.ipType || item.type || '-'}:${item.host || '-'}:${item.port || '-'}`).join(', '))}`);
          }
          if (detail.databases.length > 0) console.log(`databases:  ${pc.cyan(detail.databases.join(', '))}`);
          if (detail.accounts.length > 0) console.log(`accounts:   ${pc.cyan(detail.accounts.join(', '))}`);
          if (detail.security.whitelists.length > 0) {
            console.log(`whitelists: ${pc.cyan(detail.security.whitelists.map((item) => `${item.name || 'default'}=${item.ips.join(',') || '-'}`).join('; '))}`);
          }
          if (detail.security.securityGroups.length > 0) {
            console.log(`securityGroups: ${pc.cyan(detail.security.securityGroups.map((item) => `${item.id || '-'}${item.name ? `(${item.name})` : ''}`).join(', '))}`);
          }
          for (const warning of detail.inspectionWarnings) {
            console.log(pc.yellow(`warning[${warning.source}]: ${warning.message}`));
          }
          console.log('');
          showOutro('Done.');
        }
      );
    });

  registerCliCommand(cli, dbConnectCommand)
    .action(async (instanceId: string | undefined) => {
      await executeWithAuthRecovery(
        {
          commandLabel: commandInvocation(dbConnectCommand),
          interactiveTTY: isInteractiveTTY(),
          requiredCapabilities: ['rds']
        },
        async () => {
          ensureAuthOrExit();
          const normalizedId = toOptionalString(instanceId);
          const s = createSpinner();
          const info = await withSpinner(
            s,
            '正在解析数据库连接信息...',
            '❌ 连接信息解析失败',
            () => resolveDatabaseConnectInfo(normalizedId)
          );
          if (!info) return;
          if (!isJsonOutput()) {
            s.stop(pc.green('✅ 连接信息已生成'));
          } else {
            emitCommandResult({
              instanceId: info.instanceId,
              connection: info
            });
            return;
          }
          console.log(`\ninstanceId: ${pc.cyan(info.instanceId)}`);
          console.log(`engine:     ${pc.cyan(info.engine)}`);
          console.log(`host:       ${pc.cyan(info.host)}`);
          console.log(`port:       ${pc.cyan(String(info.port))}`);
          console.log(`database:   ${pc.cyan(info.database)}`);
          console.log(`username:   ${pc.cyan(info.username)}`);
          console.log(`password:   ${pc.cyan(info.passwordKnown ? '<known in project>' : '<unknown, please provide manually>')}`);
          console.log(`url:        ${pc.cyan(info.connectionString)}`);
          if (info.publicHost) {
            console.log('');
            console.log(pc.yellow('── 公网访问 ──'));
            console.log(`public host: ${pc.cyan(info.publicHost)}`);
            console.log(`public port: ${pc.cyan(String(info.publicPort))}`);
            console.log(`public url:  ${pc.cyan(info.publicConnectionString!)}`);
          }
          console.log('');
          showOutro('Done.');
        }
      );
    });

  registerCliCommand(cli, dbPublicAccessCommand)
    .action(async (instanceId: string | undefined, options: { ip?: string }) => {
      await executeWithAuthRecovery(
        {
          commandLabel: commandInvocation(dbPublicAccessCommand),
          interactiveTTY: isInteractiveTTY(),
          requiredCapabilities: ['rds']
        },
        async () => {
          const { resolvePublicIp } = await import('../utils/public-ip');
          showIntro(pc.bgMagenta(pc.white(' 🌐 DB Public Access ')));
          ensureAuthOrExit();
          const resolvedId = toOptionalString(instanceId);
          const s = createSpinner();

          s.start('正在获取公网 IP...');
          const publicIp = options.ip?.trim() || await resolvePublicIp();
          s.stop(`公网 IP: ${pc.cyan(publicIp)}`);

          const info = await withSpinner(
            s,
            '正在解析数据库连接信息...',
            '❌ 连接信息解析失败',
            () => resolveDatabaseConnectInfo(resolvedId)
          );
          if (!info) return;

          await withSpinner(
            s,
            `正在将 ${publicIp}/32 添加到白名单 (licell_public)...`,
            '❌ 白名单设置失败',
            () => applyDbPublicWhitelist(info.instanceId, publicIp, s)
          );

          const pub = await withSpinner(
            s,
            '正在开通公网访问...',
            '❌ 公网访问开通失败',
            () => allocateDbPublicConnection(info.instanceId, s)
          );

          if (!isJsonOutput()) {
            s.stop(pc.green('✅ 公网访问已开通'));
          } else {
            emitCommandResult({
              instanceId: info.instanceId,
              publicIp,
              publicHost: pub?.host || null,
              publicPort: pub?.port || null
            });
            return;
          }

          console.log('');
          console.log(pc.yellow('── 内网访问 ──'));
          console.log(`host: ${pc.cyan(info.host)}`);
          console.log(`port: ${pc.cyan(String(info.port))}`);
          console.log(`url:  ${pc.cyan(info.connectionString)}`);
          if (pub) {
            console.log('');
            console.log(pc.yellow('── 公网访问 ──'));
            console.log(`host: ${pc.cyan(pub.host)}`);
            console.log(`port: ${pc.cyan(pub.port)}`);
            const protocol = info.engine;
            const renderedUser = info.username === '<username>' ? info.username : encodeURIComponent(info.username);
            const renderedPassword = info.passwordKnown ? '<password>' : '<password>';
            console.log(`url:  ${pc.cyan(`${protocol}://${renderedUser}:${renderedPassword}@${pub.host}:${pub.port}/${info.database}`)}`);
          } else {
            console.log(pc.yellow('\n⚠️ 公网地址尚未就绪，请稍后通过 db connect 查看'));
          }
          console.log(`\n白名单 IP: ${pc.cyan(`${publicIp}/32`)} (分组: licell_public)`);
          showOutro('Done.');
        }
      );
    });

  registerCliCommand(cli, dbRmCommand)
    .action(async (instanceId: string, options: { yes?: boolean }) => {
      await executeWithAuthRecovery(
        {
          commandLabel: commandInvocation(dbRmCommand),
          interactiveTTY: isInteractiveTTY(),
          requiredCapabilities: ['rds']
        },
        async () => {
          showIntro(pc.bgRed(pc.white(' 🗑️ Delete Database ')));
          ensureAuthOrExit();
          const id = instanceId.trim();
          if (!id) throw new Error('请提供 instanceId');

          if (!options.yes && isInteractiveTTY()) {
            const ok = await confirm({ message: `确认删除数据库实例 ${pc.red(id)}？此操作不可恢复。` });
            if (isCancel(ok) || !ok) {
              showOutro('已取消');
              return;
            }
          }

          const s = createSpinner();
          const result = await withSpinner(
            s,
            `正在删除实例 ${id}...`,
            '❌ 删除失败',
            async () => {
              await deleteDatabaseInstance(id);
              clearProjectDatabaseBinding(id);
              return { instanceId: id };
            }
          );
          if (!result) return;

          if (isJsonOutput()) {
            emitCommandResult(result);
            return;
          }
          s.stop(pc.green(`✅ 实例 ${id} 已删除`));
          showOutro('Done.');
        }
      );
    });
}

export const dbCommandModule = defineCommandModule({
  section: DATA_SECTION,
  register: registerDbCommands,
  namespaces: {
    db: {
      summary: 'RDS 数据库实例的创建、查看、配置预览、连接、公网访问与删除。',
      notes: ['公网访问与删除属于高影响操作，自动化执行前应先确认。'],
      examples: ['licell db list', 'licell db info <instanceId>', 'licell db config apply <instanceId> --file <path> --dry-run --output json', 'licell db backups <instanceId> --output json', 'licell db restore plan <instanceId> --output json', 'licell db parameters <instanceId> --output json', 'licell db accounts <instanceId> --output json', 'licell db databases <instanceId> --output json', 'licell db connect <instanceId> --output json'],
      agentTips: ['优先从 `licell db list --output json` 获取实例；配置变更先执行 `db config apply --dry-run`；恢复前必须先执行 `licell db restore plan`。']
    }
  },
  commands: [dbAddCommand, dbClassCommand, dbListCommand, dbInfoCommand, dbConfigApplyCommand, dbBackupsCommand, dbRestorePlanCommand, dbParametersCommand, dbAccountsCommand, dbDatabasesCommand, dbConnectCommand, dbPublicAccessCommand, dbRmCommand]
});
