import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  MonitorConfig,
  MonitorConfigDocument,
  MonitorGroupConfigInput,
  MonitorModelConfigInput,
  MonitorModelDefaultsInput,
  MonitorProviderConfigInput,
} from "./types";

const CONFIG_PATH = path.join(process.cwd(), "config", "checks.json");

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter(
    ([key, headerValue]) => isNonEmptyString(key) && isNonEmptyString(headerValue)
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeDefaults(value: unknown): MonitorModelDefaultsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const row = value as Record<string, unknown>;
  return {
    name: isNonEmptyString(row.name) ? row.name.trim() : undefined,
    model: isNonEmptyString(row.model) ? row.model.trim() : undefined,
    baseUrl: isNonEmptyString(row.baseUrl) ? row.baseUrl.trim().replace(/\/+$/, "") : undefined,
    apiKey: isNonEmptyString(row.apiKey) ? row.apiKey.trim() : undefined,
    endpoint: isNonEmptyString(row.endpoint) ? row.endpoint.trim() : undefined,
    description: isNonEmptyString(row.description) ? row.description.trim() : undefined,
    enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
    headers: normalizeHeaders(row.headers),
    cliMode: typeof row.cliMode === "boolean" ? row.cliMode : undefined,
    checkMode: row.checkMode === "list" || row.checkMode === "real" ? row.checkMode : undefined,
  };
}

function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged = Object.assign({}, ...sources.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeModelInput(input: unknown): { id: string } & MonitorModelDefaultsInput | null {
  if (isNonEmptyString(input)) {
    return { id: input.trim() };
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const row = input as Record<string, unknown>;
  if (!isNonEmptyString(row.id)) {
    return null;
  }

  const defaults = normalizeDefaults(row);
  return {
    id: row.id.trim(),
    ...defaults,
  };
}

function normalizeModel(
  provider: MonitorProviderConfigInput,
  group: MonitorGroupConfigInput,
  providerDefaults: MonitorModelDefaultsInput,
  groupDefaults: MonitorModelDefaultsInput,
  input: unknown
): MonitorConfig | null {
  const row = normalizeModelInput(input);
  if (!row) {
    return null;
  }

  const baseUrl = row.baseUrl ?? groupDefaults.baseUrl ?? providerDefaults.baseUrl;
  const apiKey = row.apiKey ?? groupDefaults.apiKey ?? providerDefaults.apiKey;
  const endpoint = row.endpoint ?? groupDefaults.endpoint ?? providerDefaults.endpoint;
  const model = row.model ?? groupDefaults.model ?? providerDefaults.model ?? row.id;

  if (
    !isNonEmptyString(baseUrl) ||
    !isNonEmptyString(apiKey) ||
    !isNonEmptyString(endpoint) ||
    !isNonEmptyString(model)
  ) {
    return null;
  }

  const name =
    row.name ??
    groupDefaults.name ??
    providerDefaults.name ??
    row.id;

  const enabled = row.enabled ?? groupDefaults.enabled ?? providerDefaults.enabled ?? true;
  const description = row.description ?? groupDefaults.description ?? providerDefaults.description;
  const headers = mergeHeaders(providerDefaults.headers, groupDefaults.headers, row.headers);
  const cliMode = row.cliMode ?? groupDefaults.cliMode ?? providerDefaults.cliMode ?? false;
  const checkMode = row.checkMode ?? groupDefaults.checkMode ?? providerDefaults.checkMode ?? "real";

  return {
    id: `${provider.id.trim()}__${group.id.trim()}__${row.id.trim()}`,
    name,
    providerId: provider.id,
    providerName: provider.name ?? provider.id,
    groupId: group.id,
    groupName: group.name ?? group.id,
    baseUrl,
    apiKey,
    endpoint,
    model,
    description,
    enabled,
    headers,
    cliMode,
    checkMode,
  };
}

function normalizeProvider(input: unknown): MonitorProviderConfigInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const row = input as Record<string, unknown>;
  if (!isNonEmptyString(row.id) || !Array.isArray(row.groups)) {
    return null;
  }

  return {
    id: row.id.trim(),
    name: isNonEmptyString(row.name) ? row.name.trim() : undefined,
    description: isNonEmptyString(row.description) ? row.description.trim() : undefined,
    defaults: normalizeDefaults(row.defaults),
    groups: row.groups
      .map((group): MonitorGroupConfigInput | null => {
        if (!group || typeof group !== "object" || Array.isArray(group)) {
          return null;
        }

        const groupRow = group as Record<string, unknown>;
        if (!isNonEmptyString(groupRow.id) || !Array.isArray(groupRow.models)) {
          return null;
        }

        return {
          id: groupRow.id.trim(),
          name: isNonEmptyString(groupRow.name) ? groupRow.name.trim() : undefined,
          description: isNonEmptyString(groupRow.description)
            ? groupRow.description.trim()
            : undefined,
          defaults: normalizeDefaults(groupRow.defaults),
          models: groupRow.models.filter((item) => Boolean(item)) as MonitorModelConfigInput[],
        };
      })
      .filter((group): group is MonitorGroupConfigInput => Boolean(group)),
  };
}

function flattenProviders(document: MonitorConfigDocument): MonitorConfig[] {
  return document.providers.flatMap((provider) => {
    const providerDefaults = provider.defaults ?? {};

    return provider.groups.flatMap((group) => {
      const groupDefaults = group.defaults ?? {};

      return group.models
        .map((model) =>
          normalizeModel(provider, group, providerDefaults, groupDefaults, model)
        )
        .filter((item): item is MonitorConfig => Boolean(item))
        .filter((item) => item.enabled);
    });
  });
}

function isLegacyArrayConfig(parsed: unknown): parsed is MonitorModelConfigInput[] {
  return Array.isArray(parsed);
}

export async function loadMonitorConfigs(): Promise<MonitorConfig[]> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (isLegacyArrayConfig(parsed)) {
    const fallbackProvider: MonitorProviderConfigInput = {
      id: "default",
      groups: [
        {
          id: "default",
          models: parsed,
        },
      ],
    };

    return flattenProviders({ providers: [fallbackProvider] });
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).providers)
  ) {
    throw new Error("config/checks.json must be an object with a providers array.");
  }

  const providerRows = (parsed as { providers: unknown[] }).providers;
  const document: MonitorConfigDocument = {
    providers: providerRows
      .map(normalizeProvider)
      .filter((item): item is MonitorProviderConfigInput => Boolean(item)),
  };

  return flattenProviders(document);
}
