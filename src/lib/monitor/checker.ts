import type { CheckResult, MonitorConfig, MonitorStatus } from "./types";

const REQUEST_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? "20000");
const DEGRADED_THRESHOLD_MS = Number(process.env.DEGRADED_THRESHOLD_MS ?? "4000");
const HEALTHY_TOKEN = "pong";
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
      stream: true,
      messages: [
        {
          role: "user",
          content: "Say pong in one word only.",
        },
      ],
    };
  }

  if (protocol === "openai-responses") {
    return {
      model: config.model,
      input: "Say pong in one word only.",
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
                text: "Say pong in one word only.",
              },
            ],
          },
        ],
      };
    }

    return {
      model: config.model,
      max_tokens: 12,
      stream: true,
      messages: [
        {
          role: "user",
          content: "Say pong in one word only.",
        },
      ],
    };
  }

  return {
    contents: [
      {
        role: "user",
        parts: [{ text: "Say pong in one word only." }],
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

function isGeminiPartValid(part: unknown): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return false;
  }

  const row = part as Record<string, unknown>;
  if (typeof row.text === "string" && row.text.trim().length > 0) {
    return true;
  }

  if (row.inlineData && typeof row.inlineData === "object") {
    return true;
  }

  if (row.fileData && typeof row.fileData === "object") {
    return true;
  }

  if (row.functionCall && typeof row.functionCall === "object") {
    return true;
  }

  return Object.keys(row).length > 0;
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
  return Array.isArray(parts) && parts.some((part) => isGeminiPartValid(part));
}

function isOpenAIResponseValid(text: string, protocol: RequestProtocol): boolean {
  if (protocol !== "openai-chat" && protocol !== "openai-responses") {
    return false;
  }

  return text.trim().length > 0;
}

function isOpenAICompatibleResponseValid(
  body: unknown,
  protocol: RequestProtocol
): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const payload = body as Record<string, unknown>;

  if (protocol === "openai-chat") {
    return (
      Array.isArray(payload.choices) &&
      payload.choices.length > 0 &&
      typeof payload.choices[0] === "object" &&
      payload.choices[0] !== null
    );
  }

  if (protocol === "openai-responses") {
    return payload.status === "completed" && payload.error === null;
  }

  return false;
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

async function readOpenAIStream(
  response: Response,
  requestStartedAt: number
): Promise<{ valid: boolean; text: string; firstChunkLatencyMs: number | null }> {
  if (!response.body) {
    return { valid: false, text: "", firstChunkLatencyMs: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstChunkLatencyMs: number | null = null;
  let buffer = "";
  let collectedText = "";
  let sawChoiceChunk = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const lines = event
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"));

      for (const line of lines) {
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        try {
          const json = JSON.parse(payload) as Record<string, unknown>;
          const choices = Array.isArray(json.choices) ? json.choices : [];
          if (choices.length > 0) {
            const firstChoice = choices[0];
            if (firstChoice && typeof firstChoice === "object") {
              const delta = (firstChoice as Record<string, unknown>).delta;
              if (delta && typeof delta === "object") {
                const content = (delta as Record<string, unknown>).content;
                if (typeof content === "string" && content.length > 0) {
                  sawChoiceChunk = true;
                  if (firstChunkLatencyMs === null) {
                    firstChunkLatencyMs = Math.max(1, Date.now() - requestStartedAt);
                  }
                  collectedText += content;
                }
              }
            }
          }
        } catch {
          continue;
        }
      }
    }
  }

  return {
    valid: sawChoiceChunk,
    text: collectedText,
    firstChunkLatencyMs,
  };
}

async function readAnthropicStream(
  response: Response,
  requestStartedAt: number
): Promise<{ valid: boolean; text: string; firstChunkLatencyMs: number | null }> {
  if (!response.body) {
    return { valid: false, text: "", firstChunkLatencyMs: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstChunkLatencyMs: number | null = null;
  let buffer = "";
  let collectedText = "";
  let sawContentChunk = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const lines = event.split("\n").map((line) => line.trim());
      const eventType = lines
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (dataLines.length === 0) {
        continue;
      }

      const payloadText = dataLines.join("\n");
      if (!payloadText || payloadText === "[DONE]") {
        continue;
      }

      try {
        const json = JSON.parse(payloadText) as Record<string, unknown>;
        const delta =
          eventType === "content_block_delta" ? json.delta : undefined;

        if (delta && typeof delta === "object") {
          const text = (delta as Record<string, unknown>).text;
          if (typeof text === "string" && text.length > 0) {
            sawContentChunk = true;
            if (firstChunkLatencyMs === null) {
              firstChunkLatencyMs = Math.max(1, Date.now() - requestStartedAt);
            }
            collectedText += text;
          }
        }
      } catch {
        continue;
      }
    }
  }

  return {
    valid: sawContentChunk,
    text: collectedText,
    firstChunkLatencyMs,
  };
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
  const protocol = detectProtocol(config);
  if (protocol === "gemini-generate-content") {
    const endpoint = config.endpoint.replace("{model}", encodeURIComponent(config.model));
    const match = endpoint.match(/^(\/v\d+(?:beta)?)\/models\//);
    const prefix = match?.[1] ?? "/v1beta";
    return new URL(`${prefix}/models`, config.baseUrl).toString();
  }

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
      if (typeof id !== "string") {
        return null;
      }

      return id.startsWith("models/") ? id.slice("models/".length) : id;
    })
    .filter((item): item is string => Boolean(item));
}

