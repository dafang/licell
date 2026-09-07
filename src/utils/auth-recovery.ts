import { confirm, isCancel, password, text } from '@clack/prompts';
import pc from 'picocolors';
import { repairLicellRamAccess } from '../providers/ram';
import { isAccessDeniedError, isAuthCredentialInvalidError } from './alicloud-error';
import { isInteractiveTTY, toOptionalString, toPromptValue } from './cli-shared';
import { Config, DEFAULT_ALI_REGION, type AuthConfig } from './config';
import { readEnvWithFallback } from './env';

export type AuthIssueKind = 'missing_auth' | 'access_denied' | 'invalid_credentials' | 'unknown';
export type AuthCapability = 'fc' | 'dns' | 'oss' | 'oss-config-read' | 'oss-config-write' | 'rds' | 'rds-config-read' | 'rds-config-write' | 'rdsai' | 'redis' | 'redis-backup-read' | 'redis-backup-write' | 'cdn' | 'vpc' | 'vpc-read' | 'vpc-write' | 'cr' | 'logs' | 'ecs';

export const AUTH_CAPABILITY_LABELS: Record<AuthCapability, string> = {
  fc: '函数计算',
  dns: '云解析 DNS',
  oss: 'OSS',
  'oss-config-read': 'OSS 高级配置读取',
  'oss-config-write': 'OSS 高级配置修改',
  rds: 'RDS',
  'rds-config-read': 'RDS 配置读取',
  'rds-config-write': 'RDS 配置修改',
  rdsai: 'RDS AI (Supabase)',
  redis: 'Redis/Tair',
  'redis-backup-read': 'Redis/Tair 备份策略读取',
  'redis-backup-write': 'Redis/Tair 备份策略修改',
  cdn: 'CDN',
  vpc: 'VPC',
  'vpc-read': 'VPC 只读查询',
  'vpc-write': 'VPC 属性修改',
  cr: '容器镜像仓库 CR',
  logs: '日志服务 SLS',
  ecs: 'ECS'
};

const CAPABILITY_ACTIONS: Record<AuthCapability, string[]> = {
  fc: ['fc:ListFunctions', 'fc:GetFunction', 'fc:UpdateFunction'],
  dns: ['alidns:DescribeDomainRecords', 'alidns:AddDomainRecord', 'alidns:DeleteDomainRecord'],
  oss: [
    'oss:ListBuckets',
    'oss:ListObjects',
    'oss:GetBucketInfo',
    'oss:GetBucketAcl',
    'oss:PutBucket',
    'oss:DeleteBucket',
    'oss:PutBucketACL',
    'oss:PutBucketPublicAccessBlock',
    'oss:GetBucketPublicAccessBlock',
    'oss:DeleteBucketPublicAccessBlock',
    'oss:GetObject',
    'oss:PutObject',
    'oss:DeleteObject',
    'oss:ListCname',
    'oss:CreateCnameToken',
    'oss:PutCname',
    'oss:DeleteCname'
  ],
  'oss-config-read': [
    'oss:GetBucketLifecycle',
    'oss:GetBucketCors',
    'oss:GetBucketEncryption',
    'oss:GetBucketWebsite'
  ],
  'oss-config-write': [
    'oss:GetBucketLifecycle',
    'oss:PutBucketLifecycle',
    'oss:DeleteBucketLifecycle',
    'oss:GetBucketCors',
    'oss:PutBucketCors',
    'oss:DeleteBucketCors',
    'oss:GetBucketEncryption',
    'oss:PutBucketEncryption',
    'oss:DeleteBucketEncryption',
    'oss:GetBucketWebsite',
    'oss:PutBucketWebsite',
    'oss:DeleteBucketWebsite'
  ],
  rds: [
    'rds:DescribeDBInstances',
    'rds:DescribeDBInstanceAttribute',
    'rds:DescribeDBInstanceNetInfo',
    'rds:DescribeDatabases',
    'rds:DescribeAccounts',
    'rds:DescribeBackups',
    'rds:DescribeBackupPolicy',
    'rds:DescribeLocalAvailableRecoveryTime',
    'rds:DescribeParameters',
    'rds:DescribeDBInstanceIPArrayList',
    'rds:DescribeSecurityGroupConfiguration',
    'rds:CreateDBInstance',
    'rds:CreateDatabase',
    'rds:DeleteDBInstance'
  ],
  'rds-config-read': ['rds:DescribeDBInstanceAttribute'],
  'rds-config-write': ['rds:DescribeDBInstanceAttribute', 'rds:ModifyDBInstanceDescription'],
  rdsai: ['rdsai:CreateAppInstance', 'rdsai:DescribeAppInstances', 'rdsai:DeleteAppInstance'],
  redis: [
    'kvstore:DescribeInstances',
    'kvstore:DescribeAccounts',
    'kvstore:DescribeBackups',
    'kvstore:DescribeBackupPolicy',
    'kvstore:DescribeParameters',
    'kvstore:DescribeInstanceConfig',
    'kvstore:DescribeClusterMemberInfo',
    'kvstore:CreateTairKVCacheVNode',
    'kvstore:ResetAccountPassword'
  ],
  'redis-backup-read': ['kvstore:DescribeBackupPolicy'],
  'redis-backup-write': ['kvstore:DescribeBackupPolicy', 'kvstore:ModifyBackupPolicy'],
  cdn: ['cdn:DescribeUserDomains', 'cdn:AddCdnDomain', 'cdn:BatchSetCdnDomainConfig'],
  vpc: ['vpc:DescribeVpcs', 'vpc:CreateVpc', 'vpc:CreateVSwitch'],
  'vpc-read': [
    'vpc:DescribeVpcs',
    'vpc:DescribeVSwitches',
    'vpc:DescribeRouteTables',
    'vpc:DescribeNatGateways',
    'vpc:DescribeEipAddresses'
  ],
  'vpc-write': ['vpc:DescribeVpcs', 'vpc:ModifyVpcAttribute'],
  cr: ['cr:ListInstance', 'cr:ListNamespace', 'cr:ListRepository', 'cr:ListRepoTag', 'cr:CreateNamespace', 'cr:CreateRepository'],
  logs: ['log:GetLogs', 'log:ListProject', 'log:ListLogStores', 'log:CreateProject', 'log:CreateLogStore', 'log:CreateIndex'],
  ecs: ['ecs:DescribeInstanceAttribute', 'ecs:DescribeInstances', 'ecs:DescribeDisks', 'ecs:StartInstance', 'ecs:RebootInstance', 'ecs:StopInstance', 'ecs:DeleteInstance']
};

