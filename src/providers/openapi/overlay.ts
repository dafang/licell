import type { GeneratedCapability } from '../../utils/alicloud-capability-generator';

export interface AlicloudCapabilityOverlay {
  product: string;
  operation: string;
  commandKeys: string[];
  confidence: 'curated';
  notes: string[];
}

// This registry is intentionally small and reviewed by hand. It describes
// exact operation coverage; heuristic command matching remains the fallback
// for capabilities that have not been promoted into a curated surface.
const OVERLAYS: AlicloudCapabilityOverlay[] = [
  {
    product: 'vpc',
    operation: 'DescribeVpcs',
    commandKeys: ['vpc list', 'vpc info', 'vpc topology'],
    confidence: 'curated',
    notes: ['vpc list and info project VPC inventory; vpc topology adds related core network resources.']
  },
  {
    product: 'vpc',
    operation: 'DescribeVSwitches',
    commandKeys: ['vpc topology'],
    confidence: 'curated',
    notes: ['vpc topology inventories VSwitches for the selected VPC.']
  },
  {
    product: 'vpc',
    operation: 'DescribeRouteTables',
    commandKeys: ['vpc topology'],
    confidence: 'curated',
    notes: ['vpc topology inventories route tables for the selected VPC router.']
  },
  {
    product: 'vpc',
    operation: 'DescribeNatGateways',
    commandKeys: ['vpc topology'],
    confidence: 'curated',
    notes: ['vpc topology inventories NAT gateways for the selected VPC.']
  },
  {
    product: 'vpc',
    operation: 'DescribeEipAddresses',
    commandKeys: ['vpc topology'],
    confidence: 'curated',
    notes: ['vpc topology filters EIPs associated with the selected VPC or its NAT gateways.']
  },
  {
    product: 'vpc',
    operation: 'ModifyVpcAttribute',
    commandKeys: ['vpc config apply'],
    confidence: 'curated',
    notes: ['vpc config apply manages VPC name and description through desired-state planning, confirmation, one mutation call, and read-back verification.']
  },
  {
    product: 'cs',
    operation: 'DescribeClusters',
    commandKeys: ['k8s clusters'],
    confidence: 'curated',
    notes: ['k8s clusters lists ACK and ACS clusters through the CS read API.']
  },
  {
    product: 'cs',
    operation: 'DescribeClustersV1',
    commandKeys: ['k8s clusters'],
    confidence: 'curated',
    notes: ['k8s clusters provides the curated cluster inventory surface.']
  },
  {
    product: 'cs',
    operation: 'DescribeClusterUserKubeconfig',
    commandKeys: ['k8s workloads'],
    confidence: 'curated',
    notes: ['k8s workloads consumes a 15-minute KubeConfig internally and never returns the credential.']
  },
  {
    product: 'ecs',
    operation: 'DescribeInstances',
    commandKeys: ['ecs list', 'ecs info'],
    confidence: 'curated',
    notes: ['ecs list maps filters to DescribeInstances.', 'ecs info projects a single instance summary.']
  },
  {
    product: 'fc',
    operation: 'ListFunctions',
    commandKeys: ['fn list'],
    confidence: 'curated',
    notes: ['fn list reads the FC function inventory.']
  },
  {
    product: 'fc-open',
    operation: 'ListFunctions',
    commandKeys: ['fn list'],
    confidence: 'curated',
    notes: ['fn list reads the FC function inventory.']
  },
  {
    product: 'rds',
    operation: 'DescribeDBInstances',
    commandKeys: ['db list', 'db info'],
    confidence: 'curated',
    notes: ['db list and db info use the RDS instance query provider.']
  },
  {
    product: 'rds',
    operation: 'ModifyDBInstanceDescription',
    commandKeys: ['db config apply'],
    confidence: 'curated',
    notes: ['db config apply plans, confirms, updates, and verifies the RDS instance description through a guarded desired-state workflow.']
  },
  {
    product: 'rds',
    operation: 'CloneDBInstance',
    commandKeys: ['db restore plan'],
    confidence: 'curated',
    notes: ['db restore plan validates a backup set or PITR window and builds a request draft; it never calls CloneDBInstance.']
  },
  {
    product: 'rds',
    operation: 'DescribeLocalAvailableRecoveryTime',
    commandKeys: ['db restore plan'],
    confidence: 'curated',
    notes: ['db restore plan reads the local PITR window for supported database engines.']
  },
  {
    product: 'r-kvstore',
    operation: 'DescribeInstances',
    commandKeys: ['cache list', 'cache info'],
    confidence: 'curated',
    notes: ['cache list and cache info use the Redis/Tair query provider.']
  },
  {
    product: 'r-kvstore',
    operation: 'DescribeBackups',
    commandKeys: ['cache backups'],
    confidence: 'curated',
    notes: ['cache backups reads backup metadata without exposing signed public or intranet download URLs.']
  },
  {
    product: 'r-kvstore',
    operation: 'DescribeBackupPolicy',
    commandKeys: ['cache backups'],
    confidence: 'curated',
    notes: ['cache backups combines backup inventory with retention and schedule policy.']
  },
  {
    product: 'r-kvstore',
    operation: 'ModifyBackupPolicy',
    commandKeys: ['cache backup-policy apply'],
    confidence: 'curated',
    notes: ['cache backup-policy apply plans, confirms, updates, and verifies the Redis/Tair automatic backup policy.']
  },
  {
    product: 'r-kvstore',
    operation: 'DescribeParameters',
    commandKeys: ['cache parameters'],
    confidence: 'curated',
    notes: ['cache parameters reads classic Redis/Tair running and configured parameters.']
  },
  {
    product: 'r-kvstore',
    operation: 'DescribeInstanceConfig',
    commandKeys: ['cache parameters'],
    confidence: 'curated',
    notes: ['cache parameters automatically falls back to the cloud-native instance configuration API.']
  },
  {
    product: 'r-kvstore',
    operation: 'DescribeAccounts',
    commandKeys: ['cache accounts'],
    confidence: 'curated',
    notes: ['cache accounts reads account state and privilege summaries without credentials.']
  },
  {
    product: 'r-kvstore',
    operation: 'DescribeClusterMemberInfo',
    commandKeys: ['cache topology'],
    confidence: 'curated',
    notes: ['cache topology reads cloud-disk cluster member capacity and topology without user identifiers.']
  },
  {
    product: 'cr',
    operation: 'ListInstance',
    commandKeys: ['acr instances'],
    confidence: 'curated',
    notes: ['acr instances inventories Container Registry Enterprise Edition instances.']
  },
  {
    product: 'cr',
    operation: 'ListNamespace',
    commandKeys: ['acr namespaces'],
    confidence: 'curated',
    notes: ['acr namespaces reads Enterprise Edition namespace state and repository defaults.']
  },
  {
    product: 'cr',
    operation: 'ListRepository',
    commandKeys: ['acr repositories'],
    confidence: 'curated',
    notes: ['acr repositories exposes repository IDs required by downstream image inspection.']
  },
  {
    product: 'cr',
    operation: 'ListRepoTag',
    commandKeys: ['acr tags'],
    confidence: 'curated',
    notes: ['acr tags reads image tag, digest, size, status, and timestamps.']
  },
  {
    product: 'cr',
    operation: 'GetRepoTagScanStatus',
    commandKeys: ['acr scan'],
    confidence: 'curated',
    notes: ['acr scan reads the existing image scan status without creating a scan task.']
  },
  {
    product: 'cr',
    operation: 'GetRepoTagScanSummary',
    commandKeys: ['acr scan'],
    confidence: 'curated',
    notes: ['acr scan reads vulnerability severity totals for a completed image scan.']
  },
  {
    product: 'cr',
    operation: 'ListRepoTagScanResult',
    commandKeys: ['acr scan'],
    confidence: 'curated',
    notes: ['acr scan projects CVE and package remediation metadata without fix commands, filesystem paths, layer IDs, descriptions, or external links.']
  },
  {
    product: 'ram',
    operation: 'ListUsers',
    commandKeys: ['ram users'],
    confidence: 'curated',
    notes: ['ram users lists RAM user summaries without exposing credentials or contact fields.']
  },
  {
    product: 'cas',
    operation: 'ListCert',
    commandKeys: ['cert list'],
    confidence: 'curated',
    notes: ['cert list reads CAS certificate summaries through the protocol-backed runner without exposing certificate material.']
  },
  {
    product: 'cdn',
    operation: 'DescribeUserDomains',
    commandKeys: ['cdn domains'],
    confidence: 'curated',
    notes: ['cdn domains reads CDN domain, CNAME, status, certificate status and origin summaries through the protocol-backed runner.']
  },
  {
    product: 'sls',
    operation: 'ListProject',
    commandKeys: ['logs projects'],
    confidence: 'curated',
    notes: ['logs projects reads SLS project summaries through the protocol-backed runner; logs query remains the content inspection command.']
  },
  {
    product: 'sls',
    operation: 'ListLogStores',
    commandKeys: ['logs logstores'],
    confidence: 'curated',
    notes: ['logs logstores reads logstore summaries through the protocol-backed REST runner for a selected project.']
  },
  {
    product: 'sls',
    operation: 'GetIndex',
    commandKeys: ['logs index'],
    confidence: 'curated',
    notes: ['logs index reads a selected SLS logstore index definition for Agent query planning.']
  },
  {
    product: 'fc',
    operation: 'ListAliases',
    commandKeys: ['fn aliases'],
    confidence: 'curated',
    notes: ['fn aliases reads function alias to version routing summaries without mutating FC resources.']
  },
  {
    product: 'fc',
    operation: 'ListTriggers',
    commandKeys: ['fn triggers'],
    confidence: 'curated',
    notes: ['fn triggers reads safe function trigger summaries without exposing raw trigger configuration.']
  },
  {
    product: 'fc',
    operation: 'ListLayers',
    commandKeys: ['fn layers'],
    confidence: 'curated',
    notes: ['fn layers reads layer version and runtime compatibility summaries without downloading layer code.']
  },
  {
    product: 'fc',
    operation: 'ListConcurrencyConfigs',
    commandKeys: ['fn capacity'],
    confidence: 'curated',
    notes: ['fn capacity combines concurrency, provisioned instance, and scaling configuration summaries.']
  },
  {
    product: 'fc',
    operation: 'ListProvisionConfigs',
    commandKeys: ['fn capacity'],
    confidence: 'curated',
    notes: ['fn capacity combines concurrency, provisioned instance, and scaling configuration summaries.']
  },
  {
    product: 'fc',
    operation: 'ListScalingConfigs',
    commandKeys: ['fn capacity'],
    confidence: 'curated',
    notes: ['fn capacity combines concurrency, provisioned instance, and scaling configuration summaries.']
  },
  {
    product: 'fc',
    operation: 'ListInstances',
    commandKeys: ['fn instances'],
    confidence: 'curated',
    notes: ['fn instances reads function runtime instance status and lifecycle summaries.']
  },
  {
    product: 'fc',
    operation: 'ListSessions',
    commandKeys: ['fn sessions'],
    confidence: 'curated',
    notes: ['fn sessions reads explicit session lifecycle summaries without exposing mounted storage configuration.']
  },
  {
    product: 'fc',
    operation: 'ListVpcBindings',
    commandKeys: ['fn vpc-bindings'],
    confidence: 'curated',
    notes: ['fn vpc-bindings reads the VPC IDs accessible from a selected function.']
  },
  {
    product: 'fc',
    operation: 'ListTagResources',
    commandKeys: ['fn tags'],
    confidence: 'curated',
    notes: ['fn tags reads paginated FC function resource tags with optional function-name and tag filters.']
  },
  {
    product: 'rds',
    operation: 'DescribeBackups',
    commandKeys: ['db backups'],
    confidence: 'curated',
    notes: ['db backups reads backup set metadata without exposing signed download URLs or checksums.']
  },
  {
    product: 'rds',
    operation: 'DescribeBackupPolicy',
    commandKeys: ['db backups'],
    confidence: 'curated',
    notes: ['db backups combines backup inventory with retention, log backup, and PITR policy summaries.']
  },
  {
    product: 'rds',
    operation: 'DescribeParameters',
    commandKeys: ['db parameters'],
    confidence: 'curated',
    notes: ['db parameters separates running and configured RDS parameter values.']
  },
  {
    product: 'rds',
    operation: 'DescribeAccounts',
    commandKeys: ['db accounts'],
    confidence: 'curated',
    notes: ['db accounts reads account status and database privilege summaries without credentials.']
  },
  {
    product: 'rds',
    operation: 'DescribeDatabases',
    commandKeys: ['db databases'],
    confidence: 'curated',
    notes: ['db databases reads logical database metadata and grants without untyped advanced properties.']
  }
];

export function findAlicloudCapabilityOverlay(capability: Pick<GeneratedCapability, 'operation'> & {
  product: GeneratedCapability['product'] | { directory: string };
}) {
  const product = typeof capability.product === 'string'
    ? capability.product.toLowerCase()
    : capability.product.directory.toLowerCase();
  const operation = capability.operation.toLowerCase();
  return OVERLAYS.find((overlay) => overlay.product === product && overlay.operation.toLowerCase() === operation);
}

export function listAlicloudCapabilityOverlays() {
  return OVERLAYS.map((overlay) => ({ ...overlay, commandKeys: [...overlay.commandKeys], notes: [...overlay.notes] }));
}
