import { describe, expect, it } from 'vitest';
import { AUTH_CAPABILITY_LABELS, detectAuthIssue, resolveAuthCapabilityActions } from '../utils/auth-recovery';

const ECS_LIFECYCLE_ALLOWED_ACTIONS = [
  'ecs:StartInstance',
  'ecs:RebootInstance',
  'ecs:StopInstance',
  'ecs:DeleteInstance'
];

const ECS_LIFECYCLE_FORBIDDEN_ACTIONS = [
  'ecs:RunInstances'
];

function withCode(message: string, code?: string) {
  const err = new Error(message);
  if (code) (err as unknown as { code: string }).code = code;
  return err;
}

describe('detectAuthIssue', () => {
  it('detects missing auth', () => {
    expect(detectAuthIssue(withCode('未登录，请先执行 `licell login`'))).toBe('missing_auth');
  });

  it('detects access denied', () => {
    expect(detectAuthIssue(withCode('forbidden', 'AccessDenied'))).toBe('access_denied');
  });

  it('detects invalid credentials', () => {
    expect(detectAuthIssue(withCode('SignatureDoesNotMatch', 'InvalidAccessKeyId.NotFound'))).toBe('invalid_credentials');
  });

  it('returns unknown for unrelated errors', () => {
    expect(detectAuthIssue(withCode('something else', 'InvalidParameter'))).toBe('unknown');
  });
});

describe('resolveAuthCapabilityActions', () => {
  it('returns sorted unique action hints for capabilities', () => {
    const actions = resolveAuthCapabilityActions(['dns', 'fc', 'dns']);
    expect(actions).toEqual([
      'alidns:AddDomainRecord',
      'alidns:DeleteDomainRecord',
      'alidns:DescribeDomainRecords',
      'fc:GetFunction',
      'fc:ListFunctions',
      'fc:UpdateFunction'
    ]);
  });

  it('exposes ECS read-only and lifecycle action hints, excludes instance creation', () => {
    expect(AUTH_CAPABILITY_LABELS.ecs).toBe('ECS');
    const actions = resolveAuthCapabilityActions(['ecs']);
    expect(actions).toEqual([
      'ecs:DeleteInstance',
      'ecs:DescribeDisks',
      'ecs:DescribeInstanceAttribute',
      'ecs:DescribeInstances',
      'ecs:RebootInstance',
      'ecs:StartInstance',
      'ecs:StopInstance'
    ]);
    for (const action of ECS_LIFECYCLE_ALLOWED_ACTIONS) {
      expect(actions).toContain(action);
    }
    for (const action of ECS_LIFECYCLE_FORBIDDEN_ACTIONS) {
      expect(actions).not.toContain(action);
    }
  });

  it('keeps VPC inventory permission hints read-only', () => {
    expect(AUTH_CAPABILITY_LABELS['vpc-read']).toBe('VPC 只读查询');
    expect(resolveAuthCapabilityActions(['vpc-read'])).toEqual([
      'vpc:DescribeEipAddresses',
      'vpc:DescribeNatGateways',
      'vpc:DescribeRouteTables',
      'vpc:DescribeVSwitches',
      'vpc:DescribeVpcs'
    ]);
  });

  it('keeps VPC attribute writes on a separate minimal capability', () => {
    expect(AUTH_CAPABILITY_LABELS['vpc-write']).toBe('VPC 属性修改');
    expect(resolveAuthCapabilityActions(['vpc-write'])).toEqual([
      'vpc:DescribeVpcs',
      'vpc:ModifyVpcAttribute'
    ]);
  });

  it('keeps Redis backup policy writes on a separate minimal capability', () => {
    expect(AUTH_CAPABILITY_LABELS['redis-backup-write']).toBe('Redis/Tair 备份策略修改');
    expect(resolveAuthCapabilityActions(['redis-backup-read'])).toEqual([
      'kvstore:DescribeBackupPolicy'
    ]);
    expect(resolveAuthCapabilityActions(['redis-backup-write'])).toEqual([
      'kvstore:DescribeBackupPolicy',
      'kvstore:ModifyBackupPolicy'
    ]);
  });

  it('keeps RDS config planning on a minimal read capability', () => {
    expect(AUTH_CAPABILITY_LABELS['rds-config-read']).toBe('RDS 配置读取');
    expect(resolveAuthCapabilityActions(['rds-config-read'])).toEqual([
      'rds:DescribeDBInstanceAttribute'
    ]);
  });

  it('keeps RDS config writes on a separate minimal capability', () => {
    expect(resolveAuthCapabilityActions(['rds-config-write'])).toEqual([
      'rds:DescribeDBInstanceAttribute',
      'rds:ModifyDBInstanceDescription'
    ]);
  });
});
