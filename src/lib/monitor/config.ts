import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  MonitorConfig,
  MonitorConfigDocument,
  MonitorGroupConfigInput,
  MonitorModelConfigInput,
  MonitorProviderConfigInput,
} from "./types";

const CONFIG_PATH = path.join(process.cwd(), "config", "checks.json");

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeModel(
  provider: MonitorProviderConfigInput,
  group: MonitorGroupConfigInput,
  input: unknown
): MonitorConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const row = input as Record<string, unknown>;
  if (
    !isNonEmptyString(row.id) ||
    !isNonEmptyString(row.name) ||
    !isNonEmptyString(row.baseUrl) ||
    !isNonEmptyString(row.apiKey) ||
    !isNonEmptyString(row.endpoint) ||
    !isNonEmptyString(row.model)
  ) {
    return null;
  }

  return {
    // Runtime id must be unique across the whole dashboard, even if the same
    // model identifier appears under multiple groups or providers.
    id: `${provider.id.trim()}__${group.id.trim()}__${row.id.trim()}`,
    name: row.name.trim(),
    providerId: provider.id,
    providerName: provider.name,
    groupId: group.id,
    groupName: group.name,
    baseUrl: row.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: row.apiKey.trim(),
    endpoint: row.endpoint.trim(),
    model: row.model.trim(),
    description: isNonEmptyString(row.description) ? row.description.trim() : undefined,
    enabled: typeof row.enabled === "boolean" ? row.enabled : true,
    headers: row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
      ? row.headers as Record<string, string>
      : undefined,
    cliMode: typeof row.cliMode === "boolean" ? row.cliMode : false,
  };
}

function normalizeProvider(input: unknown): MonitorProviderConfigInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const row = input as Record<string, unknown>;
  if (
    !isNonEmptyString(row.id) ||
    !isNonEmptyString(row.name) ||
    !Array.isArray(row.groups)
  ) {
    return null;
  }

  return {
    id: row.id.trim(),
    name: row.name.trim(),
    description: isNonEmptyString(row.description) ? row.description.trim() : undefined,
    groups: row.groups
      .map((group): MonitorGroupConfigInput | null => {
        if (!group || typeof group !== "object" || Array.isArray(group)) {
          return null;
        }

        const groupRow = group as Record<string, unknown>;
        if (
          !isNonEmptyString(groupRow.id) ||
          !isNonEmptyString(groupRow.name) ||
          !Array.isArray(groupRow.models)
        ) {
          return null;
        }

        return {
          id: groupRow.id.trim(),
          name: groupRow.name.trim(),
          description: isNonEmptyString(groupRow.description)
            ? groupRow.description.trim()
            : undefined,
          models: groupRow.models.filter(
            (item): item is MonitorModelConfigInput =>
              Boolean(item && typeof item === "object" && !Array.isArray(item))
          ),
        };
      })
      .filter((group): group is MonitorGroupConfigInput => Boolean(group)),
  };
}

function flattenProviders(document: MonitorConfigDocument): MonitorConfig[] {
  return document.providers.flatMap((provider) =>
    provider.groups.flatMap((group) =>
      group.models
        .map((model) => normalizeModel(provider, group, model))
        .filter((item): item is MonitorConfig => Boolean(item))
        .filter((item) => item.enabled)
    )
  );
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
      name: "Default",
      groups: [
        {
          id: "default",
          name: "default",
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
