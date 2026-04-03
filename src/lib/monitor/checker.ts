import type { CheckResult, MonitorConfig, MonitorStatus } from "./types";

const REQUEST_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? "20000");
const DEGRADED_THRESHOLD_MS = Number(process.env.DEGRADED_THRESHOLD_MS ?? "4000");
const HEALTHY_TOKEN = "ok";
const ANTHROPIC_VERSION = "2023-06-01";

type RequestProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content";

function buildUrl(config: MonitorConfig): string {
  const endpoint = config.endpoint.replace("{model}", encodeURIComponent(config.model));
  const url = new URL(`${config.baseUrl}${endpoint}`);

  if (detectProtocol(config) === "gemini-generate-content") {
    url.searchParams.set("key", config.apiKey);
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
    return {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  if (protocol === "gemini-generate-content") {
    return {
      "Content-Type": "application/json",
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
    const response = await fetch(buildUrl(config), {
      method: "POST",
      headers: buildHeaders(config, protocol),
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
    if (!text.includes(HEALTHY_TOKEN)) {
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
