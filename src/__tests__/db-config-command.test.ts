import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cac } from 'cac';

const {
  applyDatabaseConfigMock,
  emitCommandResultMock,
  ensureMutatingActionConfirmedMock,
  executeWithAuthRecoveryMock,
  planDatabaseConfigMock
} = vi.hoisted(() => ({
  applyDatabaseConfigMock: vi.fn(),
  emitCommandResultMock: vi.fn(),
  ensureMutatingActionConfirmedMock: vi.fn(async () => {}),
  executeWithAuthRecoveryMock: vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task()),
  planDatabaseConfigMock: vi.fn()
}));

vi.mock('../providers/infra', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/infra')>()),
  applyDatabaseConfig: applyDatabaseConfigMock,
  planDatabaseConfig: planDatabaseConfigMock
}));
vi.mock('../utils/auth-recovery', () => ({ executeWithAuthRecovery: executeWithAuthRecoveryMock }));
vi.mock('../utils/cli-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/cli-shared')>()),
  ensureAuthOrExit: vi.fn(),
  ensureMutatingActionConfirmed: ensureMutatingActionConfirmedMock,
  isInteractiveTTY: vi.fn(() => false)
}));
vi.mock('../utils/output', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/output')>()),
  emitCommandResult: emitCommandResultMock,
  isJsonOutput: vi.fn(() => true)
}));

async function createCli() {
  const cli = cac('licell');
  const { registerDbCommands } = await import('../commands/db');
  registerDbCommands(cli);
  return cli;
}

describe('RDS config command', () => {
  beforeEach(() => {
    emitCommandResultMock.mockReset();
    ensureMutatingActionConfirmedMock.mockClear();
    executeWithAuthRecoveryMock.mockClear();
    planDatabaseConfigMock.mockReset().mockResolvedValue({
      regionId: 'cn-shanghai',
      instanceId: 'pgm-staging',
      current: { description: 'new-staging-clips' },
      desiredState: { description: 'new-staging-clips-managed' },
      after: { description: 'new-staging-clips-managed' },
      changes: [{
        field: 'description',
        action: 'set',
        before: 'new-staging-clips',
        after: 'new-staging-clips-managed'
      }],
      changeCount: 1,
      requiresConfirmation: true,
      willExecute: false
    });
    applyDatabaseConfigMock.mockReset();
  });

  it('routes dry-run through read permission and planning only', async () => {
    const cli = await createCli();
    await cli.parse([
      'node', 'src/cli.ts', 'db config apply', 'pgm-staging',
      '--payload', '{"description":"new-staging-clips-managed"}', '--dry-run'
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executeWithAuthRecoveryMock).toHaveBeenLastCalledWith(expect.objectContaining({
      commandLabel: 'licell db config apply',
      requiredCapabilities: ['rds-config-read']
    }), expect.any(Function));
    expect(planDatabaseConfigMock).toHaveBeenCalledWith(
      'pgm-staging',
      { description: 'new-staging-clips-managed' }
    );
    expect(applyDatabaseConfigMock).not.toHaveBeenCalled();
    expect(ensureMutatingActionConfirmedMock).not.toHaveBeenCalled();
    expect(emitCommandResultMock).toHaveBeenCalledWith(expect.objectContaining({
      execution: { performed: false },
      verify: expect.objectContaining({ performed: false })
    }));
  });

  it('routes confirmed apply through write permission and provider verification', async () => {
    applyDatabaseConfigMock.mockResolvedValue({
      stage: 'db.config.apply.pgm-staging',
      plan: {
        instanceId: 'pgm-staging',
        changes: [{ field: 'description', action: 'set', before: 'old', after: 'new' }],
        changeCount: 1,
        willExecute: true
      },
      execution: { performed: true, requestId: 'request-a' },
      verify: { performed: true, matched: true, attributes: { description: 'new' } }
    });

    const cli = await createCli();
    await cli.parse([
      'node', 'src/cli.ts', 'db config apply', 'pgm-staging',
      '--payload', '{"description":"new"}', '--yes'
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executeWithAuthRecoveryMock).toHaveBeenLastCalledWith(expect.objectContaining({
      commandLabel: 'licell db config apply',
      requiredCapabilities: ['rds-config-write']
    }), expect.any(Function));
    expect(ensureMutatingActionConfirmedMock).toHaveBeenCalledWith('修改 RDS pgm-staging 实例描述', {
      yes: true,
      interactiveTTY: false
    });
    expect(applyDatabaseConfigMock).toHaveBeenCalledWith('pgm-staging', { description: 'new' });
    expect(planDatabaseConfigMock).not.toHaveBeenCalled();
    expect(emitCommandResultMock).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({ performed: true }),
      verify: expect.objectContaining({ performed: true, matched: true, attributes: { description: 'new' } })
    }));
  });
});