const preflightPrompted = new Set<string>();
const preflightWarned = new Set<string>();

export interface AuthRepairFlowInput {
  commandLabel: string;
  reason: AuthIssueKind | 'manual';
  accountId?: string;
  region?: string;
  adminAk?: string;
  adminSk?: string;
  bootstrapUser?: string;
  bootstrapPolicy?: string;
  forceRotateKey?: boolean;
  interactiveTTY?: boolean;
  currentAuth?: AuthConfig | null;
}

export interface AuthRepairFlowResult {
  mode: 'updated-existing-key' | 'rotated-new-key';
  userName: string;
  policyName: string;
  accountId: string;
  region: string;
  rotatedKey: boolean;
}

function isMissingAuthError(err: unknown) {
  const text = `${String((err as { code?: unknown })?.code || '')} ${String((err as { message?: unknown })?.message || err || '')}`.toLowerCase();
  return text.includes('未登录') || text.includes('先执行 `licell login`') || text.includes('please login');
}

export function detectAuthIssue(err: unknown): AuthIssueKind {
  if (isMissingAuthError(err)) return 'missing_auth';
  if (isAuthCredentialInvalidError(err)) return 'invalid_credentials';
  if (isAccessDeniedError(err)) return 'access_denied';
  return 'unknown';
}

function issueLabel(issue: AuthIssueKind | 'manual') {
  if (issue === 'missing_auth') return '未登录';
  if (issue === 'invalid_credentials') return 'AK/SK 无效或已失效';
  if (issue === 'access_denied') return 'AK/SK 权限不足';
  if (issue === 'manual') return '手动触发授权修复';
  return '未知认证错误';
}

function normalizeCapabilities(capabilities: AuthCapability[] | undefined) {
  if (!capabilities || capabilities.length === 0) return [];
  return [...new Set(capabilities)];
}

export function resolveAuthCapabilityActions(capabilities: AuthCapability[]) {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.length === 0) return [];
  return [...new Set(normalized.flatMap((capability) => CAPABILITY_ACTIONS[capability] || []))].sort();
}

