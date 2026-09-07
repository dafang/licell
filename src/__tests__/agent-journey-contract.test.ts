import { describe, expect, it } from 'vitest';
import { enrichDescribeForAgent } from '../commands/capability';
import { describeAlicloudCapability, searchAlicloudCapabilities, searchAlicloudProducts } from '../utils/alicloud-capabilities';
import { getCommandCatalog } from '../utils/command-catalog';

type JourneyCase = {
  name: string;
  product: string;
  intent: string;
  expectedRef: string;
  strategy: 'curated-command' | 'raw-api-fallback';
  commandKey?: string;
  action?: 'inspect' | 'create' | 'update';
};

// This matrix tests the Agent decision chain, not every provider API. Add a
// representative case when a new service or routing rule is promoted.
const JOURNEY_MATRIX: JourneyCase[] = [
  { name: 'VPC inventory', product: 'vpc', intent: '列出 VPC 网络', expectedRef: 'vpc.DescribeVpcs', strategy: 'curated-command', commandKey: 'vpc list' },
  { name: 'VPC attribute update', product: 'vpc', intent: '修改 VPC 名称和描述', expectedRef: 'vpc.ModifyVpcAttribute', strategy: 'curated-command', commandKey: 'vpc config apply', action: 'update' },
  { name: 'ECS inventory', product: 'ecs', intent: '查看云服务器实例', expectedRef: 'ecs.DescribeInstances', strategy: 'curated-command', commandKey: 'ecs list' },
  { name: 'Kubernetes clusters', product: 'cs', intent: '查看 k8s 集群', expectedRef: 'cs.DescribeClusters', strategy: 'curated-command', commandKey: 'k8s clusters' },
  { name: 'Function inventory', product: 'fc', intent: '列出函数', expectedRef: 'fc.ListFunctions', strategy: 'curated-command', commandKey: 'fn list' },
  { name: 'RDS inventory', product: 'rds', intent: '查看数据库实例', expectedRef: 'rds.DescribeDBInstances', strategy: 'curated-command', commandKey: 'db list' },
  { name: 'RDS description update', product: 'rds', intent: '修改 RDS 实例描述', expectedRef: 'rds.ModifyDBInstanceDescription', strategy: 'curated-command', commandKey: 'db config apply', action: 'update' },
  { name: 'Redis inventory', product: 'r-kvstore', intent: '查看缓存实例', expectedRef: 'r-kvstore.DescribeInstances', strategy: 'curated-command', commandKey: 'cache list' },
  { name: 'RAM user inventory', product: 'ram', intent: '列出 RAM 用户', expectedRef: 'ram.ListUsers', strategy: 'curated-command', commandKey: 'ram users' },
  { name: 'CAS certificates', product: 'cas', intent: '查看证书', expectedRef: 'cas.ListCert', strategy: 'curated-command', commandKey: 'cert list' },
  { name: 'CDN domains', product: 'cdn', intent: '列出 CDN 域名', expectedRef: 'cdn.DescribeUserDomains', strategy: 'curated-command', commandKey: 'cdn domains' },
  { name: 'SLS projects', product: 'sls', intent: '列出日志项目', expectedRef: 'sls.ListProject', strategy: 'curated-command', commandKey: 'logs projects' },
  { name: 'SLS logstores', product: 'sls', intent: '列出日志库', expectedRef: 'sls.ListLogStores', strategy: 'curated-command', commandKey: 'logs logstores' },
  { name: 'SLS index', product: 'sls', intent: '查看日志库索引', expectedRef: 'sls.GetIndex', strategy: 'curated-command', commandKey: 'logs index' },
  { name: 'FC aliases', product: 'fc', intent: '查看函数别名', expectedRef: 'fc.ListAliases', strategy: 'curated-command', commandKey: 'fn aliases' },
  { name: 'FC triggers', product: 'fc', intent: '查看函数触发器', expectedRef: 'fc.ListTriggers', strategy: 'curated-command', commandKey: 'fn triggers' },
  { name: 'FC layers', product: 'fc', intent: '查看函数层', expectedRef: 'fc.ListLayers', strategy: 'curated-command', commandKey: 'fn layers' },
  { name: 'FC concurrency', product: 'fc', intent: '查看函数并发配置', expectedRef: 'fc.ListConcurrencyConfigs', strategy: 'curated-command', commandKey: 'fn capacity' },
  { name: 'FC provision', product: 'fc', intent: '查看预留实例', expectedRef: 'fc.ListProvisionConfigs', strategy: 'curated-command', commandKey: 'fn capacity' },
  { name: 'FC scaling', product: 'fc', intent: '查看弹性伸缩配置', expectedRef: 'fc.ListScalingConfigs', strategy: 'curated-command', commandKey: 'fn capacity' },
  { name: 'FC instances', product: 'fc', intent: '查看函数执行实例', expectedRef: 'fc.ListInstances', strategy: 'curated-command', commandKey: 'fn instances' },
  { name: 'FC sessions', product: 'fc', intent: '查看函数显式会话', expectedRef: 'fc.ListSessions', strategy: 'curated-command', commandKey: 'fn sessions' },
  { name: 'FC VPC bindings', product: 'fc', intent: '查看函数 VPC 绑定', expectedRef: 'fc.ListVpcBindings', strategy: 'curated-command', commandKey: 'fn vpc-bindings' },
  { name: 'FC function tags', product: 'fc', intent: '查看函数资源标签', expectedRef: 'fc.ListTagResources', strategy: 'curated-command', commandKey: 'fn tags' },
  { name: 'RDS backups', product: 'rds', intent: '查看 RDS 备份', expectedRef: 'rds.DescribeBackups', strategy: 'curated-command', commandKey: 'db backups' },
  { name: 'RDS restore plan', product: 'rds', intent: '恢复 RDS 到新实例', expectedRef: 'rds.CloneDBInstance', strategy: 'curated-command', commandKey: 'db restore plan', action: 'create' },
  { name: 'RDS parameters', product: 'rds', intent: '查看 RDS 运行参数', expectedRef: 'rds.DescribeParameters', strategy: 'curated-command', commandKey: 'db parameters' },
  { name: 'RDS accounts', product: 'rds', intent: '查看 RDS 账号', expectedRef: 'rds.DescribeAccounts', strategy: 'curated-command', commandKey: 'db accounts' },
  { name: 'RDS databases', product: 'rds', intent: '查看 RDS 逻辑数据库', expectedRef: 'rds.DescribeDatabases', strategy: 'curated-command', commandKey: 'db databases' },
  { name: 'Redis backups', product: 'r-kvstore', intent: '查看 Redis 备份', expectedRef: 'r-kvstore.DescribeBackups', strategy: 'curated-command', commandKey: 'cache backups' },
  { name: 'Redis backup policy update', product: 'r-kvstore', intent: '设置 Redis 自动备份策略', expectedRef: 'r-kvstore.ModifyBackupPolicy', strategy: 'curated-command', commandKey: 'cache backup-policy apply', action: 'update' },
  { name: 'Redis parameters', product: 'r-kvstore', intent: '查看 Redis 运行参数', expectedRef: 'r-kvstore.DescribeParameters', strategy: 'curated-command', commandKey: 'cache parameters' },
  { name: 'Redis accounts', product: 'r-kvstore', intent: '查看 Redis 账号', expectedRef: 'r-kvstore.DescribeAccounts', strategy: 'curated-command', commandKey: 'cache accounts' },
  { name: 'Redis topology', product: 'r-kvstore', intent: '查看 Redis 集群节点拓扑', expectedRef: 'r-kvstore.DescribeClusterMemberInfo', strategy: 'curated-command', commandKey: 'cache topology' },
  { name: 'ACR instances', product: 'cr', intent: '列出 ACR 企业版实例', expectedRef: 'cr.ListInstance', strategy: 'curated-command', commandKey: 'acr instances' },
  { name: 'ACR namespaces', product: 'cr', intent: '列出 ACR 命名空间', expectedRef: 'cr.ListNamespace', strategy: 'curated-command', commandKey: 'acr namespaces' },
  { name: 'ACR repositories', product: 'cr', intent: '列出 ACR 镜像仓库', expectedRef: 'cr.ListRepository', strategy: 'curated-command', commandKey: 'acr repositories' },
  { name: 'ACR image tags', product: 'cr', intent: '列出 ACR 镜像标签', expectedRef: 'cr.ListRepoTag', strategy: 'curated-command', commandKey: 'acr tags' },
  { name: 'ACR image scan', product: 'cr', intent: '查看 ACR 镜像扫描漏洞', expectedRef: 'cr.ListRepoTagScanResult', strategy: 'curated-command', commandKey: 'acr scan' }
];

