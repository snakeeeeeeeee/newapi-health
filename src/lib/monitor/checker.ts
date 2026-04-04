import type { CheckResult, MonitorConfig, MonitorStatus } from "./types";

const REQUEST_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? "20000");
const DEGRADED_THRESHOLD_MS = Number(process.env.DEGRADED_THRESHOLD_MS ?? "4000");
const HEALTHY_TOKEN = "ok";
const ANTHROPIC_VERSION = "2023-06-01";

const CLI_HEADERS: Record<string, string> = {
  "User-Agent": "claude-cli/2.1.92 (external, cli)",
  "x-app": "cli",
  "anthropic-beta":
    "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24",
  "anthropic-dangerous-direct-browser-access": "true",
};

type RequestProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content";

function buildUrl(config: MonitorConfig): string {
  const endpoint = config.endpoint.replace("{model}", encodeURIComponent(config.model));
  const url = new URL(`${config.baseUrl}${endpoint}`);

  if (config.cliMode && detectProtocol(config) === "anthropic-messages") {
    url.searchParams.set("beta", "true");
  }

  return url.toString();
}

function detectProtocol(config: MonitorConfig): RequestProtocol {
  if (config.endpoint.endsWith("/v1/chat/completions")) {
    return "openai-chat";
  }

  if (config.endpoint.endsWith("/v1/responses")) {
    return "openai-responses";
  }

  if (config.endpoint.endsWith("/v1/messages")) {
    return "anthropic-messages";
  }

  if (/\/v\d+(?:beta)?\/models\/.+:(generateContent|streamGenerateContent)$/.test(config.endpoint)) {
    return "gemini-generate-content";
  }

  throw new Error(
    `Unsupported endpoint: ${config.endpoint}. Supported examples: /v1/chat/completions, /v1/responses, /v1/messages, /v1beta/models/{model}:generateContent`
  );
}

function buildHeaders(
  config: MonitorConfig,
  protocol: RequestProtocol
): Record<string, string> {
  if (protocol === "anthropic-messages") {
    if (config.cliMode) {
      return {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "anthropic-version": ANTHROPIC_VERSION,
        ...CLI_HEADERS,
      };
    }

    return {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  if (protocol === "gemini-generate-content") {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey,
    };
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

function buildRequestBody(
  config: MonitorConfig,
  protocol: RequestProtocol
): Record<string, unknown> {
  if (protocol === "openai-chat") {
    return {
      model: config.model,
      temperature: 0,
      max_tokens: 12,
      messages: [
        {
          role: "user",
          content: "Reply with OK only.",
        },
      ],
    };
  }

  if (protocol === "openai-responses") {
    return {
      model: config.model,
      input: "Reply with OK only.",
      max_output_tokens: 12,
    };
  }

  if (protocol === "anthropic-messages") {
    if (config.cliMode) {
      return {
        model: config.model,
        max_tokens: 12,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Reply with OK only.",
              },
            ],
          },
        ],
      };
    }

    return {
      model: config.model,
      max_tokens: 12,
      messages: [
        {
          role: "user",
          content: "Reply with OK only.",
        },
      ],
    };
  }

  return {
    contents: [
      {
        role: "user",
        parts: [{ text: "Reply with OK only." }],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 12,
    },
  };
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextContent(item))
      .filter(Boolean)
      .join(" ");
  }

  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.text === "string") {
      return row.text;
    }
    if (typeof row.output_text === "string") {
      return row.output_text;
    }
    if (row.content) {
      return extractTextContent(row.content);
    }
  }

  return "";
}

function getResponseText(body: unknown, protocol: RequestProtocol): string {
  if (!body || typeof body !== "object") {
    return "";
  }

  const payload = body as Record<string, unknown>;

  if (protocol === "openai-chat") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (choice && typeof choice === "object") {
      const message = (choice as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        return extractTextContent((message as Record<string, unknown>).content);
      }
    }
  }

  if (protocol === "openai-responses" && typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (protocol === "openai-responses" && payload.output) {
    return extractTextContent(payload.output);
  }

  if (protocol === "anthropic-messages" && Array.isArray(payload.content)) {
    return extractTextContent(payload.content);
  }

  if (protocol === "gemini-generate-content" && Array.isArray(payload.candidates)) {
    const candidate = payload.candidates[0];
    if (candidate && typeof candidate === "object") {
      return extractTextContent((candidate as Record<string, unknown>).content);
    }
  }

  return "";
}

