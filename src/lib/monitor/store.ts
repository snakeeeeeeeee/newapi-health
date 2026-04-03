import type {
  DashboardCheck,
  DashboardSummary,
  GroupFilterItem,
  HealthApiResponse,
  MonitorConfig,
  ProviderFilterItem,
} from "./types";
import { loadMonitorConfigs } from "./config";
import { runCheck } from "./checker";

const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT ?? "40");
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS ?? "60000");
const CHECK_CONCURRENCY = Number(process.env.CHECK_CONCURRENCY ?? "4");
const LIVE_POLL_INTERVAL_MS = Number(process.env.LIVE_POLL_INTERVAL_MS ?? "1500");

interface RuntimeState {
  historyById: Map<string, DashboardCheck["history"]>;
  latestById: Map<string, DashboardCheck>;
  runningPromise: Promise<void> | null;
  timer: NodeJS.Timeout | null;
}

function getRuntimeState(): RuntimeState {
  const globalState = globalThis as typeof globalThis & {
    __newApiHealthState?: RuntimeState;
  };

  if (!globalState.__newApiHealthState) {
    globalState.__newApiHealthState = {
      historyById: new Map(),
      latestById: new Map(),
      runningPromise: null,
      timer: null,
    };
  }

  return globalState.__newApiHealthState;
}

function pushHistory(
  state: RuntimeState,
  id: string,
  point: DashboardCheck["history"][number]
): DashboardCheck["history"] {
  const next = [...(state.historyById.get(id) ?? []), point].slice(-HISTORY_LIMIT);
  state.historyById.set(id, next);
  return next;
}

function computeHealthScore(history: DashboardCheck["history"]): number {
  if (history.length === 0) {
    return 0;
  }

  const successCount = history.filter((item) => item.status !== "failed").length;
  return Number(((successCount / history.length) * 100).toFixed(1));
}

function computeAverageLatency(history: DashboardCheck["history"]): number | null {
  const values = history
    .map((item) => item.latencyMs)
    .filter((item): item is number => typeof item === "number");

  if (values.length === 0) {
    return null;
  }

  return Math.round(values.reduce((sum, item) => sum + item, 0) / values.length);
}