function describeCapabilities(capabilities: AuthCapability[]) {
  const normalized = normalizeCapabilities(capabilities);
  if (normalized.length === 0) return '';
  return normalized.map((capability) => AUTH_CAPABILITY_LABELS[capability]).join(' / ');
}

function ensureProceedInInteractive(commandLabel: string, reason: AuthIssueKind | 'manual') {
  return confirm({
    message: `${commandLabel} 检测到 ${issueLabel(reason)}。是否现在进入 bootstrap 授权修复流程？`,
    initialValue: true
  });
}

function resolveAdminInput(input: AuthRepairFlowInput, currentAuth: AuthConfig | null) {
  const accountId = toOptionalString(input.accountId)
    || readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_ACCOUNT_ID', 'LICELL_ACCOUNT_ID')
    || readEnvWithFallback(process.env, 'ALI_ACCOUNT_ID')
    || currentAuth?.accountId;
  const adminAk = toOptionalString(input.adminAk)
    || readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_ACCESS_KEY_ID', 'LICELL_ACCESS_KEY_ID')
    || readEnvWithFallback(process.env, 'ALI_ACCESS_KEY_ID');
  const adminSk = toOptionalString(input.adminSk)
    || readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_ACCESS_KEY_SECRET', 'LICELL_ACCESS_KEY_SECRET')
    || readEnvWithFallback(process.env, 'ALI_ACCESS_KEY_SECRET');
  const region = toOptionalString(input.region)
    || readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_REGION', 'LICELL_REGION')
    || readEnvWithFallback(process.env, 'ALI_REGION')
    || currentAuth?.region
    || DEFAULT_ALI_REGION;
  return { accountId, adminAk, adminSk, region };
}

function throwNonInteractiveAuthRepairError(commandLabel: string, reason: AuthIssueKind | 'manual') {
  throw new Error(
    `${commandLabel} 检测到 ${issueLabel(reason)}，且当前为非交互模式。\n` +
    '请先执行 `licell auth repair --account-id <id> --ak <super-ak> --sk <super-sk> [--region cn-hangzhou]`，然后重试。'
  );
}

function isRecoverableSelfRepairFailure(err: unknown) {
  if (isAccessDeniedError(err) || isAuthCredentialInvalidError(err)) return true;
  const text = `${String((err as { code?: unknown })?.code || '')} ${String((err as { message?: unknown })?.message || err || '')}`.toLowerCase();
  return text.includes('forbidden')
    || text.includes('accessdenied')
    || text.includes('not authorized')
    || text.includes('permission');
}

async function tryRepairWithCurrentAuth(input: AuthRepairFlowInput, currentAuth: AuthConfig | null) {
  if (!currentAuth || input.forceRotateKey) return null;
  try {
    const repaired = await repairLicellRamAccess({
      adminAuth: {
        accountId: currentAuth.accountId,
        ak: currentAuth.ak,
        sk: currentAuth.sk,
        region: currentAuth.region
      },
      currentAuth,
      userName: input.bootstrapUser,
      policyName: input.bootstrapPolicy,
      forceRotateKey: false
    });

    Config.setAuth({
      accountId: currentAuth.accountId,
      ak: repaired.accessKeyId,
      sk: repaired.accessKeySecret,
      region: currentAuth.region,
      authSource: 'bootstrap',
      ramUser: repaired.userName,
      ramPolicy: repaired.policyName
    });

    return {
      mode: repaired.mode,
      userName: repaired.userName,
      policyName: repaired.policyName,
      accountId: currentAuth.accountId,
      region: currentAuth.region,
      rotatedKey: repaired.mode === 'rotated-new-key'
    } as AuthRepairFlowResult;
  } catch (err: unknown) {
    if (isRecoverableSelfRepairFailure(err)) return null;
    throw err;
  }
}