function isGeminiResponseValid(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const payload = body as Record<string, unknown>;
  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    return false;
  }

  const candidate = payload.candidates[0];
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const content = (candidate as Record<string, unknown>).content;
  if (!content || typeof content !== "object") {
    return false;
  }

  const parts = (content as Record<string, unknown>).parts;
  return Array.isArray(parts) && parts.length > 0;
}

function getStatusLabel(status: MonitorStatus): string {
  if (status === "healthy") {
    return "Healthy";
  }
  if (status === "degraded") {
    return "Degraded";
  }
  return "Failed";
}

async function parseFailureResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (body.error && typeof body.error === "object") {
      const message = (body.error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  } catch {
    return `Request failed with HTTP ${response.status}`;
  }

  return `Request failed with HTTP ${response.status}`;
}

function buildModelsUrl(config: MonitorConfig): string {
  return new URL("/v1/models", config.baseUrl).toString();
}

function extractModelIds(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const payload = body as Record<string, unknown>;
  const items = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const row = item as Record<string, unknown>;
      const id = row.id ?? row.name;
      return typeof id === "string" ? id : null;
    })
    .filter((item): item is string => Boolean(item));
}

async function runCliListProbe(
  config: MonitorConfig,
  pingLatencyMs: number | null,
  checkedAt: string,
  startedAt: number
): Promise<CheckResult> {
  const response = await fetch(buildModelsUrl(config), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "anthropic-version": ANTHROPIC_VERSION,
      ...CLI_HEADERS,
      ...config.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });

  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return {
      id: config.id,
      status: "failed",
      latencyMs,
      pingLatencyMs,
      checkedAt,
      message: await parseFailureResponse(response),
    };
  }

  const json = (await response.json()) as unknown;
  const modelIds = extractModelIds(json);
  if (!modelIds.includes(config.model)) {
    return {
      id: config.id,
      status: "failed",
      latencyMs,
      pingLatencyMs,
      checkedAt,
      message: `Model ${config.model} not found in /v1/models response.`,
    };
  }

  const status: MonitorStatus =
    latencyMs > DEGRADED_THRESHOLD_MS ? "degraded" : "healthy";

  return {
    id: config.id,
    status,
    latencyMs,
    pingLatencyMs,
    checkedAt,
    message: `${getStatusLabel(status)} model-list probe succeeded.`,
  };
}

export async function runCheck(config: MonitorConfig): Promise<CheckResult> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  // ── ping ──────────────────────────────────────────────────────────────────
  let pingLatencyMs: number | null = null;
  try {
    const pingStart = Date.now();
    await fetch(config.baseUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    pingLatencyMs = Date.now() - pingStart;
  } catch {
    // ping failure is non-fatal — leave null
  }

  try {
    const protocol = detectProtocol(config);
    if (config.cliMode && protocol === "anthropic-messages") {
      return await runCliListProbe(config, pingLatencyMs, checkedAt, startedAt);
    }

    const cliHeaders = config.cliMode ? CLI_HEADERS : {};
    const headers = { ...buildHeaders(config, protocol), ...cliHeaders, ...config.headers };
    const response = await fetch(buildUrl(config), {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestBody(config, protocol)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });

    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        id: config.id,
        status: "failed",
        latencyMs,
        pingLatencyMs,
        checkedAt,
        message: await parseFailureResponse(response),
      };
    }

    const json = (await response.json()) as unknown;
    const text = getResponseText(json, protocol).toLowerCase();
    const isValidGemini = protocol === "gemini-generate-content" && isGeminiResponseValid(json);
    const passedValidation = isValidGemini || text.includes(HEALTHY_TOKEN);

    if (!passedValidation) {
      return {
        id: config.id,
        status: "failed",
        latencyMs,
        pingLatencyMs,
        checkedAt,
        message: "Model responded, but validation text was missing.",
      };
    }

    const status: MonitorStatus =
      latencyMs > DEGRADED_THRESHOLD_MS ? "degraded" : "healthy";

    return {
      id: config.id,
      status,
      latencyMs,
      pingLatencyMs,
      checkedAt,
      message: `${getStatusLabel(status)} response received.`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Error ? error.message : "Unknown monitor error";

    return {
      id: config.id,
      status: "failed",
      latencyMs,
      pingLatencyMs,
      checkedAt,
      message,
    };
  }
}
