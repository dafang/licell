import CR, * as $CR from '@alicloud/cr20181201';
import SLS, * as $SLS from '@alicloud/sls20201230';
import Vpc, * as $Vpc from '@alicloud/vpc20160428';
import * as $OpenApi from '@alicloud/openapi-client';
import * as $Util from '@alicloud/tea-util';
import { inspectLicellRamAccess } from './ram';
import { getFunctionInfo, listFunctions } from './fc/function-ops';
import { listFnCustomDomains, resolveDefaultFcGatewayDomain, type FnCustomDomainState } from './fc/custom-domain';
import { listFunctionAliases, listFunctionVersions } from './fc/release';
import { getCdnDomainDetail, listCdnDomains, type CdnDomainDetail } from './cdn';
import { listEcsInstances } from './ecs';
import { listDatabaseInstances } from './infra/query';
import { getOssBucketInfo, listOssBuckets, listOssObjects, resolveOssBucketName, resolveOssBucketOriginDomain } from './oss';
import { listCacheInstances } from './redis/query';
import { listSupabaseInstances } from './supabase/query';
import { listDnsRecords, normalizeDnsValue, resolveAuthoritativeDnsSnapshot } from './dns';
import { discoverDefaultFcSlsTargets } from './logs';
import { isAccessDeniedError, isAuthCredentialInvalidError, isNotFoundError, isTransientError } from '../utils/alicloud-error';
import { AUTH_CAPABILITY_LABELS, type AuthCapability } from '../utils/auth-recovery';
import type { AuthConfig, ProjectConfig } from '../utils/config';
import { parseRootAndSubdomain } from '../utils/domain';
import {
  buildDoctorNextActions,
  doctorNextCommand,
  doctorNextCommands,
  doctorRemediationCommand,
  doctorRemediationNote,
  type LicellDoctorNextCommand,
  type LicellDoctorRemediation,
  normalizeDoctorNextCommands,
  normalizeDoctorRemediationItems
} from '../utils/doctor-guidance';
import { cloneResolvedCommandNextActions, type ResolvedCommandNextAction } from '../utils/command-next-actions';
import { formatErrorMessage } from '../utils/errors';
import { resolveSdkCtor } from '../utils/sdk';

const OpenApiCtor = resolveSdkCtor<$OpenApi.default>($OpenApi.default, '@alicloud/openapi-client');
const VpcClientCtor = resolveSdkCtor<Vpc>(Vpc, '@alicloud/vpc20160428');
const CrClientCtor = resolveSdkCtor<CR>(CR, '@alicloud/cr20181201');
const SlsClientCtor = resolveSdkCtor<SLS>(SLS, '@alicloud/sls20201230');

const CLOUD_PROBE_TIMEOUT_MS = 8_000;
const DOCTOR_CAPABILITY_ORDER: readonly AuthCapability[] = ['fc', 'oss', 'dns', 'cdn', 'vpc', 'ecs', 'cr', 'rds', 'redis', 'rdsai', 'logs'];

export interface DoctorCloudCheckResult {
  status: 'ok' | 'warn' | 'error' | 'skip';
  summary: string;
  details: string[];
  remediation: LicellDoctorRemediation[];
  nextCommands?: LicellDoctorNextCommand[];
  nextActions?: ResolvedCommandNextAction[];
  data?: Record<string, unknown>;
}

export interface DoctorCloudCapabilityProbe {
  capability: AuthCapability;
  label: string;
  required: boolean;
  status: 'ok' | 'warn' | 'error';
  summary: string;
  details: string[];
  data?: Record<string, unknown>;
}

export interface DoctorCloudCapabilityPlan {
  required: AuthCapability[];
  optional: AuthCapability[];
}

export interface DoctorCloudDiagnostics {
  identity: DoctorCloudCheckResult;
  ramProfile: DoctorCloudCheckResult;
  deployTarget: DoctorCloudCheckResult;
  domainConsistency: DoctorCloudCheckResult;
  capabilities: DoctorCloudCheckResult & {
    data: {
      required: AuthCapability[];
      optional: AuthCapability[];
      probes: DoctorCloudCapabilityProbe[];
    };
  };
}

interface DoctorCloudDiagnosticsInput {
  auth: AuthConfig;
  project?: ProjectConfig | null;
  deployTypeHint?: 'api' | 'static' | 'task';
  runtime?: string | null;
}

export interface DoctorDeployTargetPlan {
  mode: 'api' | 'static' | 'task' | 'skip';
  reason: 'missing_project' | 'missing_app_name' | 'unknown_deploy_type' | 'api' | 'static' | 'task';
}