function formatStatusLabel(status: DashboardCheck["status"]): DashboardCheck["statusLabel"] {
  if (status === "pending") {
    return "检测中";
  }
  if (status === "healthy") {
    return "运行正常";
  }
  if (status === "degraded") {
    return "响应较慢";
  }
  return "检测失败";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function ensureEntries(state: RuntimeState, configs: MonitorConfig[]): void {
  const allowedIds = new Set(configs.map((config) => config.id));

  for (const config of configs) {
    if (!state.latestById.has(config.id)) {
      state.latestById.set(config.id, {
        id: config.id,
        name: config.name,
        providerId: config.providerId,
        providerName: config.providerName,
        groupId: config.groupId,
        groupName: config.groupName,
        endpoint: `${config.baseUrl}${config.endpoint}`,
        model: config.model,
        description: config.description ?? null,
        status: "pending",
        statusLabel: formatStatusLabel("pending"),
        latencyMs: null,
        pingLatencyMs: null,
        averageLatencyMs: computeAverageLatency(state.historyById.get(config.id) ?? []),
        healthScore: computeHealthScore(state.historyById.get(config.id) ?? []),
        checkedAt: null,
        message: "等待检测结果...",
        history: state.historyById.get(config.id) ?? [],
      });
    }
  }

  for (const id of [...state.latestById.keys()]) {
    if (!allowedIds.has(id)) {
      state.latestById.delete(id);
      state.historyById.delete(id);
    }
  }
}

async function refreshInternal(): Promise<void> {
  const state = getRuntimeState();
  const configs = await loadMonitorConfigs();
  ensureEntries(state, configs);

  await mapWithConcurrency(configs, CHECK_CONCURRENCY, async (config) => {
    const result = await runCheck(config);
    const history = pushHistory(state, config.id, {
      status: result.status,
      latencyMs: result.latencyMs,
      pingLatencyMs: result.pingLatencyMs,
      checkedAt: result.checkedAt,
      message: result.message,
    });

    state.latestById.set(config.id, {
      id: config.id,
      name: config.name,
      providerId: config.providerId,
      providerName: config.providerName,
      groupId: config.groupId,
      groupName: config.groupName,
      endpoint: `${config.baseUrl}${config.endpoint}`,
      model: config.model,
      description: config.description ?? null,
      status: result.status,
      statusLabel: formatStatusLabel(result.status),
      latencyMs: result.latencyMs,
      pingLatencyMs: result.pingLatencyMs,
      averageLatencyMs: computeAverageLatency(history),
      healthScore: computeHealthScore(history),
      checkedAt: result.checkedAt,
      message: result.message,
      history,
    });

    return result;
  });
}

export function ensureMonitorLoopStarted(): void {
  const state = getRuntimeState();
  if (state.timer) {
    return;
  }

  state.timer = setInterval(() => {
    void refreshHealthData();
  }, REFRESH_INTERVAL_MS);
}

export async function refreshHealthData(): Promise<void> {
  const state = getRuntimeState();
  if (state.runningPromise) {
    return state.runningPromise;
  }

  state.runningPromise = refreshInternal().finally(() => {
    state.runningPromise = null;
  });

  return state.runningPromise;
}

function computeSummary(checks: DashboardCheck[]): DashboardSummary {
  const pendingChecks = checks.filter((item) => item.status === "pending").length;
  const healthyChecks = checks.filter((item) => item.status === "healthy").length;
  const degradedChecks = checks.filter((item) => item.status === "degraded").length;
  const failedChecks = checks.filter((item) => item.status === "failed").length;
  const averageLatencySource = checks
    .map((item) => item.latencyMs)
    .filter((item): item is number => typeof item === "number");
  const averageLatencyMs =
    averageLatencySource.length > 0
      ? Math.round(
          averageLatencySource.reduce((sum, item) => sum + item, 0) /
            averageLatencySource.length
        )
      : null;
  const overallHealthScore =
    checks.length > 0
      ? Number(
          (
            checks.reduce((sum, item) => sum + item.healthScore, 0) / checks.length
          ).toFixed(1)
        )
      : 0;
  const lastUpdatedAt =
    checks
      .map((item) => item.checkedAt)
      .filter((item): item is string => Boolean(item))
      .sort()
      .at(-1) ?? null;

  return {
    totalChecks: checks.length,
    pendingChecks,
    healthyChecks,
    degradedChecks,
    failedChecks,
    overallHealthScore,
    averageLatencyMs,
    lastUpdatedAt,
  };
}

function computeProviders(checks: DashboardCheck[]): ProviderFilterItem[] {
  const map = new Map<string, ProviderFilterItem>();

  for (const check of checks) {
    const current = map.get(check.providerId);
    if (current) {
      current.count += 1;
      continue;
    }

    map.set(check.providerId, {
      id: check.providerId,
      name: check.providerName,
      count: 1,
    });
  }

  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function computeGroups(checks: DashboardCheck[]): GroupFilterItem[] {
  const map = new Map<string, GroupFilterItem>();

  for (const check of checks) {
    const key = `${check.providerId}:${check.groupId}`;
    const current = map.get(key);
    if (current) {
      current.count += 1;
      continue;
    }

    map.set(key, {
      id: check.groupId,
      name: check.groupName,
      providerId: check.providerId,
      count: 1,
    });
  }

  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function getHealthSnapshot(): Promise<HealthApiResponse> {
  ensureMonitorLoopStarted();
  const state = getRuntimeState();

  if (state.latestById.size === 0) {
    const configs = await loadMonitorConfigs();
    ensureEntries(state, configs);
    void refreshHealthData();
  }

  const checks = [...state.latestById.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  return {
    summary: computeSummary(checks),
    providers: computeProviders(checks),
    groups: computeGroups(checks),
    checks,
    refreshing: Boolean(state.runningPromise),
    historyWindow: {
      size: HISTORY_LIMIT,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      livePollIntervalMs: LIVE_POLL_INTERVAL_MS,
    },
  };
}
