export type MonitorStatus = "pending" | "healthy" | "degraded" | "failed";

export interface MonitorModelConfigInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  endpoint: string;
  model: string;
  description?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  cliMode?: boolean;
}

export interface MonitorGroupConfigInput {
  id: string;
  name: string;
  description?: string;
  models: MonitorModelConfigInput[];
}

export interface MonitorProviderConfigInput {
  id: string;
  name: string;
  description?: string;
  groups: MonitorGroupConfigInput[];
}

export interface MonitorConfigDocument {
  providers: MonitorProviderConfigInput[];
}

export interface MonitorConfig {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  groupId: string;
  groupName: string;
  baseUrl: string;
  apiKey: string;
  endpoint: string;
  model: string;
  description?: string;
  enabled: boolean;
  headers?: Record<string, string>;
  cliMode?: boolean;
}

export interface CheckResult {
  id: string;
  status: MonitorStatus;
  latencyMs: number | null;
  pingLatencyMs: number | null;
  checkedAt: string;
  message: string;
}

export interface CheckHistoryPoint {
  status: MonitorStatus;
  latencyMs: number | null;
  pingLatencyMs: number | null;
  checkedAt: string;
  message: string;
}

export interface DashboardCheck {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  groupId: string;
  groupName: string;
  endpoint: string;
  model: string;
  description: string | null;
  status: MonitorStatus;
  statusLabel: string;
  latencyMs: number | null;
  pingLatencyMs: number | null;
  averageLatencyMs: number | null;
  healthScore: number;
  checkedAt: string | null;
  message: string;
  history: CheckHistoryPoint[];
}

export interface ProviderFilterItem {
  id: string;
  name: string;
  count: number;
}

export interface GroupFilterItem {
  id: string;
  name: string;
  providerId: string;
  count: number;
}

export interface DashboardSummary {
  totalChecks: number;
  pendingChecks: number;
  healthyChecks: number;
  degradedChecks: number;
  failedChecks: number;
  overallHealthScore: number;
  averageLatencyMs: number | null;
  lastUpdatedAt: string | null;
}

export interface HealthApiResponse {
  summary: DashboardSummary;
  providers: ProviderFilterItem[];
  groups: GroupFilterItem[];
  checks: DashboardCheck[];
  refreshing: boolean;
  historyWindow: {
    size: number;
    refreshIntervalMs: number;
    livePollIntervalMs: number;
  };
}