describe('Agent journey contract matrix', () => {
  it('keeps every journey discoverable through product and capability search', () => {
    const catalog = getCommandCatalog();
    expect(catalog.rootCommands).toContain('capability');

    for (const journey of JOURNEY_MATRIX) {
      const products = searchAlicloudProducts({ query: journey.product, limit: 5 });
      expect(products.products[0]?.directory, journey.name).toBe(journey.product);

      const capabilities = searchAlicloudCapabilities({
        product: journey.product,
        intent: journey.intent,
        action: journey.action || 'inspect',
        limit: 5
      });
      expect(capabilities.capabilities[0]?.shorthand, journey.name).toBe(journey.expectedRef);
      expect(capabilities.capabilities[0]?.describeCommand, journey.name).toBe(
        `licell capability describe ${journey.expectedRef} --output json`
      );
    }
  });

  it('keeps the execution decision explicit for curated and raw journeys', async () => {
    for (const journey of JOURNEY_MATRIX) {
      const result = await enrichDescribeForAgent(describeAlicloudCapability(journey.expectedRef));
      expect(result.execution.strategy, journey.name).toBe(journey.strategy);
      expect(result.execution.policy, journey.name).toBe('curated-first');
      expect(result.execution.fallback?.kind, journey.name).toBe('raw-api');
      if (journey.commandKey) {
        expect(result.execution.preferred, journey.name).toMatchObject({
          kind: 'curated-command',
          commandKey: journey.commandKey,
          helpCommand: `licell ${journey.commandKey} --help --output json`
        });
      } else {
        expect(result.execution.preferred.kind, journey.name).toBe('raw-api');
        if (result.execution.preferred.kind === 'raw-api') {
          expect(result.execution.preferred.previewCommand, journey.name).toContain('--output json');
        }
      }
    }
  }, 30_000);
});