interface DoctorDomainInspection {
  domainName: string;
  status: 'ok' | 'warn' | 'error';
  summary: string;
  details: string[];
  remediation: LicellDoctorRemediation[];
  data?: Record<string, unknown>;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function normalizeDoctorCloudCheckResult<T extends DoctorCloudCheckResult>(input: T): T {
  const nextCommands = normalizeDoctorNextCommands(input.nextCommands || []);
  return {
    ...input,
    details: [...input.details],
    remediation: normalizeDoctorRemediationItems(input.remediation),
    nextCommands,
    nextActions: input.nextActions
      ? cloneResolvedCommandNextActions(input.nextActions)
      : buildDoctorNextActions(nextCommands),
    ...(input.data ? { data: { ...input.data } } : {})
  };
}

function toOptionalString(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeErrorText(err: unknown) {
  return formatErrorMessage(err).toLowerCase();
}

function normalizeRegionName(value: string | undefined) {
  return (value || '').trim().toLowerCase().replace(/^oss-/, '') || undefined;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function isUnsupportedRegionError(err: unknown) {
  const text = normalizeErrorText(err);
  return text.includes('invalidregion')
    || text.includes('regionid')
    || text.includes('unsupported')
    || text.includes('not support')
    || text.includes('not open')
    || text.includes('service not available')
    || text.includes('not activated');
}

function isLogsBootstrapMissingError(err: unknown) {
  const text = normalizeErrorText(err);
  return text.includes('projectnotexist') || text.includes('logstorenotexist');
}

function isHealthyFcFunctionState(value: string | undefined) {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '' || normalized === 'active' || normalized === 'running';
}

function resolveExpectedFcRuntime(runtime: string | null | undefined) {
  switch ((runtime || '').trim().toLowerCase()) {
    case 'nodejs20':
      return 'nodejs20';
    case 'nodejs22':
    case 'python3.13':
      return 'custom.debian12';
    case 'python3.12':
      return 'python3.12';
    case 'docker':
      return 'custom-container';
    default:
      return undefined;
  }
}

function resolveExpectedCustomRuntimeSignature(runtime: string | null | undefined) {
  switch ((runtime || '').trim().toLowerCase()) {
    case 'nodejs22':
      return {
        command: ['/bin/sh'],
        args: ['/code/.licell/node22-launcher.sh']
      };
    case 'python3.13':
      return {
        command: ['/bin/sh'],
        args: ['/code/.licell/python313-launcher.sh']
      };
    default:
      return undefined;
  }
}

function matchesCustomRuntimeSignature(
  observed: { command?: unknown; args?: unknown } | null | undefined,
  expected: { command: string[]; args: string[] } | undefined
) {
  if (!expected) return true;
  const command = normalizeStringArray(observed?.command);
  const args = normalizeStringArray(observed?.args);
  return JSON.stringify(command) === JSON.stringify(expected.command)
    && JSON.stringify(args) === JSON.stringify(expected.args);
}

function withTimeout<T>(task: Promise<T>, label: string, timeoutMs = CLOUD_PROBE_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    task,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(`${label} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
    })
  ]);
}

function buildRpcClient(auth: AuthConfig, endpoint: string) {
  return new OpenApiCtor(new $OpenApi.Config({
    accessKeyId: auth.ak,
    accessKeySecret: auth.sk,
    regionId: auth.region,
    endpoint
  }));
}

async function callRpc(
  auth: AuthConfig,
  endpoint: string,
  action: string,
  version: string,
  query: Record<string, unknown> = {}
) {
  const client = buildRpcClient(auth, endpoint);
  const params = new $OpenApi.Params({
    action,
    version,
    protocol: 'HTTPS',
    pathname: '/',
    method: 'POST',
    authType: 'AK',
    style: 'RPC',
    reqBodyType: 'formData',
    bodyType: 'json'
  });
  const request = new $OpenApi.OpenApiRequest({
    query: Object.fromEntries(
      Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)])
    )
  });
  return client.callApi(params, request, new $Util.RuntimeOptions({ readTimeout: 8_000, connectTimeout: 5_000 })) as Promise<{
    body?: Record<string, unknown>;
  }>;
}

function classifyCloudError(
  err: unknown,
  input: {
    label: string;
    required: boolean;
    accessDeniedSummary?: string;
    invalidCredentialSummary?: string;
    unsupportedSummary?: string;
  }
): Omit<DoctorCloudCheckResult, 'status'> & { status: 'ok' | 'warn' | 'error' } {
  if (isAuthCredentialInvalidError(err)) {
    return {
      status: 'error',
      summary: input.invalidCredentialSummary || `${input.label} 校验失败：AK/SK 无效或已失效。`,
      details: [formatErrorMessage(err)],
      remediation: [doctorRemediationNote('执行 login 重新登录，或执行 auth restore 恢复有效凭证。')],
      nextCommands: doctorNextCommands('licell login', 'licell auth restore <token> [passkey]')
    };
  }
  if (isAccessDeniedError(err)) {
    return {
      status: input.required ? 'error' : 'warn',
      summary: input.accessDeniedSummary || `${input.label} 读权限不足。`,
      details: [formatErrorMessage(err)],
      remediation: [doctorRemediationCommand('licell auth repair', {
        text: '执行 auth repair，为当前凭证补齐 licell 所需权限。'
      })],
      nextCommands: doctorNextCommands('licell auth repair')
    };
  }
  if (isUnsupportedRegionError(err)) {
    return {
      status: input.required ? 'error' : 'warn',
      summary: input.unsupportedSummary || `${input.label} 在当前 region 可能不可用或未开通。`,
      details: [formatErrorMessage(err)],
      remediation: [doctorRemediationNote('切换到支持该服务的 region，或避免在当前工作流使用该服务。', {
        commandTemplate: 'licell switch --region <region>',
        intent: 'configure'
      })],
      nextCommands: doctorNextCommands('licell switch --region <region>', 'licell doctor')
    };
  }
  if (isTransientError(err)) {
    return {
      status: 'warn',
      summary: `${input.label} 探测失败：网络或服务暂时不可用。`,
      details: [formatErrorMessage(err)],
      remediation: [doctorRemediationNote('稍后重试 doctor，确认网络和阿里云控制面状态。', {
        commandTemplate: 'licell doctor',
        intent: 'verify'
      })],
      nextCommands: doctorNextCommands('licell doctor')
    };
  }
  return {
    status: input.required ? 'error' : 'warn',
    summary: `${input.label} 探测失败。`,
    details: [formatErrorMessage(err)],
    remediation: [doctorRemediationNote('检查错误详情，必要时修复权限，或切换 region 后重试。', {
      commandTemplate: 'licell auth repair',
      intent: 'repair'
    })],
    nextCommands: doctorNextCommands('licell auth repair', 'licell doctor')
  };
}

async function probeCallerIdentity(auth: AuthConfig): Promise<DoctorCloudCheckResult> {
  try {
    const response = await withTimeout(
      callRpc(auth, 'sts.aliyuncs.com', 'GetCallerIdentity', '2015-04-01'),
      '云端身份校验'
    );
    const body = response.body || {};
    const accountId = toOptionalString(body.AccountId) || toOptionalString(body.accountId);
    const arn = toOptionalString(body.Arn) || toOptionalString(body.arn);
    const userId = toOptionalString(body.UserId) || toOptionalString(body.userId);

    if (accountId && auth.accountId && accountId !== auth.accountId) {
      return {
        status: 'error',
        summary: '云端身份与本地 auth.json 的 accountId 不一致。',
        details: [`local accountId: ${auth.accountId}`, `remote accountId: ${accountId}`, ...(arn ? [`arn: ${arn}`] : []), ...(userId ? [`userId: ${userId}`] : [])],
        remediation: [doctorRemediationNote('确认当前 AK/SK 属于预期账号，必要时重新执行 login。', {
          commandTemplate: 'licell login',
          intent: 'login'
        })],
        nextCommands: doctorNextCommands('licell login', 'licell whoami'),
        data: { accountId, arn, userId }
      };
    }

    return {
      status: 'ok',
      summary: '云端身份校验通过。',
      details: [
        ...(accountId ? [`accountId: ${accountId}`] : []),
        ...(arn ? [`arn: ${arn}`] : []),
        ...(userId ? [`userId: ${userId}`] : [])
      ],
      remediation: [],
      data: { accountId: accountId || auth.accountId, arn, userId }
    };
  } catch (err: unknown) {
    return classifyCloudError(err, {
      label: '云端身份校验',
      required: true
    });
  }
}

async function probeRamProfile(auth: AuthConfig): Promise<DoctorCloudCheckResult> {
  if (auth.authSource !== 'bootstrap' && !auth.ramUser && !auth.ramPolicy) {
    return {
      status: 'warn',
      summary: '当前凭证为手动登录态，无法确认是否符合 licell 推荐的最小权限模型。',
      details: ['authSource: manual/unknown'],
      remediation: [doctorRemediationCommand('licell auth repair', {
        text: '建议执行 auth repair，为当前账号补齐 licell 推荐的 bootstrap RAM 配置。'
      })],
      nextCommands: doctorNextCommands('licell auth repair')
    };
  }

  if (!auth.ramUser || !auth.ramPolicy) {
    return {
      status: 'warn',
      summary: '当前凭证带有 bootstrap 痕迹，但本地缺少完整的 RAM 用户 / 策略元数据。',
      details: [`ramUser: ${auth.ramUser || '(missing)'}`, `ramPolicy: ${auth.ramPolicy || '(missing)'}`],
      remediation: [doctorRemediationCommand('licell auth repair', {
        text: '执行 auth repair，回填或修复 bootstrap 元数据。'
      })],
      nextCommands: doctorNextCommands('licell auth repair')
    };
  }

  try {
    const inspection = await withTimeout(
      inspectLicellRamAccess(auth, {
        userName: auth.ramUser,
        policyName: auth.ramPolicy,
        accessKeyId: auth.ak
      }),
      'RAM 权限校验'
    );

    const details = [
      `ramUser: ${inspection.userName}`,
      `ramPolicy: ${inspection.policyName}`,
      `currentAccessKeyBound: ${inspection.currentAccessKeyBound ? 'yes' : 'no'}`,
      ...(inspection.currentAccessKeyStatus ? [`currentAccessKeyStatus: ${inspection.currentAccessKeyStatus}`] : [])
    ];

    if (!inspection.userExists || !inspection.policyExists || !inspection.currentAccessKeyBound || inspection.missingActions.length > 0) {
      if (!inspection.userExists) details.push('missing: RAM user does not exist');
      if (!inspection.policyExists) details.push('missing: RAM policy does not exist');
      if (inspection.missingActions.length > 0) {
        details.push(`missingActions: ${inspection.missingActions.slice(0, 8).join(', ')}${inspection.missingActions.length > 8 ? ' ...' : ''}`);
      }

      return {
        status: 'error',
        summary: 'bootstrap RAM 配置不完整，当前凭证不是完全健康的 licell 最小权限状态。',
        details,
        remediation: [doctorRemediationCommand('licell auth repair', {
          text: '执行 auth repair，自动补齐 RAM 用户、策略和当前 key 的绑定关系。'
        })],
        nextCommands: doctorNextCommands('licell auth repair'),
        data: {
          userExists: inspection.userExists,
          policyExists: inspection.policyExists,
          currentAccessKeyBound: inspection.currentAccessKeyBound,
          currentAccessKeyStatus: inspection.currentAccessKeyStatus,
          missingActions: inspection.missingActions
        }
      };
    }

    return {
      status: 'ok',
      summary: 'bootstrap RAM 配置校验通过。',
      details,
      remediation: [],
      data: {
        currentAccessKeyBound: inspection.currentAccessKeyBound,
        currentAccessKeyStatus: inspection.currentAccessKeyStatus
      }
    };
  } catch (err: unknown) {
    return classifyCloudError(err, {
      label: 'RAM 权限校验',
      required: true,
      accessDeniedSummary: '当前凭证无法读取自身 RAM 配置；通常说明 bootstrap policy 版本过旧或权限缺失。'
    });
  }
}

export function resolveDoctorCapabilityPlan(input: {
  project?: ProjectConfig | null;
  deployTypeHint?: 'api' | 'static' | 'task';
  runtime?: string | null;
}): DoctorCloudCapabilityPlan {
  const required = new Set<AuthCapability>();
  const runtime = (input.runtime || '').trim().toLowerCase();
  const hasProject = Boolean(input.project);

  if (input.deployTypeHint === 'static') {
    required.add('oss');
  } else if (hasProject || runtime) {
    required.add('fc');
  }

  if (runtime === 'docker') {
    required.add('cr');
  }

  if (input.project?.network) {
    required.add('vpc');
  }

  const all = [...DOCTOR_CAPABILITY_ORDER];
  const optional = all.filter((capability) => !required.has(capability));
  return {
    required: all.filter((capability) => required.has(capability)),
    optional
  };
}

export function resolveDoctorDeployTargetPlan(input: {
  project?: ProjectConfig | null;
  deployTypeHint?: 'api' | 'static' | 'task';
  runtime?: string | null;
}): DoctorDeployTargetPlan {
  if (!input.project) return { mode: 'skip', reason: 'missing_project' };
  if (!toOptionalString(input.project.appName)) return { mode: 'skip', reason: 'missing_app_name' };
  if (input.deployTypeHint === 'static') return { mode: 'static', reason: 'static' };
  if (input.deployTypeHint === 'task') return { mode: 'task', reason: 'task' };
  if (input.deployTypeHint === 'api' || input.runtime) return { mode: 'api', reason: 'api' };
  return { mode: 'skip', reason: 'unknown_deploy_type' };
}

function summarizeDoctorDomainInspections(
  mode: 'api' | 'static',
  inspections: DoctorDomainInspection[],
  emptySummary: string
): DoctorCloudCheckResult {
  if (inspections.length === 0) {
    return {
      status: 'skip',
      summary: emptySummary,
      details: [],
      remediation: [],
      data: {
        mode,
        domainCount: 0,
        domains: []
      }
    };
  }

  const errorCount = inspections.filter((item) => item.status === 'error').length;
  const warnCount = inspections.filter((item) => item.status === 'warn').length;
  const details = inspections.flatMap((item) => [
    `[${item.status}] ${item.domainName}: ${item.summary}`,
    ...item.details.map((detail) => `  ${detail}`)
  ]);
  const remediation = normalizeDoctorRemediationItems(inspections.flatMap((item) => item.remediation));

  if (errorCount > 0) {
    return {
      status: 'error',
      summary: `${mode === 'api' ? 'API' : 'Static'} 域名入口存在 ${errorCount} 个阻塞项。`,
      details,
      remediation,
      nextCommands: mode === 'api'
        ? doctorNextCommands('licell domain app bind <domain>', 'licell doctor')
        : doctorNextCommands('licell domain static bind <domain>', 'licell doctor'),
      data: {
        mode,
        domainCount: inspections.length,
        domains: inspections.map((item) => ({ domainName: item.domainName, status: item.status, ...(item.data ? { data: item.data } : {}) }))
      }
    };
  }

  if (warnCount > 0) {
    return {
      status: 'warn',
      summary: `${mode === 'api' ? 'API' : 'Static'} 域名入口已发现，但还有 ${warnCount} 个待收敛项。`,
      details,
      remediation,
      nextCommands: mode === 'api'
        ? doctorNextCommands('licell domain app bind <domain>', 'licell doctor')
        : doctorNextCommands('licell domain static bind <domain>', 'licell doctor'),
      data: {
        mode,
        domainCount: inspections.length,
        domains: inspections.map((item) => ({ domainName: item.domainName, status: item.status, ...(item.data ? { data: item.data } : {}) }))
      }
    };
  }

  return {
    status: 'ok',
    summary: `${mode === 'api' ? 'API' : 'Static'} 域名入口一致性通过。`,
    details,
    remediation: [],
    data: {
      mode,
      domainCount: inspections.length,
      domains: inspections.map((item) => ({ domainName: item.domainName, status: item.status, ...(item.data ? { data: item.data } : {}) }))
    }
  };
}

function findExactCnameValue(domainName: string, records: Awaited<ReturnType<typeof listDnsRecords>>) {
  const { subDomain } = parseRootAndSubdomain(domainName);
  const normalizedSubDomain = (subDomain || '@').toLowerCase();
  const match = records.find((record) => record.type.toUpperCase() === 'CNAME' && (record.rr || '@').toLowerCase() === normalizedSubDomain);
  return match ? normalizeDnsValue(match.value) : undefined;
}

async function inspectDomainDnsConsistency(domainName: string, expectedTarget: string): Promise<DoctorDomainInspection> {
  const normalizedDomain = domainName.trim().toLowerCase();
  const normalizedTarget = normalizeDnsValue(expectedTarget);
  const details: string[] = [`expectedTarget: ${normalizedTarget}`];
  const remediation: LicellDoctorRemediation[] = [];
  let controlPlaneValue: string | undefined;
  let controlPlaneError: string | undefined;

  try {
    const { rootDomain } = parseRootAndSubdomain(normalizedDomain);
    const records = await withTimeout(listDnsRecords(rootDomain, 200), `DNS control-plane ${normalizedDomain}`);
    controlPlaneValue = findExactCnameValue(normalizedDomain, records);
    details.push(`controlPlaneCname: ${controlPlaneValue || '(not found in current account)'}`);
  } catch (err: unknown) {
    controlPlaneError = formatErrorMessage(err);
    details.push(`controlPlaneRead: ${controlPlaneError}`);
  }

  const snapshot = await withTimeout(resolveAuthoritativeDnsSnapshot(normalizedDomain), `Authoritative DNS ${normalizedDomain}`);
  details.push(`authoritativeCname: ${snapshot.cname.join(', ') || '(none)'}`);
  if (snapshot.addresses.length > 0) {
    details.push(`authoritativeAddresses: ${snapshot.addresses.join(', ')}`);
  }

  if (snapshot.cname.includes(normalizedTarget)) {
    return {
      domainName: normalizedDomain,
      status: controlPlaneError ? 'warn' : 'ok',
      summary: controlPlaneError
        ? '权威 DNS 已指向预期目标，但当前账号无法读取该域名控制面记录。'
        : 'DNS 指向符合预期。',
      details,
      remediation: controlPlaneError
        ? [doctorRemediationNote('如需让 licell 统一校验/修复 DNS，请确保该域名由当前账号的阿里云 DNS 托管。')]
        : [],
      data: {
        expectedTarget: normalizedTarget,
        controlPlaneValue: controlPlaneValue || null,
        authoritativeCname: snapshot.cname
      }
    };
  }

  if (controlPlaneValue === normalizedTarget) {
    remediation.push(doctorRemediationNote(
      '等待 DNS 生效后重试；必要时检查权威 NS 是否已切到阿里云。',
      { commandTemplate: `licell dns records list ${parseRootAndSubdomain(normalizedDomain).rootDomain}` }
    ));
    return {
      domainName: normalizedDomain,
      status: 'warn',
      summary: 'DNS 控制面记录正确，但权威解析尚未收敛到预期目标。',
      details,
      remediation,
      data: {
        expectedTarget: normalizedTarget,
        controlPlaneValue,
        authoritativeCname: snapshot.cname
      }
    };
  }

  remediation.push(doctorRemediationNote(
    `把域名 CNAME 收敛到 ${normalizedTarget}，然后再执行 doctor 复查。`,
    { commandTemplate: 'licell doctor', intent: 'verify' }
  ));
  return {
    domainName: normalizedDomain,
    status: 'error',
    summary: '权威 DNS 没有指向当前项目期望的目标。',
    details,
    remediation,
    data: {
      expectedTarget: normalizedTarget,
      controlPlaneValue: controlPlaneValue || null,
      authoritativeCname: snapshot.cname
    }
  };
}

async function inspectApiDomainConsistency(
  domain: FnCustomDomainState,
  input: DoctorCloudDiagnosticsInput & { project: ProjectConfig },
  aliasNames: Set<string>,
  versionIds: Set<string>,
  gatewayDomain: string
): Promise<DoctorDomainInspection> {
  const functionName = toOptionalString(input.project.appName)!;
  const details = [
    `protocol: ${domain.protocol || 'HTTP'}`,
    `routes: ${domain.routes.length}`
  ];
  const remediation: LicellDoctorRemediation[] = [];
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const primaryRoute = domain.routes[0];

  if (!primaryRoute) {
    blockingIssues.push('FC custom domain 没有任何 route。');
  } else {
    details.push(`route: ${primaryRoute.path} -> ${primaryRoute.functionName || '(missing)'}${primaryRoute.qualifier ? `@${primaryRoute.qualifier}` : ''}`);
    if ((primaryRoute.functionName || '').trim() !== functionName) {
      blockingIssues.push(`route function drift: expected ${functionName}, got ${primaryRoute.functionName || '(missing)'}`);
    }
    const qualifier = toOptionalString(primaryRoute.qualifier);
    if (qualifier) {
      if (/^\d+$/.test(qualifier)) {
        if (!versionIds.has(qualifier)) {
          blockingIssues.push(`route qualifier points to missing version: ${qualifier}`);
        }
      } else if (!aliasNames.has(qualifier)) {
        blockingIssues.push(`route qualifier points to missing alias: ${qualifier}`);
      }
    }
  }

  if (domain.protocol?.includes('HTTPS') && !domain.certConfig?.certName && !domain.certConfig?.certificate) {
    warnings.push('FC custom domain 声明了 HTTPS，但没有检测到 certConfig。');
  }

  let expectedTarget = gatewayDomain;
  try {
    const cdn = await withTimeout(getCdnDomainDetail(domain.domainName), `CDN detail ${domain.domainName}`);
    if (cdn) {
      details.push(`cdnStatus: ${cdn.status || '(unknown)'}`);
      details.push(`cdnCname: ${cdn.cname || '(missing)'}`);
      if (cdn.cname) expectedTarget = cdn.cname;
      if (cdn.status && cdn.status !== 'online') {
        warnings.push(`CDN domain status=${cdn.status}`);
      }
      if (cdn.origins && cdn.origins.length > 0) {
        details.push(...cdn.origins.map((origin) => `cdnOrigin: ${origin.content}${origin.type ? ` (${origin.type})` : ''}`));
        if (!cdn.origins.some((origin) => normalizeDnsValue(origin.content) === normalizeDnsValue(gatewayDomain))) {
          warnings.push(`CDN 回源未指向预期 FC gateway: ${gatewayDomain}`);
        }
      }
    } else {
      details.push('cdn: (not configured)');
    }
  } catch (err: unknown) {
    warnings.push(`CDN detail unreadable: ${formatErrorMessage(err)}`);
  }

  const dnsInspection = await inspectDomainDnsConsistency(domain.domainName, expectedTarget);
  details.push(...dnsInspection.details);
  remediation.push(...dnsInspection.remediation);
  if (dnsInspection.status === 'error') {
    blockingIssues.push('DNS target mismatch');
  } else if (dnsInspection.status === 'warn') {
    warnings.push(dnsInspection.summary);
  }

  if (blockingIssues.length > 0) {
    remediation.push(doctorRemediationCommand(
      'licell domain app bind <domain>',
      { text: '必要时重新执行 domain app bind，重新编排 DNS、FC custom domain、alias 与 SSL。' }
    ));
    return {
      domainName: domain.domainName,
      status: 'error',
      summary: blockingIssues.join('；'),
      details,
      remediation: normalizeDoctorRemediationItems(remediation),
      data: {
        expectedTarget
      }
    };
  }

  if (warnings.length > 0) {
    return {
      domainName: domain.domainName,
      status: 'warn',
      summary: warnings.join('；'),
      details,
      remediation: normalizeDoctorRemediationItems(remediation),
      data: {
        expectedTarget
      }
    };
  }

  return {
    domainName: domain.domainName,
    status: 'ok',
    summary: '域名入口、路由与 DNS 一致。',
    details,
    remediation: [],
    data: {
      expectedTarget
    }
  };
}

async function probeApiDomainConsistency(input: DoctorCloudDiagnosticsInput & { project: ProjectConfig }): Promise<DoctorCloudCheckResult> {
  const functionName = toOptionalString(input.project.appName)!;
  const domains = await withTimeout(listFnCustomDomains(2000, { functionName }), 'API domain list');
  if (domains.length === 0) {
    return summarizeDoctorDomainInspections('api', [], '当前项目未发现 FC custom domain，跳过 API 域名一致性检查。');
  }

  const gatewayDomain = resolveDefaultFcGatewayDomain();
  const [aliases, versions] = await Promise.all([
    withTimeout(listFunctionAliases(functionName, 200), 'API domain alias list'),
    withTimeout(listFunctionVersions(functionName, 200), 'API domain version list')
  ]);
  const aliasNames = new Set(
    aliases
      .map((alias) => toOptionalString(alias.aliasName))
      .filter((item): item is string => Boolean(item))
  );
  const versionIds = new Set(
    versions
      .map((version) => toOptionalString(version.versionId))
      .filter((item): item is string => Boolean(item))
  );

  const inspections = await Promise.all(
    domains.map((domain) => inspectApiDomainConsistency(domain, input, aliasNames, versionIds, gatewayDomain))
  );
  return summarizeDoctorDomainInspections('api', inspections, '当前项目未发现 FC custom domain，跳过 API 域名一致性检查。');
}

async function inspectStaticBucketDomainConsistency(domainName: string, expectedTarget: string): Promise<DoctorDomainInspection> {
  const dnsInspection = await inspectDomainDnsConsistency(domainName, expectedTarget);
  return {
    domainName,
    status: dnsInspection.status,
    summary: dnsInspection.summary,
    details: dnsInspection.details,
    remediation: dnsInspection.remediation,
    ...(dnsInspection.data ? { data: dnsInspection.data } : {})
  };
}

async function inspectStaticCdnDomainConsistency(domain: CdnDomainDetail, expectedOriginDomain: string): Promise<DoctorDomainInspection> {
  const details = [
    `cdnStatus: ${domain.status || '(unknown)'}`,
    `cdnCname: ${domain.cname || '(missing)'}`
  ];
  if (domain.origins && domain.origins.length > 0) {
    details.push(...domain.origins.map((origin) => `cdnOrigin: ${origin.content}${origin.type ? ` (${origin.type})` : ''}`));
  }
  const remediation: LicellDoctorRemediation[] = [];
  const blockingIssues: string[] = [];
  const warnings: string[] = [];

  if (!domain.cname) {
    blockingIssues.push('CDN domain 没有返回 cname。');
  }
  if (domain.status && domain.status !== 'online') {
    warnings.push(`CDN domain status=${domain.status}`);
  }
  if (domain.origins && domain.origins.length > 0 && !domain.origins.some((origin) => normalizeDnsValue(origin.content) === normalizeDnsValue(expectedOriginDomain))) {
    warnings.push(`CDN 回源未指向预期 OSS origin: ${expectedOriginDomain}`);
  }

  const expectedTarget = domain.cname || expectedOriginDomain;
  const dnsInspection = await inspectDomainDnsConsistency(domain.domainName, expectedTarget);
  details.push(...dnsInspection.details);
  remediation.push(...dnsInspection.remediation);
  if (dnsInspection.status === 'error') {
    blockingIssues.push('DNS target mismatch');
  } else if (dnsInspection.status === 'warn') {
    warnings.push(dnsInspection.summary);
  }

  if (blockingIssues.length > 0) {
    remediation.push(doctorRemediationCommand(
      'licell domain static bind <domain>',
      { text: '必要时重新执行 domain static bind，重新编排 CDN / DNS / HTTPS。' }
    ));
    return {
      domainName: domain.domainName,
      status: 'error',
      summary: blockingIssues.join('；'),
      details,
      remediation: normalizeDoctorRemediationItems(remediation),
      data: {
        expectedTarget,
        expectedOriginDomain
      }
    };
  }

  if (warnings.length > 0) {
    return {
      domainName: domain.domainName,
      status: 'warn',
      summary: warnings.join('；'),
      details,
      remediation: normalizeDoctorRemediationItems(remediation),
      data: {
        expectedTarget,
        expectedOriginDomain
      }
    };
  }

  return {
    domainName: domain.domainName,
    status: 'ok',
    summary: '静态域名入口与 CDN/DNS 一致。',
    details,
    remediation: [],
    data: {
      expectedTarget,
      expectedOriginDomain
    }
  };
}

async function probeStaticDomainConsistency(input: DoctorCloudDiagnosticsInput & { project: ProjectConfig }): Promise<DoctorCloudCheckResult> {
  const appName = toOptionalString(input.project.appName)!;
  const bucketName = resolveOssBucketName(appName);
  const bucketInfo = await withTimeout(getOssBucketInfo(bucketName), 'Static domain bucket info');
  const originDomain = resolveOssBucketOriginDomain(bucketName, bucketInfo.extranetEndpoint);
  const bucketDomains = bucketInfo.domains || [];
  let cdnDomains: CdnDomainDetail[] = [];
  let cdnListWarning: string | undefined;

  try {
    const discoveredCdnDomains = await withTimeout(
      listCdnDomains(2000, { source: originDomain }),
      'Static CDN domain list'
    );
    cdnDomains = discoveredCdnDomains.filter((domain) =>
      domain.origins?.some((origin) => normalizeDnsValue(origin.content) === normalizeDnsValue(originDomain))
    );
  } catch (err: unknown) {
    cdnListWarning = formatErrorMessage(err);
  }

  const inspections: DoctorDomainInspection[] = [];
  for (const bucketDomain of bucketDomains) {
    inspections.push(await inspectStaticBucketDomainConsistency(bucketDomain.domain, originDomain));
  }
  for (const cdnDomain of cdnDomains) {
    inspections.push(await inspectStaticCdnDomainConsistency(cdnDomain, originDomain));
  }

  const summary = summarizeDoctorDomainInspections('static', inspections, '当前项目未发现 OSS 原生域名或 CDN 静态域名，跳过 Static 域名一致性检查。');
  if (cdnListWarning && summary.status === 'skip') {
    return {
      status: 'warn',
      summary: '未发现可关联的静态域名，且无法枚举 CDN domain。',
      details: [`cdnList: ${cdnListWarning}`, `expectedOriginDomain: ${originDomain}`],
      remediation: [doctorRemediationNote('确认当前凭证具备 CDN 读权限，或确保静态域名由 licell 当前账号统一管理。')],
      data: {
        mode: 'static',
        bucketName,
        expectedOriginDomain: originDomain
      }
    };
  }
  if (cdnListWarning) {
    return {
      ...summary,
      status: summary.status === 'error' ? 'error' : 'warn',
      details: [...summary.details, `[warn] cdn-list: ${cdnListWarning}`],
      remediation: normalizeDoctorRemediationItems([
        ...summary.remediation,
        doctorRemediationNote('确认当前凭证具备 CDN 读权限，避免 doctor 漏掉静态 CDN 域名。')
      ])
    };
  }
  return summary;
}

export async function probeDoctorDomainConsistency(input: DoctorCloudDiagnosticsInput): Promise<DoctorCloudCheckResult> {
  const plan = resolveDoctorDeployTargetPlan(input);
  if (plan.mode === 'skip') {
    if (plan.reason === 'missing_project') {
      return normalizeDoctorCloudCheckResult({
        status: 'skip',
        summary: '当前目录不是 licell 项目，跳过域名一致性检查。',
        details: [],
        remediation: []
      });
    }

    if (plan.reason === 'missing_app_name') {
      return normalizeDoctorCloudCheckResult({
        status: 'skip',
        summary: '项目未配置 appName，跳过域名一致性检查。',
        details: [],
        remediation: [doctorRemediationNote('为项目补齐 appName 后再执行 doctor。', {
          commandTemplate: 'licell doctor',
          intent: 'verify'
        })],
        nextCommands: doctorNextCommands('licell init --app my-app', 'licell doctor')
      });
    }

    return normalizeDoctorCloudCheckResult({
      status: 'skip',
      summary: '当前项目未显式声明 deploy type/runtime，跳过域名一致性检查。',
      details: [],
      remediation: [doctorRemediationNote('为项目写入 runtime，或显式传入 runtime 后再执行 doctor。', {
        commandTemplate: 'licell doctor --runtime <runtime>',
        intent: 'verify'
      })],
      nextCommands: doctorNextCommands('licell init --runtime nodejs22', 'licell doctor --runtime <runtime>')
    });
  }

  if (!input.project) {
    return normalizeDoctorCloudCheckResult({
      status: 'skip',
      summary: '当前目录不是 licell 项目，跳过域名一致性检查。',
      details: [],
      remediation: []
    });
  }

  if (plan.mode === 'task') {
    return normalizeDoctorCloudCheckResult({
      status: 'skip',
      summary: '当前项目是任务函数；不涉及固定域名编排，跳过域名一致性检查。',
      details: [],
      remediation: [],
      data: {
        mode: 'task'
      }
    });
  }

  try {
    return normalizeDoctorCloudCheckResult(plan.mode === 'api'
      ? await probeApiDomainConsistency({ ...input, project: input.project })
      : await probeStaticDomainConsistency({ ...input, project: input.project }));
  } catch (err: unknown) {
    return normalizeDoctorCloudCheckResult(classifyCloudError(err, {
      label: 'Domain consistency',
      required: false,
      accessDeniedSummary: '无法完整读取当前项目关联的域名 / DNS / CDN 状态。'
    }));
  }
}

async function probeFcCapability(): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(listFunctions(1), 'FC capability');
  return {
    capability: 'fc',
    label: AUTH_CAPABILITY_LABELS.fc,
    required: false,
    status: 'ok',
    summary: 'FC 读权限与 region endpoint 可用。',
    details: ['probe: ListFunctions(limit=1)']
  };
}

async function probeOssCapability(): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(listOssBuckets(1), 'OSS capability');
  return {
    capability: 'oss',
    label: AUTH_CAPABILITY_LABELS.oss,
    required: false,
    status: 'ok',
    summary: 'OSS 读权限与 region endpoint 可用。',
    details: ['probe: ListBuckets(max=1)']
  };
}

async function probeDnsCapability(auth: AuthConfig): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(callRpc(auth, 'alidns.aliyuncs.com', 'DescribeDomains', '2015-01-09', {
    PageNumber: 1,
    PageSize: 1
  }), 'DNS capability');
  return {
    capability: 'dns',
    label: AUTH_CAPABILITY_LABELS.dns,
    required: false,
    status: 'ok',
    summary: 'DNS 读权限可用。',
    details: ['probe: DescribeDomains(pageSize=1)']
  };
}

async function probeCdnCapability(auth: AuthConfig): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(callRpc(auth, 'cdn.aliyuncs.com', 'DescribeUserDomains', '2018-05-10', {
    PageNumber: 1,
    PageSize: 1
  }), 'CDN capability');
  return {
    capability: 'cdn',
    label: AUTH_CAPABILITY_LABELS.cdn,
    required: false,
    status: 'ok',
    summary: 'CDN 读权限可用。',
    details: ['probe: DescribeUserDomains(pageSize=1)']
  };
}

async function probeVpcCapability(auth: AuthConfig): Promise<DoctorCloudCapabilityProbe> {
  const client = new VpcClientCtor(new $OpenApi.Config({
    accessKeyId: auth.ak,
    accessKeySecret: auth.sk,
    regionId: auth.region,
    endpoint: `vpc.${auth.region}.aliyuncs.com`
  }));
  await withTimeout(
    client.describeVpcs(new $Vpc.DescribeVpcsRequest({ regionId: auth.region, pageNumber: 1, pageSize: 1 })),
    'VPC capability'
  );
  return {
    capability: 'vpc',
    label: AUTH_CAPABILITY_LABELS.vpc,
    required: false,
    status: 'ok',
    summary: 'VPC 读权限与 region endpoint 可用。',
    details: ['probe: DescribeVpcs(pageSize=1)']
  };
}

async function probeCrCapability(auth: AuthConfig): Promise<DoctorCloudCapabilityProbe> {
  const client = new CrClientCtor(new $OpenApi.Config({
    accessKeyId: auth.ak,
    accessKeySecret: auth.sk,
    regionId: auth.region,
    endpoint: `cr.${auth.region}.aliyuncs.com`
  }));
  await withTimeout(client.listInstance(new $CR.ListInstanceRequest({ pageNo: 1, pageSize: 1 })), 'CR capability');
  return {
    capability: 'cr',
    label: AUTH_CAPABILITY_LABELS.cr,
    required: false,
    status: 'ok',
    summary: 'CR 读权限与 region endpoint 可用。',
    details: ['probe: ListInstance(pageSize=1)']
  };
}

async function probeRdsCapability(): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(listDatabaseInstances(1), 'RDS capability');
  return {
    capability: 'rds',
    label: AUTH_CAPABILITY_LABELS.rds,
    required: false,
    status: 'ok',
    summary: 'RDS 读权限与 region endpoint 可用。',
    details: ['probe: DescribeDBInstances(limit=1)']
  };
}

async function probeRedisCapability(): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(listCacheInstances(1), 'Redis capability');
  return {
    capability: 'redis',
    label: AUTH_CAPABILITY_LABELS.redis,
    required: false,
    status: 'ok',
    summary: 'Redis/Tair 读权限与 region endpoint 可用。',
    details: ['probe: DescribeInstances(limit=1)']
  };
}

async function probeRdsAiCapability(): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(listSupabaseInstances(1), 'RDS AI capability');
  return {
    capability: 'rdsai',
    label: AUTH_CAPABILITY_LABELS.rdsai,
    required: false,
    status: 'ok',
    summary: 'RDS AI / Supabase 读权限与 endpoint 可用。',
    details: ['probe: DescribeAppInstances(limit=1)']
  };
}

async function probeLogsCapability(auth: AuthConfig): Promise<DoctorCloudCapabilityProbe> {
  const client = new SlsClientCtor(new $OpenApi.Config({
    accessKeyId: auth.ak,
    accessKeySecret: auth.sk,
    endpoint: `${auth.region}.log.aliyuncs.com`
  }));
  const to = Math.floor(Date.now() / 1000);
  const from = Math.max(0, to - 60);
  try {
    const targets = await discoverDefaultFcSlsTargets(auth, auth.region);
    const target = targets[0];
    if (!target) {
      throw new Error('未发现默认 FC 日志项目');
    }
    await withTimeout(
      client.getLogs(target.project, target.logstore, new $SLS.GetLogsRequest({
        from,
        to,
        query: '*',
        line: 1
      })),
      'Logs capability'
    );
    return {
      capability: 'logs',
      label: AUTH_CAPABILITY_LABELS.logs,
      required: false,
      status: 'ok',
      summary: '日志服务读权限与 region endpoint 可用。',
      details: ['probe: GetLogs(line=1)']
    };
  } catch (err: unknown) {
    if (isLogsBootstrapMissingError(err) || isNotFoundError(err)) {
      return {
        capability: 'logs',
        label: AUTH_CAPABILITY_LABELS.logs,
        required: false,
        status: 'ok',
        summary: '日志服务 endpoint 可达，但默认 FC 日志项目尚未初始化。',
        details: [formatErrorMessage(err)],
        data: { bootstrapMissing: true }
      };
    }
    throw err;
  }
}

async function probeEcsCapability(): Promise<DoctorCloudCapabilityProbe> {
  await withTimeout(listEcsInstances({ limit: 1 }), 'ECS capability');
  return {
    capability: 'ecs',
    label: AUTH_CAPABILITY_LABELS.ecs,
    required: false,
    status: 'ok',
    summary: 'ECS 读权限与 region endpoint 可用。',
    details: ['probe: DescribeInstances(limit=1)']
  };
}

const CAPABILITY_PROBES: Record<AuthCapability, (auth: AuthConfig) => Promise<DoctorCloudCapabilityProbe>> = {
  fc: async (auth) => {
    void auth;
    return probeFcCapability();
  },
  oss: async (auth) => {
    void auth;
    return probeOssCapability();
  },
  'oss-config-read': async (auth) => {
    void auth;
    const probe = await probeOssCapability();
    return {
      ...probe,
      capability: 'oss-config-read',
      label: AUTH_CAPABILITY_LABELS['oss-config-read']
    };
  },
  'oss-config-write': async (auth) => {
    void auth;
    const probe = await probeOssCapability();
    return {
      ...probe,
      capability: 'oss-config-write',
      label: AUTH_CAPABILITY_LABELS['oss-config-write']
    };
  },
  dns: probeDnsCapability,
  cdn: probeCdnCapability,
  vpc: probeVpcCapability,
  'vpc-read': async (auth) => {
    const probe = await probeVpcCapability(auth);
    return {
      ...probe,
      capability: 'vpc-read',
      label: AUTH_CAPABILITY_LABELS['vpc-read']
    };
  },
  'vpc-write': async (auth) => {
    const probe = await probeVpcCapability(auth);
    return {
      ...probe,
      capability: 'vpc-write',
      label: AUTH_CAPABILITY_LABELS['vpc-write']
    };
  },
  cr: probeCrCapability,
  rds: async (auth) => {
    void auth;
    return probeRdsCapability();
  },
  'rds-config-read': async (auth) => {
    return {
      capability: 'rds-config-read',
      label: AUTH_CAPABILITY_LABELS['rds-config-read'],
      required: false,
      status: 'warn',
      summary: 'RDS 配置读取需在命令执行时针对具体实例验证。',
      details: [`runtime probe: DescribeDBInstanceAttribute(instanceId), region=${auth.region}`]
    };
  },
  'rds-config-write': async (auth) => {
    return {
      capability: 'rds-config-write',
      label: AUTH_CAPABILITY_LABELS['rds-config-write'],
      required: false,
      status: 'warn',
      summary: 'RDS 配置修改需在命令执行时针对具体实例验证。',
      details: [`runtime probe: DescribeDBInstanceAttribute + ModifyDBInstanceDescription(instanceId), region=${auth.region}`]
    };
  },
  rdsai: async (auth) => {
    void auth;
    return probeRdsAiCapability();
  },
  redis: async (auth) => {
    void auth;
    return probeRedisCapability();
  },
  'redis-backup-read': async (auth) => {
    void auth;
    const probe = await probeRedisCapability();
    return { ...probe, capability: 'redis-backup-read', label: AUTH_CAPABILITY_LABELS['redis-backup-read'] };
  },
  'redis-backup-write': async (auth) => {
    void auth;
    const probe = await probeRedisCapability();
    return { ...probe, capability: 'redis-backup-write', label: AUTH_CAPABILITY_LABELS['redis-backup-write'] };
  },
  logs: probeLogsCapability,
  ecs: async (auth) => {
    void auth;
    return probeEcsCapability();
  }
};

export async function runCapabilityProbe(auth: AuthConfig, capability: AuthCapability, required: boolean): Promise<DoctorCloudCapabilityProbe> {
  const label = AUTH_CAPABILITY_LABELS[capability];
  try {
    const probe = await CAPABILITY_PROBES[capability](auth);
    return {
      ...probe,
      required
    };
  } catch (err: unknown) {
    const normalized = classifyCloudError(err, {
      label,
      required,
      accessDeniedSummary: `${label} 读权限不足。`,
      unsupportedSummary: `${label} 在 region=${auth.region} 可能不可用或未开通。`
    });
    return {
      capability,
      label,
      required,
      status: normalized.status,
      summary: normalized.summary,
      details: normalized.details,
      ...(normalized.data ? { data: normalized.data } : {})
    };
  }
}

async function probeApiDeployTarget(
  input: DoctorCloudDiagnosticsInput & { project: ProjectConfig },
  mode: 'api' | 'task' = 'api'
): Promise<DoctorCloudCheckResult> {
  const functionName = toOptionalString(input.project.appName)!;
  const expectedRuntime = resolveExpectedFcRuntime(input.runtime);
  const expectedCustomRuntime = resolveExpectedCustomRuntimeSignature(input.runtime);
  const surfaceLabel = mode === 'task' ? 'Task' : 'API';
  const deployCommand = mode === 'task' ? 'licell deploy --type task' : 'licell deploy --type api';

  try {
    const fn = await withTimeout(getFunctionInfo(functionName), 'API deploy target');
    const [aliases, versions] = await Promise.all([
      withTimeout(listFunctionAliases(functionName, 100), 'FC alias probe'),
      withTimeout(listFunctionVersions(functionName, 100), 'FC version probe')
    ]);

    const details = [
      `functionName: ${functionName}`,
      `cloudRuntime: ${fn.runtime || '(missing)'}`,
      `handler: ${fn.handler || '(missing)'}`,
      `state: ${fn.state || '(missing)'}`,
      `updatedAt: ${fn.lastModifiedTime || '(unknown)'}`,
      `publishedVersions: ${versions.length}`,
      `aliases: ${aliases.length}`
    ];
    const remediation: LicellDoctorRemediation[] = [];
    const blockingIssues: string[] = [];
    const warnings: string[] = [];
    const publishedVersionIds = new Set(
      versions
        .map((item) => toOptionalString(item.versionId))
        .filter((item): item is string => Boolean(item))
    );

    if (expectedRuntime) {
      details.push(`expectedCloudRuntime: ${expectedRuntime}`);
      if ((fn.runtime || '').trim().toLowerCase() !== expectedRuntime) {
        blockingIssues.push(`runtime drift: expected ${expectedRuntime}, got ${fn.runtime || '(missing)'}`);
        remediation.push(doctorRemediationCommand(`${deployCommand} --runtime ${input.runtime}`, {
          text: '按当前项目 runtime 重新部署。'
        }));
      }
    }

    const observedCustomRuntime = (fn as { customRuntimeConfig?: { command?: unknown; args?: unknown } }).customRuntimeConfig;
    if (!matchesCustomRuntimeSignature(observedCustomRuntime, expectedCustomRuntime)) {
      warnings.push('custom runtime launcher drift: cloud command/args 与当前 licell runtime contract 不一致');
      remediation.push(doctorRemediationCommand(`${deployCommand} --runtime ${input.runtime}`, {
        text: '建议重新部署，收敛到当前 runtime contract。'
      }));
    }

    if (!isHealthyFcFunctionState(fn.state)) {
      warnings.push(`function state is ${fn.state}`);
      remediation.push(doctorRemediationNote('先确认函数状态，再继续发布或绑定域名。', {
        commandTemplate: 'licell fn info',
        intent: 'inspect'
      }));
    }

    const aliasRows = aliases
      .map((alias) => {
        const aliasName = toOptionalString(alias.aliasName);
        const versionId = toOptionalString(alias.versionId);
        if (!aliasName) return null;
        const broken = Boolean(versionId && !publishedVersionIds.has(versionId));
        return { aliasName, versionId: versionId || null, broken };
      })
      .filter((item): item is { aliasName: string; versionId: string | null; broken: boolean } => Boolean(item));

    if (aliasRows.length === 0) {
      warnings.push('未发现任何 FC alias；后续 release/domain workflow 只能依赖裸函数名。');
      remediation.push(doctorRemediationCommand('licell release promote --target prod', {
        text: '如果要走稳定发布流，先执行 release promote 到稳定 alias。'
      }));
    } else {
      details.push(...aliasRows.map((item) => `alias ${item.aliasName} -> ${item.versionId || '(missing)'}`));
    }

    const brokenAliases = aliasRows.filter((item) => item.broken);
    if (brokenAliases.length > 0) {
      blockingIssues.push(`broken aliases: ${brokenAliases.map((item) => item.aliasName).join(', ')}`);
      remediation.push(doctorRemediationCommand('licell release promote --target <alias>', {
        text: '重新执行 release promote，让 alias 指向实际存在的 published version。'
      }));
    }

    if (versions.length === 0) {
      warnings.push('未发现 published version；说明还没经过 release promote/publish 链路。');
      remediation.push(doctorRemediationCommand('licell release promote --target prod', {
        text: '如需稳定别名/域名切流，先执行 release promote。'
      }));
    }

    if (blockingIssues.length > 0) {
      details.push(...blockingIssues.map((item) => `blocking: ${item}`));
      return {
        status: 'error',
        summary: `${surfaceLabel} deploy target 存在 ${blockingIssues.length} 个阻塞项。`,
        details,
        remediation: normalizeDoctorRemediationItems(remediation),
        nextCommands: doctorNextCommands(deployCommand, 'licell release promote --target <alias>', 'licell fn info'),
        data: {
          mode,
          functionName,
          runtime: fn.runtime || null,
          expectedRuntime: expectedRuntime || null,
          state: fn.state || null,
          aliasCount: aliasRows.length,
          publishedVersionCount: versions.length,
          brokenAliases: brokenAliases.map((item) => item.aliasName)
        }
      };
    }

    if (warnings.length > 0) {
      details.push(...warnings.map((item) => `warn: ${item}`));
      return {
        status: 'warn',
        summary: `${surfaceLabel} deploy target 已找到，但还有 ${warnings.length} 个待收敛项。`,
        details,
        remediation: normalizeDoctorRemediationItems(remediation),
        nextCommands: doctorNextCommands('licell release promote --target prod', 'licell fn info'),
        data: {
          mode,
          functionName,
          runtime: fn.runtime || null,
          expectedRuntime: expectedRuntime || null,
          state: fn.state || null,
          aliasCount: aliasRows.length,
          publishedVersionCount: versions.length
        }
      };
    }

    return {
      status: 'ok',
      summary: `${surfaceLabel} deploy target 与当前项目一致。`,
      details,
      remediation: [],
      data: {
        mode,
        functionName,
        runtime: fn.runtime || null,
        expectedRuntime: expectedRuntime || null,
        state: fn.state || null,
        aliasCount: aliasRows.length,
        publishedVersionCount: versions.length
      }
    };
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      return {
        status: 'error',
        summary: `当前 region 未找到项目函数：${functionName}`,
        details: [`region: ${input.auth.region}`],
        remediation: [doctorRemediationNote('先创建或更新函数；若函数部署在别的 region，请先切换 region。', {
          commandTemplate: deployCommand,
          intent: 'deploy'
        })],
        nextCommands: doctorNextCommands(deployCommand, 'licell switch --region <region>'),
        data: {
          mode,
          functionName,
          expectedRuntime: expectedRuntime || null
        }
      };
    }
    return classifyCloudError(err, {
      label: `${surfaceLabel} deploy target`,
      required: true,
      accessDeniedSummary: '无法读取当前项目对应的 FC function / alias / version 信息。'
    });
  }
}

async function probeStaticDeployTarget(input: DoctorCloudDiagnosticsInput & { project: ProjectConfig }): Promise<DoctorCloudCheckResult> {
  const appName = toOptionalString(input.project.appName)!;
  const bucketName = resolveOssBucketName(appName);

  try {
    const bucketInfo = await withTimeout(getOssBucketInfo(bucketName), 'Static deploy target');
    const objects = await withTimeout(listOssObjects(bucketName, undefined, 1), 'Static object probe');
    const bucketRegion = normalizeRegionName(bucketInfo.location);
    const expectedRegion = normalizeRegionName(input.auth.region);
    const originDomain = resolveOssBucketOriginDomain(bucketName, bucketInfo.extranetEndpoint);
    const details = [
      `bucket: ${bucketName}`,
      `location: ${bucketInfo.location || '(missing)'}`,
      `originDomain: ${originDomain}`,
      `acl: ${bucketInfo.acl || '(unknown)'}`,
      `publicAccessBlock: ${bucketInfo.publicAccessBlock === undefined ? '(unknown)' : (bucketInfo.publicAccessBlock ? 'on' : 'off')}`,
      `sampleObjectCount: ${objects.length}`
    ];
    if (bucketInfo.domains && bucketInfo.domains.length > 0) {
      details.push(...bucketInfo.domains.map((item) => `bucketDomain: ${item.domain}`));
    }

    const remediation: LicellDoctorRemediation[] = [];
    const blockingIssues: string[] = [];
    const warnings: string[] = [];

    if (bucketRegion && expectedRegion && bucketRegion !== expectedRegion) {
      blockingIssues.push(`bucket region drift: expected ${expectedRegion}, got ${bucketRegion}`);
      remediation.push(doctorRemediationNote('切换到 bucket 所在 region，或在当前 region 重新执行静态部署。', {
        commandTemplate: 'licell deploy --type static',
        intent: 'deploy'
      }));
    }

    if (objects.length === 0) {
      warnings.push('bucket 存在，但尚未发现任何对象；看起来还未完成静态资源上传。');
      remediation.push(doctorRemediationCommand('licell deploy --type static', {
        text: `执行静态部署，或上传构建产物到 ${bucketName}。`
      }));
    }

    if (blockingIssues.length > 0) {
      details.push(...blockingIssues.map((item) => `blocking: ${item}`));
      return {
        status: 'error',
        summary: `Static deploy target 存在 ${blockingIssues.length} 个阻塞项。`,
        details,
        remediation: normalizeDoctorRemediationItems(remediation),
        nextCommands: doctorNextCommands('licell deploy --type static', 'licell doctor'),
        data: {
          mode: 'static',
          appName,
          bucketName,
          bucketRegion: bucketRegion || null,
          expectedRegion: expectedRegion || null,
          objectPresent: objects.length > 0
        }
      };
    }

    if (warnings.length > 0) {
      details.push(...warnings.map((item) => `warn: ${item}`));
      return {
        status: 'warn',
        summary: `Static deploy target 已找到，但还有 ${warnings.length} 个待收敛项。`,
        details,
        remediation: normalizeDoctorRemediationItems(remediation),
        nextCommands: doctorNextCommands('licell deploy --type static', 'licell oss upload <bucket>'),
        data: {
          mode: 'static',
          appName,
          bucketName,
          bucketRegion: bucketRegion || null,
          expectedRegion: expectedRegion || null,
          objectPresent: objects.length > 0
        }
      };
    }

    return {
      status: 'ok',
      summary: 'Static deploy target 与当前项目一致。',
      details,
      remediation: [],
      data: {
        mode: 'static',
        appName,
        bucketName,
        bucketRegion: bucketRegion || null,
        expectedRegion: expectedRegion || null,
        objectPresent: objects.length > 0
      }
    };
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      return {
        status: 'error',
        summary: `当前 region 未找到项目静态 Bucket：${bucketName}`,
        details: [`appName: ${appName}`, `region: ${input.auth.region}`],
        remediation: [doctorRemediationNote('先创建 bucket 并上传构建产物；若 bucket 在别的 region，请先切换 region。', {
          commandTemplate: 'licell deploy --type static',
          intent: 'deploy'
        })],
        nextCommands: doctorNextCommands('licell deploy --type static', 'licell switch --region <region>'),
        data: {
          mode: 'static',
          appName,
          bucketName
        }
      };
    }
    return classifyCloudError(err, {
      label: 'Static deploy target',
      required: true,
      accessDeniedSummary: '无法读取当前项目对应的 OSS bucket / object 状态。'
    });
  }
}

export async function probeDoctorDeployTarget(input: DoctorCloudDiagnosticsInput): Promise<DoctorCloudCheckResult> {
  const plan = resolveDoctorDeployTargetPlan(input);
  if (plan.mode === 'skip') {
    if (plan.reason === 'missing_project') {
      return normalizeDoctorCloudCheckResult({
        status: 'skip',
        summary: '当前目录不是 licell 项目，跳过 deploy target 一致性检查。',
        details: [],
        remediation: [],
        data: {
          mode: 'skip',
          reason: plan.reason
        }
      });
    }

    if (plan.reason === 'missing_app_name') {
      return normalizeDoctorCloudCheckResult({
        status: 'skip',
        summary: '项目未配置 appName，跳过云端 deploy target 一致性检查。',
        details: [],
        remediation: [doctorRemediationNote('为项目补齐 appName 后再执行 doctor。', {
          commandTemplate: 'licell doctor',
          intent: 'verify'
        })],
        nextCommands: doctorNextCommands('licell init --app my-app', 'licell doctor'),
        data: {
          mode: 'skip',
          reason: plan.reason
        }
      });
    }

    return normalizeDoctorCloudCheckResult({
      status: 'skip',
      summary: '当前项目未显式声明 deploy type/runtime，跳过云端 deploy target 一致性检查。',
      details: [],
      remediation: [doctorRemediationNote('如需让 doctor 判断云端目标资源，请为项目写入 runtime，或显式传入 runtime。', {
        commandTemplate: 'licell doctor --runtime <runtime>',
        intent: 'verify'
      })],
      nextCommands: doctorNextCommands('licell init --runtime nodejs22', 'licell doctor --runtime <runtime>'),
      data: {
        mode: 'skip',
        reason: plan.reason
      }
    });
  }

  if (!input.project) {
    return normalizeDoctorCloudCheckResult({
      status: 'skip',
      summary: '当前目录不是 licell 项目，跳过 deploy target 一致性检查。',
      details: [],
      remediation: [],
      data: {
        mode: 'skip',
        reason: 'missing_project'
      }
    });
  }

  return normalizeDoctorCloudCheckResult(await (plan.mode === 'api'
    ? probeApiDeployTarget({ ...input, project: input.project }, 'api')
    : plan.mode === 'task'
      ? probeApiDeployTarget({ ...input, project: input.project }, 'task')
      : probeStaticDeployTarget({ ...input, project: input.project })));
}

export function summarizeDoctorCapabilityProbes(
  probes: DoctorCloudCapabilityProbe[],
  plan: DoctorCloudCapabilityPlan
): DoctorCloudDiagnostics['capabilities'] {
  const requiredFailures = probes.filter((probe) => probe.required && probe.status === 'error');
  const optionalIssues = probes.filter((probe) => !probe.required && probe.status !== 'ok');
  const warnings = probes.filter((probe) => probe.status === 'warn');
  const details = probes.map((probe) => `${probe.required ? '[required]' : '[optional]'} ${probe.label}: ${probe.summary}`);

  let status: 'ok' | 'warn' | 'error' = 'ok';
  let summary = '云端 capability probe 全部通过。';
  const remediation: LicellDoctorRemediation[] = [];

  if (requiredFailures.length > 0) {
    status = 'error';
    summary = `发现 ${requiredFailures.length} 个与当前项目直接相关的云端阻塞能力。`;
    remediation.push(doctorRemediationNote('优先修复 required capability 对应的权限或 region 问题，再继续 deploy / domain / data 工作流。'));
  } else if (optionalIssues.length > 0 || warnings.length > 0) {
    status = 'warn';
    summary = `required capability 已通过，但还有 ${optionalIssues.length} 个 optional issue。`;
    remediation.push(doctorRemediationNote('这些 optional issue 不一定阻塞当前项目，但会影响对应服务面。'));
  }

  if (probes.some((probe) => probe.status !== 'ok')) {
    remediation.push(doctorRemediationCommand('licell auth repair', {
      text: '如需自动补齐权限，执行 auth repair。'
    }));
  }

  return normalizeDoctorCloudCheckResult({
    status,
    summary,
    details,
    remediation: normalizeDoctorRemediationItems(remediation),
    nextCommands: probes.some((probe) => probe.status !== 'ok')
      ? doctorNextCommands('licell auth repair', 'licell switch --region <region>')
      : [],
    data: {
      required: plan.required,
      optional: plan.optional,
      probes
    }
  }) as DoctorCloudDiagnostics['capabilities'];
}

export async function runDoctorCloudDiagnostics(input: DoctorCloudDiagnosticsInput): Promise<DoctorCloudDiagnostics> {
  const plan = resolveDoctorCapabilityPlan({
    project: input.project,
    deployTypeHint: input.deployTypeHint,
    runtime: input.runtime
  });
  const orderedCapabilities = [...plan.required, ...plan.optional];
  const [identity, ramProfile, deployTarget, domainConsistency, probes] = await Promise.all([
    probeCallerIdentity(input.auth),
    probeRamProfile(input.auth),
    probeDoctorDeployTarget(input),
    probeDoctorDomainConsistency(input),
    Promise.all(
      orderedCapabilities.map((capability) =>
        runCapabilityProbe(input.auth, capability, plan.required.includes(capability))
      )
    )
  ]);

  return {
    identity: normalizeDoctorCloudCheckResult(identity),
    ramProfile: normalizeDoctorCloudCheckResult(ramProfile),
    deployTarget: normalizeDoctorCloudCheckResult(deployTarget),
    domainConsistency: normalizeDoctorCloudCheckResult(domainConsistency),
    capabilities: summarizeDoctorCapabilityProbes(probes, plan)
  };
}
