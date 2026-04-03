"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, Clock, RefreshCcw, Server, ShieldCheck, Zap } from "lucide-react";
import { Anthropic, Gemini, OpenAI } from "@lobehub/icons";

import type {
  DashboardCheck,
  GroupFilterItem,
  HealthApiResponse,
  ProviderFilterItem,
} from "@/lib/monitor/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function getDashboardApiPath(): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim();
  if (!basePath) {
    return "/api/dashboard";
  }

  const normalized = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return `${normalized.replace(/\/$/, "")}/api/dashboard`;
}

function ProviderIcon({ providerId, size = 18 }: { providerId: string; size?: number }) {
  const id = providerId.toLowerCase();
  if (id.includes("openai")) return <OpenAI size={size} />;
  if (id.includes("anthropic") || id.includes("claude")) return <Anthropic size={size} />;
  if (id.includes("gemini") || id.includes("google")) return <Gemini size={size} />;
  return null;
}

function statusDotClass(status: DashboardCheck["status"]): string {
  if (status === "pending") return "bg-zinc-400";
  if (status === "healthy") return "bg-emerald-500";
  if (status === "degraded") return "bg-amber-500";
  return "bg-rose-500";
}

function statusBadgeClass(status: DashboardCheck["status"]): string {
  if (status === "pending") return "bg-zinc-500/10 text-zinc-500 ring-zinc-500/20";
  if (status === "healthy") return "bg-emerald-500/10 text-emerald-500 ring-emerald-500/20";
  if (status === "degraded") return "bg-amber-500/10 text-amber-500 ring-amber-500/20";
  return "bg-rose-500/10 text-rose-500 ring-rose-500/20";
}

function formatLatency(ms: number | null): string {
  return ms === null ? "—" : `${ms} ms`;
}

