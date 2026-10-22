// 模型端點安全規則與 OpenAI 相容 Chat Completions 呼叫（零相依，用內建 fetch）
// 規則與 dsh-plan-checkup 相同：loopback 永遠可用；其他主機要 allowEgress: true；
// 非本機的 http 主機要列在 allowHttpHosts。金鑰只進 header，絕不進錯誤訊息。

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** @param {string} endpoint */
export function isLoopback(endpoint) {
  try {
    const { hostname } = new URL(endpoint);
    return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost') || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

/**
 * 判斷是否允許把內容送到這個端點
 * @param {string} endpoint
 * @param {{ allowEgress?: boolean, allowHttpHosts?: string[] }} policy
 * @returns {{ ok: true, loopback: boolean } | { ok: false, reason: 'egress-off' | 'insecure-endpoint' | 'bad-endpoint' }}
 */
export function checkEndpoint(endpoint, { allowEgress = false, allowHttpHosts = [] } = {}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'bad-endpoint' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'bad-endpoint' };
  if (isLoopback(endpoint)) return { ok: true, loopback: true };
  const hosts = (allowHttpHosts || []).map((h) => String(h).toLowerCase());
  if (url.protocol === 'http:' && !hosts.includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: 'insecure-endpoint' };
  }
  if (!allowEgress) return { ok: false, reason: 'egress-off' };
  return { ok: true, loopback: false };
}

export class EndpointError extends Error {
  /**
   * @param {'aborted'|'timeout'|'network'|'auth'|'quota'|'busy'|'bad-request'|'server'|'invalid'|'policy'} kind
   * @param {string} message
   * @param {Record<string, any>} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'EndpointError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function transportError(error, signal, timeoutMs) {
  if (signal?.aborted) return new EndpointError('aborted', 'request aborted');
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new EndpointError('timeout', `no answer within ${timeoutMs} ms`);
  }
  return new EndpointError('network', `network error: ${error?.cause?.code ?? error?.message ?? String(error)}`);
}

/**
 * 一次 JSON POST（逾時、外部 abort、HTTP 狀態碼對應錯誤類別）
 * @param {{ url: string, headers?: Record<string, string>, body: unknown, timeoutMs: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} request
 */
export async function postJson({ url, headers = {}, body, timeoutMs, signal, fetchImpl = fetch }) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    throw transportError(error, signal, timeoutMs);
  }
  if (!response.ok) {
    const status = response.status;
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // 只用於訊息
    }
    if (status === 401 || status === 403) throw new EndpointError('auth', `endpoint rejected the key (${status})`, { status });
    if (status === 402) throw new EndpointError('quota', 'credit exhausted (402)', { status });
    if (status === 429 || status === 503 || status === 529) throw new EndpointError('busy', `endpoint is busy (${status})`, { status });
    if (status === 400 || status === 404 || status === 422) throw new EndpointError('bad-request', `request rejected (${status}): ${detail}`, { status });
    throw new EndpointError('server', `endpoint error (${status})`, { status });
  }
  try {
    return await response.json();
  } catch (error) {
    if (signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw transportError(error, signal, timeoutMs);
    throw new EndpointError('invalid', 'response is not JSON');
  }
}

/**
 * 呼叫 OpenAI 相容的 chat completions，回傳助理文字與用量
 * @param {{
 *   endpoint: string, model: string, apiKeyEnv?: string, allowEgress?: boolean, allowHttpHosts?: string[],
 *   timeoutMs?: number, temperature?: number, maxTokens?: number, extraBody?: Record<string, any>
 * }} settings
 * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, env?: Record<string, string|undefined>, responseFormatJson?: boolean }} [options]
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number, totalTokens: number }, model: string }>}
 */
export async function chatCompletion(settings, messages, options = {}) {
  const policy = checkEndpoint(settings.endpoint, settings);
  if (!policy.ok) {
    const why = {
      'egress-off': `端點 ${settings.endpoint} 不在本機，需要 allowEgress: true`,
      'insecure-endpoint': `端點 ${settings.endpoint} 用 http 且主機不在 allowHttpHosts`,
      'bad-endpoint': `端點 ${settings.endpoint} 不是合法的 http(s) URL`,
    }[policy.reason];
    throw new EndpointError('policy', why);
  }
  if (!settings.model) throw new EndpointError('bad-request', 'proposer.model 未設定');
  const env = options.env ?? process.env;
  const headers = {};
  if (settings.apiKeyEnv) {
    const key = env[settings.apiKeyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const body = {
    model: settings.model,
    messages,
    temperature: Number.isFinite(settings.temperature) ? settings.temperature : 0.7,
    max_tokens: Number.isFinite(settings.maxTokens) ? settings.maxTokens : 4000,
    stream: false,
    ...(options.responseFormatJson ? { response_format: { type: 'json_object' } } : {}),
    ...(settings.extraBody && typeof settings.extraBody === 'object' ? settings.extraBody : {}),
  };
  const json = await postJson({
    url: settings.endpoint,
    headers,
    body,
    timeoutMs: Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 120000,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      : '';
  if (!text.trim()) throw new EndpointError('invalid', 'response has no assistant text');
  const u = json.usage || {};
  const inputTokens = Number(u.prompt_tokens) || 0;
  const outputTokens = Number(u.completion_tokens) || 0;
  return {
    text,
    usage: { inputTokens, outputTokens, totalTokens: Number(u.total_tokens) || inputTokens + outputTokens },
    model: json.model || settings.model,
  };
}

/**
 * 從模型回覆裡抓出第一個 JSON 物件（容忍 ```json 圍欄與前後說明文字，並去掉 <think> 區塊）
 * @param {string} text
 */
export function extractJsonObject(text) {
  let s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
