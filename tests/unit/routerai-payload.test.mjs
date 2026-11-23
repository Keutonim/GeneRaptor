/**
 * Unit tests for callRouterAI payload shaping (gate-2026-08-10 combo-fix).
 *
 * Covers ФИКС #1: `enable_thinking:false` is injected for qwen models when
 * the ROUTERAI_DISABLE_THINKING env flag is enabled (default true), and NOT
 * injected for non-qwen models or when the env is set to 'false'.
 *
 * The test stubs global.fetch and reads the JSON body the implementation sent,
 * so it asserts the on-the-wire payload rather than an internal helper.
 */
import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';

// callRouterAI reads env at CALL time (env is read inside the function body),
// so toggling process.env between tests is effective.

// fetch is mocked below per-test via vi.stubGlobal.

import { callRouterAI } from '../../server/agent-role-execution.mjs';

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: null, // non-streaming path (we send stream:false)
    text: async () => JSON.stringify({
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  });
}

describe('callRouterAI — enable_thinking for qwen models', () => {
  const ENV_VARS = ['ROUTERAI_API_KEY', 'ROUTERAI_DISABLE_THINKING', 'ROUTERAI_STREAM'];

  beforeEach(() => {
    process.env.ROUTERAI_API_KEY = 'test-key';
    // Force non-streaming so fetch().body is not consumed — simpler assertion path.
    process.env.ROUTERAI_STREAM = 'false';
  });

  afterEach(() => {
    for (const k of ENV_VARS) delete process.env[k];
    vi.unstubAllGlobals();
  });

  test('does NOT inject enable_thinking when flag is default (unset) — thinking stays ON for complex roles', async () => {
    vi.stubGlobal('fetch', mockFetchOk());
    await callRouterAI({ model: 'qwen/qwen3.6-flash', messages: [] });

    expect(fetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sentBody.model).toBe('qwen/qwen3.6-flash');
    expect(sentBody.enable_thinking).toBeUndefined();
  });

  test('injects enable_thinking=false when ROUTERAI_DISABLE_THINKING=true and model contains qwen (case-insensitive)', async () => {
    process.env.ROUTERAI_DISABLE_THINKING = 'true';
    vi.stubGlobal('fetch', mockFetchOk());
    await callRouterAI({ model: 'Qwen/Qwen3-Coder', messages: [] });

    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sentBody.enable_thinking).toBe(false);
  });

  test('caller-provided enable_thinking=false is respected even when global flag is off', async () => {
    // Default flag is off, but caller explicitly opts out (e.g. breakdown).
    vi.stubGlobal('fetch', mockFetchOk());
    await callRouterAI({ model: 'qwen/qwen3.6-flash', messages: [], enable_thinking: false });

    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sentBody.enable_thinking).toBe(false);
  });

  test('does NOT inject enable_thinking for deepseek models', async () => {
    vi.stubGlobal('fetch', mockFetchOk());
    await callRouterAI({ model: 'deepseek/deepseek-v4-flash', messages: [] });

    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sentBody.enable_thinking).toBeUndefined();
  });

  test('does NOT inject enable_thinking when ROUTERAI_DISABLE_THINKING=false', async () => {
    process.env.ROUTERAI_DISABLE_THINKING = 'false';
    vi.stubGlobal('fetch', mockFetchOk());
    await callRouterAI({ model: 'qwen/qwen3.6-flash', messages: [] });

    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sentBody.enable_thinking).toBeUndefined();
  });

  test('does NOT override caller-provided enable_thinking', async () => {
    vi.stubGlobal('fetch', mockFetchOk());
    await callRouterAI({ model: 'qwen/qwen3.6-flash', enable_thinking: true, messages: [] });

    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    // Caller's explicit value wins.
    expect(sentBody.enable_thinking).toBe(true);
  });
});
