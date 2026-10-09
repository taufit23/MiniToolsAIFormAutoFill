/* AIFF.providers: deteksi server LLM lokal + model yang tersedia, lalu panggilan chat (Ollama native & OpenAI-compatible). */
(function (root) {
  'use strict';
  const AIFF = (root.AIFF = root.AIFF || {});

  /** Kandidat bawaan; pengguna bisa menambah URL sendiri di opsi. */
  const DEFAULT_ENDPOINTS = [
    { id: 'ollama', name: 'Ollama', url: 'http://localhost:11434', api: 'ollama' },
    { id: 'lmstudio', name: 'LM Studio', url: 'http://localhost:1234', api: 'openai' },
    { id: 'llamacpp', name: 'llama.cpp / LocalAI / vLLM', url: 'http://localhost:8080', api: 'openai' },
    { id: 'jan', name: 'Jan', url: 'http://localhost:1337', api: 'openai' },
    { id: 'gpt4all', name: 'GPT4All', url: 'http://localhost:4891', api: 'openai' },
  ];

  const NOT_CHAT = /(embed|embedding|rerank|whisper|tts|clip|bge-|nomic-embed|minilm)/i;

  function withTimeout(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, done: () => clearTimeout(t) };
  }
  function authHeaders(ep) {
    const h = { 'Content-Type': 'application/json' };
    if (ep.apiKey) h.Authorization = 'Bearer ' + ep.apiKey;
    return h;
  }
  function sizeLabel(bytes) { return bytes ? (bytes / 1e9).toFixed(1) + ' GB' : ''; }

  /** Daftar model sebuah endpoint, atau null bila tidak terjangkau. */
  async function listModels(ep, timeoutMs) {
    const to = withTimeout(timeoutMs || 1800);
    try {
      if (ep.api === 'ollama') {
        const res = await fetch(ep.url.replace(/\/$/, '') + '/api/tags', { signal: to.signal });
        if (!res.ok) return null;
        const j = await res.json();
        return (j.models || []).map((m) => ({
          id: m.name || m.model, label: m.name || m.model,
          detail: [m.details && m.details.parameter_size, m.details && m.details.quantization_level, sizeLabel(m.size)].filter(Boolean).join(' · '),
          chat: !(m.capabilities && !m.capabilities.includes('completion')) && !NOT_CHAT.test(m.name || ''),
          thinking: !!(m.capabilities && m.capabilities.includes('thinking')),
          params: parseFloat(m.details && m.details.parameter_size) || 0,
        }));
      }
      const res = await fetch(ep.url.replace(/\/$/, '') + '/v1/models', { signal: to.signal, headers: authHeaders(ep) });
      if (!res.ok) return null;
      const j = await res.json();
      return (j.data || []).map((m) => ({ id: m.id, label: m.id, detail: m.owned_by || '', chat: !NOT_CHAT.test(m.id), thinking: /(qwen3|deepseek-r1|reasoning|think)/i.test(m.id), params: parseFloat((/(\d+(?:\.\d+)?)b/i.exec(m.id) || [])[1]) || 0 }));
    } catch (e) {
      return null;
    } finally {
      to.done();
    }
  }

  /** Cek semua endpoint paralel. Hasil: [{endpoint, models}] hanya yang hidup. */
  async function detect(endpoints, timeoutMs) {
    const list = (endpoints && endpoints.length ? endpoints : DEFAULT_ENDPOINTS).filter((e) => e.enabled !== false);
    const results = await Promise.all(list.map(async (ep) => ({ endpoint: ep, models: await listModels(ep, timeoutMs) })));
    return results.filter((r) => r.models);
  }

  /** Model yang paling cocok untuk mengisi form: instruct/chat, tidak terlalu kecil, tidak "thinking" bila ada alternatif. */
  function recommend(models) {
    const chat = models.filter((m) => m.chat);
    const pool = chat.length ? chat : models;
    const score = (m) => {
      let s = 0;
      if (m.params >= 3 && m.params <= 14) s += 4; else if (m.params > 14) s += 2; else if (m.params > 0) s += 1;
      if (/(instruct|chat|-it\b)/i.test(m.id)) s += 2;
      if (/(qwen2\.5|llama3|gemma|mistral|phi)/i.test(m.id)) s += 1;
      if (m.thinking) s -= 1;
      return s;
    };
    return pool.slice().sort((a, b) => score(b) - score(a))[0] || null;
  }

  /**
   * Satu panggilan chat yang mengembalikan teks JSON. Ollama: /api/chat + format (JSON Schema) + think:false.
   * OpenAI-compatible: /v1/chat/completions, mencoba json_schema lalu json_object lalu polos.
   */
  async function chatJson(ep, model, messages, opts) {
    const o = Object.assign({ temperature: 0.7, timeoutMs: 120000, schema: null, numCtx: 8192 }, opts || {});
    const to = withTimeout(o.timeoutMs);
    try {
      if (ep.api === 'ollama') {
        const body = { model, messages, stream: false, think: false, keep_alive: '10m', format: o.schema || 'json', options: { temperature: o.temperature, num_ctx: o.numCtx } };
        let res = await fetch(ep.url.replace(/\/$/, '') + '/api/chat', { method: 'POST', headers: authHeaders(ep), body: JSON.stringify(body), signal: to.signal });
        if (!res.ok && (res.status === 400 || res.status === 500)) { // model lama tanpa dukungan schema/think: ulangi sederhana
          delete body.think; body.format = 'json';
          res = await fetch(ep.url.replace(/\/$/, '') + '/api/chat', { method: 'POST', headers: authHeaders(ep), body: JSON.stringify(body), signal: to.signal });
        }
        if (!res.ok) throw new Error('Ollama ' + res.status + ': ' + (await res.text()).slice(0, 200));
        const j = await res.json();
        return (j.message && j.message.content) || '';
      }
      const base = { model, messages, temperature: o.temperature, stream: false };
      const attempts = [
        o.schema ? Object.assign({}, base, { response_format: { type: 'json_schema', json_schema: { name: 'form_values', strict: true, schema: o.schema } } }) : null,
        Object.assign({}, base, { response_format: { type: 'json_object' } }),
        base,
      ].filter(Boolean);
      let lastErr = '';
      for (const body of attempts) {
        const res = await fetch(ep.url.replace(/\/$/, '') + '/v1/chat/completions', { method: 'POST', headers: authHeaders(ep), body: JSON.stringify(body), signal: to.signal });
        if (res.ok) {
          const j = await res.json();
          return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        }
        lastErr = res.status + ': ' + (await res.text()).slice(0, 200);
        if (res.status !== 400 && res.status !== 422) break;
      }
      throw new Error('LLM ' + lastErr);
    } finally {
      to.done();
    }
  }

  /** Muat model ke memori lebih dulu (Ollama) supaya permintaan pertama tidak menunggu pemuatan 20-30 detik. Tidak pernah melempar galat. */
  async function warmup(ep, model) {
    if (ep.api !== 'ollama' || !model) return false;
    const to = withTimeout(60000);
    try {
      const res = await fetch(ep.url.replace(/\/$/, '') + '/api/generate', { method: 'POST', headers: authHeaders(ep), body: JSON.stringify({ model, prompt: '', keep_alive: '10m', stream: false }), signal: to.signal });
      return res.ok;
    } catch (e) { return false; } finally { to.done(); }
  }

  AIFF.providers = { DEFAULT_ENDPOINTS, listModels, detect, recommend, chatJson, warmup };
  if (typeof module !== 'undefined' && module.exports) module.exports = AIFF.providers;
})(typeof self !== 'undefined' ? self : globalThis);