async function runListProbe(
  config: MonitorConfig,
  pingLatencyMs: number | null,
  checkedAt: string,
  startedAt: number
): Promise<CheckResult> {
  const protocol = detectProtocol(config);
  const cliHeaders = config.cliMode ? CLI_HEADERS : {};
  const headers = {
    Accept: "application/json",
    ...buildHeaders(config, protocol),
    ...cliHeaders,
    ...config.headers,
  };

  const response = await fetch(buildModelsUrl(config), {
    method: "GET",
    headers,
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

  const requestStartedAt = Date.now();

  try {
    const protocol = detectProtocol(config);
    if (config.checkMode === "list") {
      return await runListProbe(config, pingLatencyMs, checkedAt, requestStartedAt);
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

    const latencyMs = Date.now() - requestStartedAt;
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

    if (protocol === "openai-chat") {
      const streamResult = await readOpenAIStream(response, requestStartedAt);
      if (!streamResult.valid) {
        return {
          id: config.id,
          status: "failed",
          latencyMs: Math.max(1, Date.now() - requestStartedAt),
          pingLatencyMs,
          checkedAt,
          message: "Stream response did not contain any valid chunks.",
        };
      }

      const latencyMs = streamResult.firstChunkLatencyMs ?? (Date.now() - requestStartedAt);
      const safeLatencyMs = Math.max(1, latencyMs);
      const status: MonitorStatus =
        safeLatencyMs > DEGRADED_THRESHOLD_MS ? "degraded" : "healthy";

      return {
        id: config.id,
        status,
        latencyMs: safeLatencyMs,
        pingLatencyMs,
        checkedAt,
        message:
          streamResult.text.trim().length > 0
            ? `${getStatusLabel(status)} stream response received.`
            : `${getStatusLabel(status)} stream connected without text payload.`,
      };
    }

    if (protocol === "anthropic-messages" && !config.cliMode) {
      const streamResult = await readAnthropicStream(response, requestStartedAt);
      if (!streamResult.valid) {
        return {
          id: config.id,
          status: "failed",
          latencyMs: Math.max(1, Date.now() - requestStartedAt),
          pingLatencyMs,
          checkedAt,
          message: "Anthropic stream did not contain any valid content chunks.",
        };
      }

      const latencyMs = streamResult.firstChunkLatencyMs ?? (Date.now() - requestStartedAt);
      const safeLatencyMs = Math.max(1, latencyMs);
      const status: MonitorStatus =
        safeLatencyMs > DEGRADED_THRESHOLD_MS ? "degraded" : "healthy";

      return {
        id: config.id,
        status,
        latencyMs: safeLatencyMs,
        pingLatencyMs,
        checkedAt,
        message:
          streamResult.text.trim().length > 0
            ? `${getStatusLabel(status)} stream response received.`
            : `${getStatusLabel(status)} stream connected without text payload.`,
      };
    }

    const json = (await response.json()) as unknown;
    const text = getResponseText(json, protocol).toLowerCase();
    const isValidOpenAI = isOpenAIResponseValid(text, protocol);
    const isValidOpenAICompatible = isOpenAICompatibleResponseValid(json, protocol);
    const isValidGemini = protocol === "gemini-generate-content" && isGeminiResponseValid(json);
    const passedValidation =
      isValidOpenAI ||
      isValidOpenAICompatible ||
      isValidGemini ||
      text.includes(HEALTHY_TOKEN);

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
    const latencyMs = Math.max(1, Date.now() - requestStartedAt);
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