function relativeTime(value: string | null): string {
  if (!value) return "尚未检测";
  const diff = Date.now() - new Date(value).getTime();
  const s = Math.max(1, Math.round(diff / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.round(h / 24)}d 前`;
}

// ── decorative corner plus ────────────────────────────────────────────────────

function CornerPlus({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      className={`absolute h-4 w-4 text-[color:var(--muted-foreground)]/40 ${className ?? ""}`}
    >
      <line x1="12" y1="0" x2="12" y2="24" />
      <line x1="0" y1="12" x2="24" y2="12" />
    </svg>
  );
}

// ── timeline bar ──────────────────────────────────────────────────────────────

function TimelineBar({ check }: { check: DashboardCheck }) {
  const SLOTS = 40;
  const points = check.history.slice(-SLOTS);
  const slots = Array.from({ length: SLOTS }, (_, i) => points[i] ?? null);
  const [tooltip, setTooltip] = useState<{ point: typeof points[0]; x: number; y: number } | null>(null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
        <span>History ({Math.min(points.length, SLOTS)}pts)</span>
      </div>
      <div className="relative h-7 w-full rounded-sm bg-[color:var(--muted)]/20">
        <div className="flex h-full w-full flex-row-reverse gap-[2px] p-[2px]">
          {slots.map((point, i) =>
            point ? (
              <div
                key={`${point.checkedAt}-${i}`}
                className={`flex-1 rounded-[1px] cursor-default transition-all duration-150 hover:opacity-80 hover:scale-y-110 ${statusDotClass(point.status)}`}
                onMouseEnter={(e) => setTooltip({ point, x: e.clientX, y: e.clientY })}
                onMouseMove={(e) => setTooltip((t) => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
                onMouseLeave={() => setTooltip(null)}
              />
            ) : (
              <div key={`empty-${i}`} className="flex-1 rounded-[1px] bg-[color:var(--muted)]/10" />
            )
          )}
        </div>
      </div>
      <div className="flex justify-between text-[9px] font-medium uppercase tracking-widest text-[color:var(--muted-foreground)]/50">
        <span>Past</span>
        <span>Now</span>
      </div>

      {/* Tooltip rendered into document.body to escape backdrop-filter stacking context */}
      {tooltip && typeof document !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] w-48 rounded-xl border border-[color:var(--border)]/50 bg-[color:var(--background)]/95 p-3 shadow-xl backdrop-blur-xl"
          style={{ left: tooltip.x + 12, top: tooltip.y - 120 }}
        >
          <div className="mb-2 flex items-center justify-between border-b border-[color:var(--border)]/30 pb-2">
            <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ${statusBadgeClass(tooltip.point.status)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(tooltip.point.status)}`} />
              {tooltip.point.status}
            </span>
            <span className="font-mono text-[9px] text-[color:var(--muted-foreground)]">
              {new Date(tooltip.point.checkedAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-[color:var(--muted-foreground)]">延迟</span>
              <span className="font-mono font-medium text-[color:var(--foreground)]">{formatLatency(tooltip.point.latencyMs)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[color:var(--muted-foreground)]">Ping</span>
              <span className="font-mono font-medium text-[color:var(--foreground)]">{formatLatency(tooltip.point.pingLatencyMs)}</span>
            </div>
          </div>
          {tooltip.point.message && (
            <p className="mt-2 truncate rounded bg-[color:var(--muted)]/30 px-1.5 py-1 text-[10px] text-[color:var(--muted-foreground)]">
              {tooltip.point.message}
            </p>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

// ── model card ────────────────────────────────────────────────────────────────

function ModelCard({ check }: { check: DashboardCheck }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-[color:var(--border)]/40 bg-[color:var(--background)]/40 backdrop-blur-xl transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:border-[color:var(--border)]">
      <CornerPlus className="left-2 top-2 opacity-0 transition-opacity group-hover:opacity-100" />
      <CornerPlus className="right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100" />

      <div className="flex-1 p-4 sm:p-5">
        {/* Header row */}
        <div className="mb-4 flex items-start gap-3">
          {/* Provider icon */}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[color:var(--background)] to-[color:var(--muted)]/40 shadow-sm ring-1 ring-[color:var(--border)]/60 transition-transform group-hover:scale-105">
            <ProviderIcon providerId={check.providerId} size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex-1 truncate text-base font-bold leading-none tracking-tight text-[color:var(--foreground)] sm:text-lg">
                {check.name}
              </h3>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${statusBadgeClass(check.status)}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(check.status)}`} />
                {check.statusLabel}
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[color:var(--muted-foreground)]">
              <span className="inline-flex items-center rounded-md bg-[color:var(--muted)]/50 px-1.5 py-0.5 font-medium">
                {check.providerName}
              </span>
              <span className="inline-flex items-center rounded-md bg-[color:var(--muted)]/50 px-1.5 py-0.5 font-medium">
                {check.groupName}
              </span>
              <span className="break-all font-mono opacity-60">{check.model}</span>
            </div>
          </div>
        </div>

        {/* Metrics */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-[color:var(--muted)]/30 p-3 transition-colors group-hover:bg-[color:var(--muted)]/50">
            <div className="flex items-center gap-2 text-[color:var(--muted-foreground)]">
              <Zap className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">对话延迟</span>
            </div>
            <div className="mt-1 font-mono text-lg font-medium leading-none text-[color:var(--foreground)]">
              {formatLatency(check.latencyMs)}
            </div>
          </div>

          <div className="rounded-xl bg-[color:var(--muted)]/30 p-3 transition-colors group-hover:bg-[color:var(--muted)]/50">
            <div className="flex items-center gap-2 text-[color:var(--muted-foreground)]">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">平均延迟</span>
            </div>
            <div className="mt-1 font-mono text-lg font-medium leading-none text-[color:var(--foreground)]">
              {formatLatency(check.averageLatencyMs)}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center justify-between border-t border-[color:var(--border)]/30 pt-3 text-xs text-[color:var(--muted-foreground)]">
          <span>健康度：<span className="font-mono font-semibold text-[color:var(--foreground)]">{check.healthScore}%</span></span>
          <span>上次：<span className="font-medium text-[color:var(--foreground)]">{relativeTime(check.checkedAt)}</span></span>
        </div>

        {check.message ? (
          <p className="mt-2 truncate text-[11px] text-[color:var(--muted-foreground)]/70">{check.message}</p>
        ) : null}
      </div>

      {/* Timeline */}
      <div className="border-t border-[color:var(--border)]/40 bg-[color:var(--muted)]/10 px-5 py-4">
        <TimelineBar check={check} />
      </div>
    </article>
  );
}

// ── empty / loading ───────────────────────────────────────────────────────────

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-[color:var(--border)] bg-[color:var(--background)]/40 px-8 py-20 text-center backdrop-blur-xl">
      <Activity className="h-10 w-10 text-[color:var(--muted-foreground)]/40" />
      <h2 className="mt-4 text-lg font-semibold text-[color:var(--foreground)]">{title}</h2>
      <p className="mt-2 max-w-sm text-sm text-[color:var(--muted-foreground)]">{description}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-2xl border border-[color:var(--border)]/40 bg-[color:var(--background)]/40 px-8 py-20 text-center backdrop-blur-xl">
      <RefreshCcw className="h-8 w-8 animate-spin text-[color:var(--muted-foreground)]/60" />
      <p className="mt-4 text-sm text-[color:var(--muted-foreground)]">正在拉取最新检测结果...</p>
    </div>
  );
}

// ── filter buttons ────────────────────────────────────────────────────────────

function FilterButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition-all duration-200 ${
        active
          ? "bg-[color:var(--foreground)] text-[color:var(--background)] shadow-sm"
          : "border border-[color:var(--border)]/60 bg-[color:var(--background)]/60 text-[color:var(--muted-foreground)] hover:border-[color:var(--border)] hover:text-[color:var(--foreground)]"
      }`}
    >
      <span>{label}</span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-xs font-semibold ${
          active ? "bg-[color:var(--background)]/20 text-[color:var(--background)]" : "bg-[color:var(--muted)]/60"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// ── stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--border)]/50 bg-[color:var(--background)]/60 p-4 backdrop-blur-sm">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[color:var(--muted)]/60 text-[color:var(--muted-foreground)]">
        {icon}
      </div>
      <div>
        <div className="font-mono text-2xl font-semibold leading-none tracking-tight text-[color:var(--foreground)]">
          {value}
        </div>
        <div className="mt-1 text-xs text-[color:var(--muted-foreground)]">{label}</div>
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function DashboardClient() {
  const [data, setData] = useState<HealthApiResponse | null>(null);
  const [activeProviderId, setActiveProviderId] = useState<string>("all");
  const [activeGroupId, setActiveGroupId] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggleTheme() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.style.colorScheme = next ? "dark" : "light";
  }

  async function load() {
    try {
      const response = await fetch(getDashboardApiPath(), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as HealthApiResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "数据加载失败");
    }
  }

  useEffect(() => { void load(); }, []);

  const refreshIntervalMs = data?.historyWindow.refreshIntervalMs ?? null;
  const livePollIntervalMs = data?.historyWindow.livePollIntervalMs ?? 1500;

  useEffect(() => {
    const interval = data?.refreshing ? livePollIntervalMs : refreshIntervalMs;
    if (!interval) return;
    const timer = window.setInterval(() => { void load(); }, interval);
    return () => window.clearInterval(timer);
  }, [data?.refreshing, livePollIntervalMs, refreshIntervalMs]);

  const providers = data?.providers ?? [];

  useEffect(() => {
    if (!data) return;
    if (activeProviderId !== "all" && !data.providers.some((p) => p.id === activeProviderId)) {
      setActiveProviderId("all");
    }
  }, [activeProviderId, data]);

  const visibleGroups = useMemo((): GroupFilterItem[] => {
    if (!data) return [];
    return data.groups.filter((g) => activeProviderId === "all" || g.providerId === activeProviderId);
  }, [activeProviderId, data]);

  useEffect(() => {
    if (activeGroupId !== "all" && !visibleGroups.some((g) => g.id === activeGroupId)) {
      setActiveGroupId("all");
    }
  }, [activeGroupId, visibleGroups]);

  const filteredChecks = useMemo((): DashboardCheck[] => {
    if (!data) return [];
    return data.checks.filter((c) => {
      const providerMatch = activeProviderId === "all" || c.providerId === activeProviderId;
      const groupMatch = activeGroupId === "all" || c.groupId === activeGroupId;
      return providerMatch && groupMatch;
    });
  }, [activeGroupId, activeProviderId, data]);

  const activeProvider: ProviderFilterItem | null =
    activeProviderId === "all" ? null : providers.find((p) => p.id === activeProviderId) ?? null;

  const activeGroup = useMemo(
    () => visibleGroups.find((g) => g.id === activeGroupId) ?? null,
    [activeGroupId, visibleGroups]
  );

  const filteredSummary = useMemo(() => {
    if (filteredChecks.length === 0) return { overallHealthScore: 0, averageLatencyMs: null as number | null };
    const overallHealthScore = Number(
      (filteredChecks.reduce((sum, c) => sum + c.healthScore, 0) / filteredChecks.length).toFixed(1)
    );
    const latencies = filteredChecks.map((c) => c.latencyMs).filter((v): v is number => typeof v === "number");
    const averageLatencyMs = latencies.length > 0
      ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
      : null;
    return { overallHealthScore, averageLatencyMs };
  }, [filteredChecks]);

  const workspaceTitle = activeGroup
    ? activeGroup.name
    : activeProvider
    ? `${activeProvider.name} · 全部分组`
    : "全部模型";

  return (
    <div className="mx-auto min-h-screen w-full max-w-[1600px] px-4 py-8 sm:px-6 lg:px-10">

      {/* ── Header ── */}
      <header className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[color:var(--border)]/50 bg-[color:var(--background)]/60 backdrop-blur-sm">
              <Activity className="h-4 w-4 text-[color:var(--foreground)]" />
            </div>
            <span className="text-sm font-semibold uppercase tracking-widest text-[color:var(--muted-foreground)]">
              System Status
            </span>
            <button
              type="button"
              onClick={toggleTheme}
              title={isDark ? "切换白天模式" : "切换夜间模式"}
              className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl border border-[color:var(--border)]/50 bg-[color:var(--background)]/60 text-[color:var(--muted-foreground)] backdrop-blur-sm transition-colors hover:border-[color:var(--border)] hover:text-[color:var(--foreground)] lg:hidden"
            >
              {isDark ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
              )}
            </button>
          </div>
          <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight text-[color:var(--foreground)] sm:text-4xl md:text-5xl">
            AI MODEL<br className="sm:hidden" /> HEALTH MONITOR
          </h1>
          <p className="mt-2 max-w-lg text-sm text-[color:var(--muted-foreground)]">
            实时检测模型接口的可用性、响应延迟与历史健康状态。
          </p>
        </div>

        {/* Stats */}
        <div className="flex items-start gap-3">
          <div className="grid grid-cols-3 gap-3 lg:min-w-[400px]">
            <StatCard
              icon={<ShieldCheck className="h-4 w-4" />}
              value={`${filteredSummary.overallHealthScore}%`}
              label="整体健康度"
            />
            <StatCard
              icon={<Server className="h-4 w-4" />}
              value={String(filteredChecks.length)}
              label="当前模型数"
            />
            <StatCard
              icon={<Zap className="h-4 w-4" />}
              value={formatLatency(filteredSummary.averageLatencyMs)}
              label="平均延迟"
            />
          </div>
          {/* Theme toggle — desktop */}
          <button
            type="button"
            onClick={toggleTheme}
            title={isDark ? "切换白天模式" : "切换夜间模式"}
            className="hidden lg:flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[color:var(--border)]/50 bg-[color:var(--background)]/60 text-[color:var(--muted-foreground)] backdrop-blur-sm transition-colors hover:border-[color:var(--border)] hover:text-[color:var(--foreground)]"
          >
            {isDark ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            )}
          </button>
        </div>
      </header>

      {/* ── Filters ── */}
      <div className="mb-6 space-y-3 rounded-2xl border border-[color:var(--border)]/40 bg-[color:var(--background)]/60 p-4 backdrop-blur-sm">
        {/* Provider row */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)] mr-1">供应商</span>
          <FilterButton
            label="全部"
            count={data?.summary.totalChecks ?? 0}
            active={activeProviderId === "all"}
            onClick={() => setActiveProviderId("all")}
          />
          {providers.map((p) => (
            <FilterButton
              key={p.id}
              label={p.name}
              count={p.count}
              active={activeProviderId === p.id}
              onClick={() => setActiveProviderId(p.id)}
            />
          ))}
        </div>

        {/* Group row */}
        {visibleGroups.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--border)]/30 pt-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)] mr-1">分组</span>
            <FilterButton
              label="全部"
              count={activeProvider ? activeProvider.count : data?.summary.totalChecks ?? 0}
              active={activeGroupId === "all"}
              onClick={() => setActiveGroupId("all")}
            />
            {visibleGroups.map((g) => (
              <FilterButton
                key={`${g.providerId}:${g.id}`}
                label={g.name}
                count={g.count}
                active={activeGroupId === g.id}
                onClick={() => setActiveGroupId(g.id)}
              />
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-500">
            {error}
          </div>
        )}
      </div>

      {/* ── Workspace label ── */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">Workspace</p>
          <h2 className="mt-0.5 text-xl font-bold tracking-tight text-[color:var(--foreground)]">{workspaceTitle}</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--border)]/50 bg-[color:var(--background)]/60 px-3 py-1.5 text-xs text-[color:var(--muted-foreground)] backdrop-blur-sm">
          <Server className="h-3 w-3" />
          {filteredChecks.length} 个模型
        </span>
      </div>

      {/* ── Grid ── */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!data && !error ? (
          <LoadingState />
        ) : null}
        {data && data.summary.totalChecks === 0 ? (
          <EmptyState
            title="尚无监控目标"
            description="请把配置改成 provider → group → model 的三级结构，然后刷新页面。"
          />
        ) : null}
        {data && filteredChecks.length === 0 && data.summary.totalChecks > 0 ? (
          <EmptyState
            title="当前筛选下没有模型"
            description="换一个供应商或分组试试。"
          />
        ) : null}
        {filteredChecks.map((check) => (
          <ModelCard key={check.id} check={check} />
        ))}
      </section>
    </div>
  );
}