export async function runAuthRepairFlow(input: AuthRepairFlowInput): Promise<AuthRepairFlowResult> {
  const currentAuth = input.currentAuth ?? Config.getAuth();
  const interactive = input.interactiveTTY ?? isInteractiveTTY();
  const defaults = resolveAdminInput(input, currentAuth);

  const selfRepair = await tryRepairWithCurrentAuth(input, currentAuth);
  if (selfRepair) return selfRepair;

  let accountId = defaults.accountId;
  let adminAk = defaults.adminAk;
  let adminSk = defaults.adminSk;
  let region = defaults.region;

  if (interactive) {
    console.log(pc.gray('\n检测到需要授权修复。'));
    console.log(pc.gray('不会配置 RAM 权限可使用 bootstrap：只在内存使用超级 AK/SK，不会写入本地文件。'));
    console.log(pc.gray('超级 AK/SK 获取地址: https://ram.console.aliyun.com/profile/access-keys\n'));
    const proceed = await ensureProceedInInteractive(input.commandLabel, input.reason);
    if (isCancel(proceed)) process.exit(0);
    if (!proceed) {
      throw new Error('操作已取消。你可以稍后执行 `licell auth repair` 或 `licell login --bootstrap-ram`。');
    }
  }

  if (!interactive && (!accountId || !adminAk || !adminSk)) {
    throwNonInteractiveAuthRepairError(input.commandLabel, input.reason);
  }

  if (!accountId) {
    accountId = toPromptValue(
      await text({ message: '输入阿里云 Account ID (主账号ID):', initialValue: currentAuth?.accountId || '' }),
      'Account ID'
    );
  }
  if (!adminAk) {
    adminAk = toPromptValue(await text({ message: '输入超级 AccessKey ID:' }), '超级 AccessKey ID');
  }
  if (!adminSk) {
    adminSk = toPromptValue(await password({ message: '输入超级 AccessKey Secret:' }), '超级 AccessKey Secret');
  }
  if (!region) {
    region = toPromptValue(
      await text({ message: `默认 Region (回车使用 ${DEFAULT_ALI_REGION}):`, initialValue: DEFAULT_ALI_REGION }),
      'Region'
    );
  }

  const repaired = await repairLicellRamAccess({
    adminAuth: {
      accountId,
      ak: adminAk,
      sk: adminSk,
      region
    },
    currentAuth,
    userName: input.bootstrapUser,
    policyName: input.bootstrapPolicy,
    forceRotateKey: Boolean(input.forceRotateKey)
  });

  Config.setAuth({
    accountId,
    ak: repaired.accessKeyId,
    sk: repaired.accessKeySecret,
    region,
    authSource: 'bootstrap',
    ramUser: repaired.userName,
    ramPolicy: repaired.policyName
  });

  return {
    mode: repaired.mode,
    userName: repaired.userName,
    policyName: repaired.policyName,
    accountId,
    region,
    rotatedKey: repaired.mode === 'rotated-new-key'
  };
}

export async function ensureAuthReadyForCommand(options: {
  commandLabel: string;
  interactiveTTY?: boolean;
}) {
  const auth = Config.getAuth();
  if (auth) return;
  await runAuthRepairFlow({
    commandLabel: options.commandLabel,
    reason: 'missing_auth',
    interactiveTTY: options.interactiveTTY,
    currentAuth: null
  });
}

