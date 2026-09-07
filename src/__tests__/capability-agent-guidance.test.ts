import { describe, expect, it } from 'vitest';
import { enrichDescribeForAgent } from '../commands/capability';
import { describeAlicloudCapability } from '../utils/alicloud-capabilities';

describe('capability agent guidance', () => {
  it('prefers the curated VPC inventory for DescribeVpcs', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('vpc.DescribeVpcs'));

    expect(result.curatedCommandCandidates.map((candidate) => candidate.key)).toEqual([
      'vpc list',
      'vpc info',
      'vpc topology'
    ]);
    expect(result.execution).toMatchObject({
      policy: 'curated-first',
      strategy: 'curated-command',
      preferred: {
        kind: 'curated-command',
        commandKey: 'vpc list'
      }
    });
    expect(result.nextActions[0]?.commandTemplate).toBe('licell catalog --root-command vpc --output json');
    expect(result.nextActions.some((action) => action.commandTemplate.includes('api invoke vpc.DescribeVpcs'))).toBe(true);
  }, 20_000);

  it.each([
    ['vpc.DescribeVSwitches', 'vpc topology'],
    ['vpc.DescribeRouteTables', 'vpc topology'],
    ['vpc.DescribeNatGateways', 'vpc topology'],
    ['vpc.DescribeEipAddresses', 'vpc topology']
  ])('routes %s to the curated topology command', async (ref, commandKey) => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability(ref));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey });
  }, 20_000);

  it('routes ModifyVpcAttribute to the guarded VPC config workflow', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('vpc.ModifyVpcAttribute'));

    expect(result.curatedCommandCandidates[0]?.key).toBe('vpc config apply');
    expect(result.execution).toMatchObject({
      policy: 'curated-first',
      strategy: 'curated-command',
      preferred: {
        kind: 'curated-command',
        commandKey: 'vpc config apply',
        helpCommand: 'licell vpc config apply --help --output json'
      },
      fallback: { kind: 'raw-api' }
    });
  }, 20_000);

  it('prefers the function list command for FC ListFunctions', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('fc.ListFunctions'));

    expect(result.curatedCommandCandidates[0]?.key).toBe('fn list');
    expect(result.nextActions[0]?.commandTemplate).toBe('licell catalog --root-command fn --output json');
    expect(result.nextActions[1]?.commandTemplate).toBe('licell fn list --help --output json');
    expect(result.curatedCommandCandidates[0]?.match).toBe('curated-overlay');
    expect(result.execution).toMatchObject({
      strategy: 'curated-command',
      preferred: { kind: 'curated-command', commandKey: 'fn list' },
      fallback: { kind: 'raw-api' }
    });
  }, 20_000);

  it('builds an actionable raw fallback from required protocol parameters', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('cs.DescribeClusterDetail'));

    expect(result.execution).toMatchObject({
      strategy: 'raw-api-fallback',
      preferred: {
        kind: 'raw-api',
        previewCommand: 'licell api invoke cs.DescribeClusterDetail --param ClusterId=<ClusterId> --output json'
      }
    });
  }, 20_000);

  it('prefers curated Kubernetes inventory over the raw CS cluster API', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('cs.DescribeClusters'));

    expect(result.execution).toMatchObject({
      strategy: 'curated-command',
      preferred: { kind: 'curated-command', commandKey: 'k8s clusters' },
      fallback: { kind: 'raw-api' }
    });
    expect(result.nextActions[0]?.commandTemplate).toBe('licell catalog --root-command k8s --output json');
  }, 20_000);

  it('prefers the curated RAM users inventory for ListUsers', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('ram.ListUsers'));

    expect(result.curatedCommandCandidates[0]?.key).toBe('ram users');
    expect(result.curatedCommandCandidates[0]?.match).toBe('curated-overlay');
    expect(result.execution).toMatchObject({
      strategy: 'curated-command',
      preferred: {
        kind: 'curated-command',
        commandKey: 'ram users',
        helpCommand: 'licell ram users --help --output json'
      },
      fallback: { kind: 'raw-api' }
    });
  }, 20_000);

  it('prefers the curated CAS certificate inventory for ListCert', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('cas.ListCert'));

    expect(result.curatedCommandCandidates[0]?.key).toBe('cert list');
    expect(result.execution).toMatchObject({
      strategy: 'curated-command',
      preferred: {
        kind: 'curated-command',
        commandKey: 'cert list',
        helpCommand: 'licell cert list --help --output json'
      },
      fallback: { kind: 'raw-api' }
    });
  }, 20_000);

  it('prefers the curated CDN domain inventory for DescribeUserDomains', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('cdn.DescribeUserDomains'));

    expect(result.curatedCommandCandidates[0]?.key).toBe('cdn domains');
    expect(result.execution).toMatchObject({
      strategy: 'curated-command',
      preferred: {
        kind: 'curated-command',
        commandKey: 'cdn domains',
        helpCommand: 'licell cdn domains --help --output json'
      },
      fallback: { kind: 'raw-api' }
    });
  }, 20_000);

  it('prefers the curated SLS project inventory for ListProject', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('sls.ListProject'));

    expect(result.curatedCommandCandidates[0]?.key).toBe('logs projects');
    expect(result.execution).toMatchObject({
      strategy: 'curated-command',
      preferred: {
        kind: 'curated-command',
        commandKey: 'logs projects',
        helpCommand: 'licell logs projects --help --output json'
      },
      fallback: { kind: 'raw-api' }
    });
  }, 20_000);

  it('prefers the curated SLS index command for GetIndex', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('sls.GetIndex'));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey: 'logs index' });
  });

  it('prefers the curated FC aliases command for ListAliases', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('fc.ListAliases'));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey: 'fn aliases' });
  });

  it('prefers the curated FC triggers command for ListTriggers', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('fc.ListTriggers'));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey: 'fn triggers' });
  });

  it('prefers the curated FC layers command for ListLayers', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('fc.ListLayers'));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey: 'fn layers' });
  });

  it.each(['ListConcurrencyConfigs', 'ListProvisionConfigs', 'ListScalingConfigs'])(
    'prefers the curated FC capacity command for %s',
    async (operation) => {
      const result = await enrichDescribeForAgent(describeAlicloudCapability(`fc.${operation}`));
      expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey: 'fn capacity' });
    }
  );

  it.each([
    ['ListInstances', 'fn instances'],
    ['ListSessions', 'fn sessions'],
    ['ListVpcBindings', 'fn vpc-bindings'],
    ['ListTagResources', 'fn tags']
  ])('prefers the curated FC runtime inventory command for %s', async (operation, commandKey) => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability(`fc.${operation}`));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey });
  });

  it.each([
    ['DescribeBackups', 'db backups'],
    ['DescribeBackupPolicy', 'db backups'],
    ['DescribeParameters', 'db parameters'],
    ['DescribeAccounts', 'db accounts'],
    ['DescribeDatabases', 'db databases']
  ])('prefers the curated RDS inventory command for %s', async (operation, commandKey) => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability(`rds.${operation}`));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey });
  });

  it.each(['CloneDBInstance', 'DescribeLocalAvailableRecoveryTime'])(
    'routes RDS restore capability %s through the read-only restore plan',
    async (operation) => {
      const result = await enrichDescribeForAgent(describeAlicloudCapability(`rds.${operation}`));
      expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey: 'db restore plan' });
    }
  );

  it('routes RDS description updates through the guarded config workflow', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('rds.ModifyDBInstanceDescription'));
    expect(result.execution.preferred).toMatchObject({
      kind: 'curated-command',
      commandKey: 'db config apply',
      helpCommand: 'licell db config apply --help --output json'
    });
  });

  it.each([
    ['DescribeBackups', 'cache backups'],
    ['DescribeBackupPolicy', 'cache backups'],
    ['DescribeParameters', 'cache parameters'],
    ['DescribeInstanceConfig', 'cache parameters'],
    ['DescribeAccounts', 'cache accounts'],
    ['DescribeClusterMemberInfo', 'cache topology']
  ])('prefers the curated Redis/Tair inventory command for %s', async (operation, commandKey) => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability(`r-kvstore.${operation}`));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey });
  });

  it('routes Redis/Tair backup policy updates through the desired-state command', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('r-kvstore.ModifyBackupPolicy'));
    expect(result.execution.preferred).toMatchObject({
      kind: 'curated-command',
      commandKey: 'cache backup-policy apply'
    });
  });

  it.each([
    ['ListInstance', 'acr instances'],
    ['ListNamespace', 'acr namespaces'],
    ['ListRepository', 'acr repositories'],
    ['ListRepoTag', 'acr tags'],
    ['GetRepoTagScanStatus', 'acr scan'],
    ['GetRepoTagScanSummary', 'acr scan'],
    ['ListRepoTagScanResult', 'acr scan']
  ])('prefers the curated ACR inventory command for %s', async (operation, commandKey) => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability(`cr.${operation}`));
    expect(result.execution.preferred).toMatchObject({ kind: 'curated-command', commandKey });
  });

  it('prefers the curated SLS logstore inventory for ListLogStores', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('sls.ListLogStores'));

    expect(result.curatedCommandCandidates[0]?.key).toBe('logs logstores');
    expect(result.execution).toMatchObject({
      strategy: 'curated-command',
      preferred: {
        kind: 'curated-command',
        commandKey: 'logs logstores',
        helpCommand: 'licell logs logstores --help --output json'
      },
      fallback: { kind: 'raw-api' }
    });
  }, 20_000);

  it('preserves curated overlay priority when one API maps to multiple commands', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('rds.DescribeDBInstances'));

    expect(result.curatedCommandCandidates.map((candidate) => candidate.key).slice(0, 2)).toEqual([
      'db list',
      'db info'
    ]);
    expect(result.execution.preferred).toMatchObject({
      kind: 'curated-command',
      commandKey: 'db list',
      helpCommand: 'licell db list --help --output json'
    });
  }, 20_000);

  it('requires preview and explicit confirmation for an uncurated write operation', async () => {
    const result = await enrichDescribeForAgent(describeAlicloudCapability('vpc.CreateVpc'));

    expect(result.execution).toMatchObject({
      policy: 'curated-first',
      strategy: 'raw-api-fallback',
      preferred: {
        kind: 'raw-api',
        requiresConfirmation: true
      }
    });
    const preferred = result.execution.preferred;
    expect(preferred.kind).toBe('raw-api');
    if (preferred.kind !== 'raw-api') throw new Error('expected raw API fallback');
    expect(preferred.previewCommand).toContain('--dry-run');
    expect(preferred.executeCommand).toContain('--yes');
  }, 20_000);

});
