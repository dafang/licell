import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { extractJsonRecordsFromOutput } from '../utils/output';

const ECS_LIFECYCLE_HELP_PATTERN = /(?:licell )?ecs (run|create)\b|ecs:(RunInstances)/;

beforeAll(() => {
  const warmup = spawnSync('bun', ['x', 'tsx', '--version'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  if (warmup.status !== 0) {
    throw new Error(warmup.stderr || warmup.stdout || warmup.error?.message || 'tsx warmup failed');
  }
}, 30000);

function runCliHelpJson(args: string[]) {
  const result = spawnSync(
    'bun',
    [
      'x',
      'tsx',
      '--tsconfig',
      resolve(process.cwd(), 'tsconfig.json'),
      resolve(process.cwd(), 'src/cli.ts'),
      ...args,
      '--help',
      '--output',
      'json'
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' }
    }
  );

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message
  };
}

describe('cli help json contract', () => {
  it('keeps ecs namespace help includes lifecycle commands but excludes run/create', () => {
    const result = runCliHelpJson(['ecs']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.stage).toBe('help');
    expect(record?.key).toBe('ecs');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('namespace');
    expect(record?.help?.safety?.level).toBe('destructive');
    expect(record?.help?.safety?.confirmFlags).toContain('--yes');
    expect(record?.help?.subcommands.map((command: { key?: string }) => command.key)).toEqual(expect.arrayContaining([
      'ecs info',
      'ecs list',
      'ecs start',
      'ecs reboot',
      'ecs stop',
      'ecs delete',
      'ecs rm'
    ]));
    expect(record?.help?.subcommands).toHaveLength(7);
    expect(JSON.stringify(record)).not.toMatch(ECS_LIFECYCLE_HELP_PATTERN);
  }, 10000);

  it('locks deploy help json contract for task-aware result schema', () => {
    const result = runCliHelpJson(['deploy']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.stage).toBe('help');
    expect(record?.key).toBe('deploy');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.schemaVersion).toBe('1.0');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.schemas?.cliRecord).toEqual({
      kind: 'licell-cli-record',
      schemaVersion: '1.0'
    });
    expect(record?.help?.nextActions.map((action: { commandTemplate?: string }) => action.commandTemplate)).toEqual([
      'licell deploy spec',
      'licell deploy check',
      'licell deploy --output json',
      'licell release promote <versionId>'
    ]);
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'functionName')).toBe(true);
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'configuredQualifiers[]')).toBe(true);
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'invokeCommand')).toBe(true);
    expect(record?.help?.renderedText).toContain('Structured Result:');
    expect(record?.help?.renderedText).toContain('`invokeCommand` · 当 `type=task` 时，推荐直接复制执行的任务调用命令。');
  }, 10000);

  it('locks task list help json contract for task tracking schema', () => {
    const result = runCliHelpJson(['task', 'list']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.stage).toBe('help');
    expect(record?.key).toBe('task list');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.nextActions.map((action: { commandTemplate?: string }) => action.commandTemplate)).toEqual([
      'licell task list [name] --output json',
      'licell task info <taskId> [name] --output json',
      'licell task stop <taskId> [name] --output json'
    ]);
    expect(record?.help?.result?.fieldTree.some((field: { name?: string }) => field.name === 'tasks[]')).toBe(true);
    const tasksNode = record?.help?.result?.fieldTree.find((field: { name?: string }) => field.name === 'tasks[]');
    expect(tasksNode?.children.some((field: { name?: string }) => field.name === 'tasks[].taskId')).toBe(true);
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'nextToken')).toBe(true);
    expect(record?.help?.renderedText).toContain('`tasks[]` · 异步任务摘要数组。');
    expect(record?.help?.renderedText).toContain('`nextToken` · 服务端下一页游标；若为 `null` 代表没有更多结果。');
  }, 10000);

  it('locks ecs list help json contract for agent discovery', () => {
    const result = runCliHelpJson(['ecs', 'list']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.stage).toBe('help');
    expect(record?.key).toBe('ecs list');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.safety?.level).toBe('safe');
    expect(record?.help?.options.map((option: { rawName?: string }) => option.rawName)).toEqual(expect.arrayContaining([
      '--region <regionId>',
      '--limit <n>',
      '--tag <key=value>',
      '--name-prefix <prefix>',
      '--private-ip <ip>',
      '--public-ip <ip>',
      '--eip <ip>'
    ]));
    expect(record?.help?.examples).toContain('licell ecs list --output json');
    expect(record?.help?.recommendedFlow.map((step: { command?: string }) => step.command)).toContain('licell ecs list --output json');
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'instances[]')).toBe(true);
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'filters')).toBe(true);
    expect(record?.help?.result?.fields.map((field: { name?: string }) => field.name)).toEqual(expect.arrayContaining([
      'regionId',
      'count',
      'limit',
      'totalCount',
      'truncated',
      'filters',
      'instances[]'
    ]));
    expect(record?.help?.renderedText).toContain('`instances[]`');
    expect(JSON.stringify(record)).not.toMatch(ECS_LIFECYCLE_HELP_PATTERN);
  }, 10000);

  it('locks ecs info help json contract for agent discovery', () => {
    const result = runCliHelpJson(['ecs', 'info']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.stage).toBe('help');
    expect(record?.key).toBe('ecs info');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.safety?.level).toBe('safe');
    expect(record?.help?.options.map((option: { rawName?: string }) => option.rawName)).toContain('--region <regionId>');
    expect(record?.help?.examples).toContain('licell ecs info i-xxx --output json');
    expect(record?.help?.recommendedFlow.map((step: { command?: string }) => step.command)).toContain('licell ecs info <instanceId> --output json');
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'detail.summary')).toBe(true);
    expect(record?.help?.result?.fields.some((field: { name?: string }) => field.name === 'detail.summary.securityGroupIds[]')).toBe(true);
    expect(record?.help?.renderedText).toContain('`detail.summary`');
    expect(record?.help?.result?.fields.map((field: { name?: string }) => field.name).join(' ')).not.toMatch(/rawAttribute|userData|vncUrl|consoleOutput|password|keyPairPrivateKey/);
    expect(JSON.stringify(record)).not.toMatch(ECS_LIFECYCLE_HELP_PATTERN);
  }, 10000);

  it('locks VPC topology help as a safe curated inventory contract', () => {
    const result = runCliHelpJson(['vpc', 'topology']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.key).toBe('vpc topology');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.safety).toMatchObject({ level: 'safe', confirmFlags: [] });
    expect(record?.help?.examples).toContain('licell vpc topology vpc-xxx --region cn-hangzhou --output json');
    expect(record?.help?.result?.fields.map((field: { name?: string }) => field.name)).toEqual(expect.arrayContaining([
      'counts',
      'vSwitches[]',
      'routeTables[]',
      'natGateways[]',
      'eipAddresses[]',
      'relationships'
    ]));
    expect(record?.help?.renderedText).toContain('`relationships`');
  }, 10000);

  it('locks VPC config apply help as a guarded desired-state contract', () => {
    const result = runCliHelpJson(['vpc', 'config', 'apply']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.key).toBe('vpc config apply');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.safety).toMatchObject({ level: 'mutating', confirmFlags: ['--yes'] });
    expect(record?.help?.options.map((option: { rawName?: string }) => option.rawName)).toEqual(expect.arrayContaining([
      '--region <regionId>',
      '--dry-run',
      '--yes',
      '--payload <json>',
      '--file <path>'
    ]));
    expect(record?.help?.recommendedFlow.map((step: { command?: string }) => step.command)).toEqual(expect.arrayContaining([
      'licell vpc config apply <vpc> --file <path> --dry-run --output json',
      'licell vpc config apply <vpc> --file <path> --yes --output json'
    ]));
    expect(record?.help?.result?.fields.map((field: { name?: string }) => field.name)).toEqual(expect.arrayContaining([
      'plan.changes[]',
      'execution.performed',
      'verify.performed',
      'verify.attributes'
    ]));
  }, 10000);

  it('locks RDS config apply help as a guarded desired-state contract', () => {
    const result = runCliHelpJson(['db', 'config', 'apply']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.key).toBe('db config apply');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.safety).toMatchObject({ level: 'mutating', confirmFlags: ['--yes'] });
    expect(record?.help?.options.map((option: { rawName?: string }) => option.rawName)).toEqual(expect.arrayContaining([
      '--region <regionId>',
      '--dry-run',
      '--yes',
      '--payload <json>',
      '--file <path>'
    ]));
    expect(record?.help?.recommendedFlow.map((step: { command?: string }) => step.command)).toEqual(expect.arrayContaining([
      'licell db config apply <instanceId> --file <path> --dry-run --output json',
      'licell db config apply <instanceId> --file <path> --yes --output json'
    ]));
    expect(record?.help?.result?.fields.map((field: { name?: string }) => field.name)).toEqual(expect.arrayContaining([
      'plan.changes[]',
      'execution.performed',
      'verify.performed',
      'verify.attributes'
    ]));
  }, 10000);

  it('locks Redis backup policy help as a guarded desired-state contract', () => {
    const result = runCliHelpJson(['cache', 'backup-policy', 'apply']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record?.key).toBe('cache backup-policy apply');
    expect(record?.help?.kind).toBe('licell-help');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.safety).toMatchObject({ level: 'mutating', confirmFlags: ['--yes'] });
    expect(record?.help?.options.map((option: { rawName?: string }) => option.rawName)).toEqual(expect.arrayContaining([
      '--region <regionId>',
      '--dry-run',
      '--yes',
      '--payload <json>',
      '--file <path>'
    ]));
    expect(record?.help?.recommendedFlow.map((step: { command?: string }) => step.command)).toEqual(expect.arrayContaining([
      'licell cache backup-policy apply <instanceId> --file <path> --dry-run --output json',
      'licell cache backup-policy apply <instanceId> --file <path> --yes --output json'
    ]));
    expect(record?.help?.result?.fields.map((field: { name?: string }) => field.name)).toEqual(expect.arrayContaining([
      'plan.changes[]',
      'execution.performed',
      'verify.performed',
      'verify.policy'
    ]));
  }, 10000);

  it('locks capability describe help as a local raw metadata contract', () => {
    const result = runCliHelpJson(['capability', 'describe']);
    const records = extractJsonRecordsFromOutput(result.stdout) as Array<Record<string, any>>;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.key).toBe('capability describe');
    expect(record?.help?.scope).toBe('command');
    expect(record?.help?.safety?.level).toBe('safe');
    expect(record?.help?.automation?.preferredOutput).toBe('json');
    expect(record?.help?.result?.fields.map((field: { name?: string }) => field.name)).toEqual(expect.arrayContaining([
      'capability.ref',
      'capability.maturity',
      'capability.inputSchema',
      'capability.provenance',
      'execution.strategy',
      'execution.preferred',
      'limitations[]'
    ]));
  }, 10000);
});