export async function ensureAuthCapabilityPreflight(options: {
  commandLabel: string;
  requiredCapabilities?: AuthCapability[];
  interactiveTTY?: boolean;
  bootstrapUser?: string;
  bootstrapPolicy?: string;
}) {
  const requiredCapabilities = normalizeCapabilities(options.requiredCapabilities);
  if (requiredCapabilities.length === 0) return;

  const currentAuth = Config.getAuth();
  if (!currentAuth) return;
  if (currentAuth.authSource === 'bootstrap' || currentAuth.ramUser || currentAuth.ramPolicy) return;

  const capabilityLabel = describeCapabilities(requiredCapabilities);
  const actionHints = resolveAuthCapabilityActions(requiredCapabilities).slice(0, 6);
  const preflightKey = `${options.commandLabel}|${requiredCapabilities.join(',')}`;
  const interactiveTTY = options.interactiveTTY ?? isInteractiveTTY();

  if (interactiveTTY) {
    if (preflightPrompted.has(preflightKey)) return;
    preflightPrompted.add(preflightKey);

    console.log(pc.yellow(`\n⚠️ ${options.commandLabel} 需要 ${capabilityLabel} 相关权限。`));
    console.log(pc.yellow('当前凭证来自手动登录，若权限不完整会在执行阶段失败。'));
    if (actionHints.length > 0) {
      console.log(pc.gray(`权限示例: ${actionHints.join(', ')}`));
    }

    const proceed = await confirm({
      message: '是否现在执行 bootstrap 授权修复（推荐）？',
      initialValue: true
    });
    if (isCancel(proceed)) process.exit(0);
    if (!proceed) return;

    await runAuthRepairFlow({
      commandLabel: options.commandLabel,
      reason: 'manual',
      interactiveTTY,
      currentAuth,
      bootstrapUser: options.bootstrapUser,
      bootstrapPolicy: options.bootstrapPolicy
    });
    return;
  }

  const accountId = readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_ACCOUNT_ID', 'LICELL_ACCOUNT_ID')
    || readEnvWithFallback(process.env, 'ALI_ACCOUNT_ID')
    || currentAuth.accountId;
  const adminAk = readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_ACCESS_KEY_ID', 'LICELL_ACCESS_KEY_ID')
    || readEnvWithFallback(process.env, 'ALI_ACCESS_KEY_ID');
  const adminSk = readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_ACCESS_KEY_SECRET', 'LICELL_ACCESS_KEY_SECRET')
    || readEnvWithFallback(process.env, 'ALI_ACCESS_KEY_SECRET');
  const region = readEnvWithFallback(process.env, 'LICELL_BOOTSTRAP_REGION', 'LICELL_REGION')
    || readEnvWithFallback(process.env, 'ALI_REGION')
    || currentAuth.region
    || DEFAULT_ALI_REGION;

  if (accountId && adminAk && adminSk) {
    try {
      await runAuthRepairFlow({
        commandLabel: options.commandLabel,
        reason: 'manual',
        interactiveTTY: false,
        currentAuth,
        accountId,
        region,
        adminAk,
        adminSk,
        bootstrapUser: options.bootstrapUser,
        bootstrapPolicy: options.bootstrapPolicy
      });
      return;
    } catch (err: unknown) {
      console.warn(pc.yellow(`⚠️ 自动授权修复未成功，继续执行原命令: ${String((err as { message?: unknown })?.message || err)}`));
    }
  }

  if (preflightWarned.has(preflightKey)) return;
  preflightWarned.add(preflightKey);
  console.warn(pc.yellow(`⚠️ ${options.commandLabel} 可能需要 ${capabilityLabel} 权限。`));
  if (actionHints.length > 0) {
    console.warn(pc.gray(`权限示例: ${actionHints.join(', ')}`));
  }
  console.warn(pc.yellow('建议先执行 `licell auth repair --account-id <id> --ak <super-ak> --sk <super-sk>` 后再重试。'));
}

export async function tryRecoverAuthForError(
  err: unknown,
  options: {
    commandLabel: string;
    interactiveTTY?: boolean;
    bootstrapUser?: string;
    bootstrapPolicy?: string;
  }
) {
  const issue = detectAuthIssue(err);
  if (issue === 'unknown') return false;
  await runAuthRepairFlow({
    commandLabel: options.commandLabel,
    reason: issue,
    interactiveTTY: options.interactiveTTY,
    bootstrapUser: options.bootstrapUser,
    bootstrapPolicy: options.bootstrapPolicy,
    forceRotateKey: issue === 'invalid_credentials'
  });
  return true;
}

export async function executeWithAuthRecovery<T>(
  options: {
    commandLabel: string;
    interactiveTTY?: boolean;
    bootstrapUser?: string;
    bootstrapPolicy?: string;
    preflight?: boolean;
    requiredCapabilities?: AuthCapability[];
  },
  task: () => Promise<T>
): Promise<T> {
  const interactiveTTY = options.interactiveTTY ?? isInteractiveTTY();
  if (options.preflight !== false) {
    await ensureAuthReadyForCommand({ commandLabel: options.commandLabel, interactiveTTY });
    await ensureAuthCapabilityPreflight({
      commandLabel: options.commandLabel,
      interactiveTTY,
      bootstrapUser: options.bootstrapUser,
      bootstrapPolicy: options.bootstrapPolicy,
      requiredCapabilities: options.requiredCapabilities
    });
  }

  let recovered = false;
  while (true) {
    try {
      return await task();
    } catch (err: unknown) {
      if (!recovered) {
        const didRecover = await tryRecoverAuthForError(err, {
          commandLabel: options.commandLabel,
          interactiveTTY,
          bootstrapUser: options.bootstrapUser,
          bootstrapPolicy: options.bootstrapPolicy
        });
        if (didRecover) {
          recovered = true;
          continue;
        }
      }
      throw err;
    }
  }
}
