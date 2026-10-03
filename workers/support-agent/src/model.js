/* Model transport layer for the NMV support agent.
 *
 * PRIMARY: Cloudflare Workers AI via the env.AI binding — no external key.
 * FALLBACKS (only when the primary fails: 429 / cap exhaustion / error):
 *   Cerebras -> Gemini, via their OpenAI-compatible endpoints with keys
 *   from env secrets (CEREBRAS_API_KEY, GEMINI_API_KEY).
 *
 * Every transport is wrapped in the SDK's OpenAIChatCompletionsModel with a
 * minimal client whose chat.completions.create() speaks the right wire
 * protocol. The SDK therefore builds the exact same OpenAI-shaped
 * {messages, tools} request for every provider, and system/user/assistant/
 * tool role separation is preserved end to end — nothing is ever flattened
 * into a prompt string. Only the transport changes; guardrails, tools and
 * topology in agent.js are untouched.
 */
import { OpenAIChatCompletionsModel } from '@openai/agents';

export const WORKERS_AI_MODEL_DEFAULT = '@cf/meta/llama-3.1-8b-instruct-fp8';
export const WORKERS_AI_MODEL_LARGE = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// NOTE (2026-10-03): Cerebras deprecated llama-3.3-70b on 2026-02-16.
// Per their live model catalog, Shared Inference currently serves only
// gpt-oss-120b (402/payment-required on this key) and qwen-3.8-27b.
export const CEREBRAS_MODEL = 'qwen-3.8-27b';
export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
export const GEMINI_MODEL = 'gemini-3.8-flash';
// NOTE (2026-10-03): Gemini's OpenAI-compatible endpoint lives under v1beta,
// not v1 — the v1 URL 404s with an empty body. And gemini-2.5-flash is retired
// for new users; the API itself recommends gemini-3.8-flash.
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export function configuredModelName(env) {
  if (env && (env.MODEL || env.OPENAI_MODEL)) return env.MODEL || env.OPENAI_MODEL;
  if (typeof process !== 'undefined' && process.env && (process.env.MODEL || process.env.OPENAI_MODEL)) {
    return process.env.MODEL || process.env.OPENAI_MODEL;
  }
  return WORKERS_AI_MODEL_DEFAULT;
}

/* Translate a Workers AI chat result into an OpenAI chat-completion object,
 * so the SDK's response handling (tool calls, usage, finish reasons) works
 * unchanged. Workers AI tool_calls may lack ids and may carry arguments as
 * an object — both are normalized here.
 *
 * Llama models on Workers AI lowercase tool names when emitting tool calls
 * (e.g. transfer_to_nmv_support_specialist), but the SDK looks tools up
 * case-sensitively. canonicalNames (from the request's tool definitions)
 * restores the exact registered name via case-insensitive match. */
