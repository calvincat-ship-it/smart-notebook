/**
 * 智慧記事本 — Anthropic API 中繼站 (Cloudflare Worker)
 *
 * 目的：把 Anthropic API 金鑰保管在後端，讓 App（本人 + 幾位同事）不必各自
 * 持有金鑰。App 送來的 JSON body 會轉發到 Anthropic Messages API，回應原樣傳回。
 *
 * 需要設定的 Secrets（Cloudflare 儀表板 → 該 Worker → Settings → Variables and Secrets，
 * 或用 `npx wrangler secret put <NAME>`）：
 *   ANTHROPIC_API_KEY  你的 Anthropic API 金鑰（sk-ant-...）
 *   APP_ACCESS_CODE    自訂的共用存取碼；App 端在設定要填一樣的值
 *
 * 可依需要調整下方的 ALLOWED_ORIGINS / MODEL_ALLOWLIST / MAX_TOKENS_CAP。
 * 部署步驟見同目錄 README.md。
 */

// 只允許這些網域的瀏覽器呼叫（CORS）。App 若換網址，改這裡。
const ALLOWED_ORIGINS = [
  'https://calvincat-ship-it.github.io',
  'http://localhost:5175',
  'http://localhost:5173',
];

// 只放行這些模型，並限制 max_tokens，避免存取碼外洩時被灌爆花費。
const MODEL_ALLOWLIST = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_TOKENS_CAP = 8192;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-app-access-code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: { message: 'Method not allowed' } }, 405, origin);
    }

    // 共用存取碼檢查
    const code = request.headers.get('x-app-access-code') || '';
    if (!env.APP_ACCESS_CODE || code !== env.APP_ACCESS_CODE) {
      return json({ error: { message: '存取碼錯誤或中繼站未設定存取碼。' } }, 403, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: { message: '中繼站尚未設定 ANTHROPIC_API_KEY。' } }, 500, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: { message: 'Invalid JSON body' } }, 400, origin);
    }

    // 清洗 / 設上限，保護擁有者的花費；其餘欄位原樣轉發
    const model = MODEL_ALLOWLIST.includes(payload.model) ? payload.model : DEFAULT_MODEL;
    const maxTokens = Math.min(Number(payload.max_tokens) || 4096, MAX_TOKENS_CAP);
    const forward = { model, max_tokens: maxTokens };
    if (payload.system) forward.system = payload.system;
    if (payload.messages) forward.messages = payload.messages;
    if (payload.output_config) forward.output_config = payload.output_config;

    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(forward),
      });
    } catch (e) {
      return json({ error: { message: '無法連線到 Anthropic：' + e.message } }, 502, origin);
    }

    // 原樣把 Anthropic 的回應（含狀態碼）傳回，App 端解析方式與直連時相同
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  },
};