function workersAIToChatCompletion(raw, model, canonicalNames) {
  const text = typeof raw === 'string' ? raw : (raw && raw.response != null ? String(raw.response) : '');
  const rawCalls = raw && typeof raw !== 'string' && Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  const nameMap = new Map((canonicalNames || []).map(n => [String(n).toLowerCase(), n]));
  const toolCalls = rawCalls.map((tc, i) => {
    const args = tc && tc.arguments;
    const returned = (tc && tc.name) || '';
    return {
      id: (tc && tc.id) || `call_wai_${Date.now().toString(36)}_${i}`,
      type: 'function',
      function: {
        name: nameMap.get(returned.toLowerCase()) || returned,
        arguments: parseToolArguments(args),
      },
    };
  });
  const usage = (raw && typeof raw !== 'string' && raw.usage) || {};
  return {
    id: `wai-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length ? null : text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

/* Workers AI's chat schema is stricter than OpenAI's: it rejects null
 * content and mixed array/string content shapes within one request
 * (AiError 5006). Normalize every message to string content while
 * preserving role, tool_calls, and tool_call_id. */
function normalizeMessagesForWorkersAI(messages) {
  return (messages || []).map(m => {
    if (!m || typeof m !== 'object') return m;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map(p => {
          if (typeof p === 'string') return p;
          if (p && typeof p.text === 'string') return p.text;
          return '';
        })
        .join('');
    } else if (content == null) {
      content = '';
    } else if (typeof content !== 'string') {
      content = String(content);
    }
    const out = { ...m, content };
    return out;
  });
}

/* Llama on Workers AI usually returns tool-call arguments as an object, but
 * occasionally emits a raw string — sometimes malformed (unquoted keys,
 * trailing commas). Validate here with one conservative repair pass; if it
 * still won't parse, hand the original to the SDK and let runTurn degrade
 * gracefully (it now catches non-transport failures instead of 500ing). */
export function parseToolArguments(args) {
  if (typeof args !== 'string') return JSON.stringify(args == null ? {} : args);
  try { JSON.parse(args); return args; } catch { /* fall through to repair */ }
  const fixed = args
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/(['"])?([A-Za-z0-9_]+)(['"])?\s*:/g, '"$2":');
  try { JSON.parse(fixed); return fixed; } catch { /* still broken */ }
  return args;
}

function workersAIClient(aiBinding, modelName) {
  return {
    baseURL: 'workers-ai-binding',
    chat: {
      completions: {
        create: async (params) => {
          let raw;
          try {
            raw = await aiBinding.run(modelName, {
              messages: normalizeMessagesForWorkersAI(params.messages),
              tools: params.tools,
              tool_choice: params.tool_choice,
              temperature: params.temperature,
              max_tokens: params.max_tokens,
            });
          } catch (err) {
            // Transport-level failure (network, 429, cap exhaustion, provider
            // 5xx): runTurn retries the turn on the next provider. Anything
            // else (bad tool args, turn cap, SDK errors) fails identically on
            // every provider, so it must NOT be retried — it degrades.
            if (err && typeof err === 'object') err.isTransportError = true;
            throw err;
          }
          const canonicalNames = (params.tools || [])
            .map(t => t && t.function && t.function.name)
            .filter(Boolean);
          return workersAIToChatCompletion(raw, modelName, canonicalNames);
        },
      },
    },
  };
}

function openAICompatClient({ baseURL, apiKey }) {
  return {
    baseURL,
    chat: {
      completions: {
        create: async (params, options) => {
          let res;
          try {
            res = await fetch(`${baseURL}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({ ...params, stream: false }),
              signal: options && options.signal,
            });
          } catch (err) {
            if (err && typeof err === 'object') err.isTransportError = true;
            throw err;
          }
          if (!res.ok) {
            // Transient overload/rate-limit: one retry after a short pause.
            if ((res.status === 429 || res.status === 503) && !options?.retried) {
              await new Promise((r) => setTimeout(r, 3000));
              return openAICompatClient({ baseURL, apiKey }).chat.completions.create(params, { ...options, retried: true });
            }
            const text = await res.text().catch(() => '');
            const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
            err.status = res.status;
            err.isTransportError = true;
            throw err;
          }
          return res.json();
        },
      },
    },
  };
}

/** Primary model: Workers AI via the env.AI binding. Requires env.AI. */
export function primaryModel(env) {
  const modelName = configuredModelName(env);
  return new OpenAIChatCompletionsModel(workersAIClient(env.AI, modelName), modelName);
}

/** Fallback providers in order, each { name, model }. Only includes providers
 *  whose secret is present. */
export function fallbackModels(env) {
  const list = [];
  if (env && env.CEREBRAS_API_KEY) {
    list.push({
      name: 'cerebras',
      model: new OpenAIChatCompletionsModel(
        openAICompatClient({ baseURL: CEREBRAS_BASE_URL, apiKey: env.CEREBRAS_API_KEY }),
        CEREBRAS_MODEL),
    });
  }
  if (env && env.GEMINI_API_KEY) {
    list.push({
      name: 'gemini',
      model: new OpenAIChatCompletionsModel(
        openAICompatClient({ baseURL: GEMINI_BASE_URL, apiKey: env.GEMINI_API_KEY }),
        GEMINI_MODEL),
    });
  }
  return list;
}

/** True when at least one model transport can run (binding or fallback key). */
export function modelConfigured(env) {
  return Boolean((env && env.AI) || (env && (env.CEREBRAS_API_KEY || env.GEMINI_API_KEY)));
}
