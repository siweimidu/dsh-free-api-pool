/**
 * Renders the real client.js in a browser against a stubbed host, so the panel can be
 * inspected visually and driven without booting DSH. Serves the plugin's own file plus a
 * fixture host that mirrors the real route payloads (including multi-key accounts).
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'

const PLUGIN = 'C:/Users/35238/.dsh/profiles/desktop/dsh-free-api-pool'
const REACT = 'C:/Users/35238/.dsh/profiles/node_modules/react/umd/react.development.js'
const REACT_DOM = 'C:/Users/35238/.dsh/profiles/node_modules/react-dom/umd/react-dom.development.js'

const PROVIDERS = JSON.parse(readFileSync(PLUGIN + '/data/providers.json', 'utf8')).providers

function quotaFor(slug, accountIndex) {
  const bump = accountIndex * 137
  if (slug === 'groq') {
    return { state: 'ok', nature: 'rate-limit', currency: 'requests', todayCurrency: 'requests', totalRemaining: 999 - bump, todayRemaining: 999 - bump, used: 1 + accountIndex, todayUsed: null, models: 11, detail: '免费层实测：每分钟 1000 次请求', windows: [{ label: '每分钟请求', unit: 'requests', limit: 1000, remaining: 999 - bump, used: 1, reset: '1m26.4s' }, { label: '每分钟 token', unit: 'tokens', limit: 8000, remaining: 7923 - bump, used: 77, reset: '577ms' }] }
  }
  if (slug === 'openrouter') {
    return { state: 'ok', nature: 'balance', currency: 'USD', todayCurrency: 'models', totalRemaining: 12.5 - accountIndex * 2, todayRemaining: 19, used: 0.2 + accountIndex, todayUsed: null, models: 19, detail: '免费层账号，当前 19 个模型免费', windows: [] }
  }
  if (slug === 'moonshot') {
    return { state: 'ok', nature: 'balance', currency: 'CNY', todayCurrency: null, totalRemaining: 3.37 + accountIndex, todayRemaining: null, used: null, todayUsed: null, models: null, detail: '代金券 3.3670201 / 现金 0', windows: [] }
  }
  if (slug === 'github') {
    return { state: 'ok', nature: 'rate-limit', currency: 'requests', todayCurrency: 'requests', totalRemaining: 4990, todayRemaining: 4990, used: 10, todayUsed: null, models: null, detail: 'GitHub API 速率额度（非模型额度）', windows: [] }
  }
  if (slug === 'hcnsec') {
    return { state: 'error', nature: 'none', currency: null, todayCurrency: null, totalRemaining: null, todayRemaining: null, used: null, todayUsed: null, models: null, detail: 'Key 被拒绝（HTTP 401）', windows: [] }
  }
  return { state: 'console', nature: 'console', currency: null, todayCurrency: null, totalRemaining: null, todayRemaining: null, used: null, todayUsed: null, models: null, detail: '该平台未开放余额接口，需在控制台查看', windows: [] }
}

// Multi-key fixtures: Groq x3, OpenRouter x2, Moonshot x1.
const KEY_PLAN = { groq: 3, openrouter: 2, moonshot: 1, github: 1, hcnsec: 1 }
let entries = []
for (const [slug, count] of Object.entries(KEY_PLAN)) {
  for (let i = 0; i < count; i += 1) {
    entries.push({
      id: slug + '-' + i,
      slug,
      label: count > 1 ? slug + ' 账号 ' + (i + 1) : slug + ' 主号',
      masked: 'sk-' + slug.slice(0, 3) + '…' + String(1000 + i),
      baseUrl: (PROVIDERS.find((p) => p.slug === slug) || {}).baseUrl || '',
    })
  }
}

function buildProviders() {
  return PROVIDERS.map((p) => {
    const mine = entries.filter((e) => e.slug === p.slug)
    const accounts = mine.map((e, i) => ({ ...e, quota: quotaFor(p.slug, i) }))
    const measured = accounts.filter((a) => a.quota.state === 'ok')
    const sum = (f) => {
      const vals = measured.map((a) => a.quota[f]).filter((v) => typeof v === 'number')
      return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0)
    }
    return {
      slug: p.slug, name: p.name, vendor: p.vendor, category: p.category,
      baseUrl: p.baseUrl, applyUrl: p.applyUrl, docsUrl: p.docsUrl,
      freeKind: p.freeKind, freeNote: p.freeNote, probe: p.probe,
      checkin: p.checkin === true || p.checkin === 'sharedchat',
      keyCount: mine.length,
      keys: mine,
      accounts,
      hasCredential: ['agentrouter', 'hcnsec', 'sharedchat'].includes(p.slug),
      quota: {
        state: measured.length > 0 ? 'ok' : (mine.length > 0 ? 'untested' : (p.probe === 'static' ? 'console' : 'nokey')),
        nature: measured.length > 0 ? measured[0].quota.nature : 'console',
        currency: measured.length > 0 ? measured[0].quota.currency : null,
        todayCurrency: measured.length > 0 ? measured[0].quota.todayCurrency : null,
        totalRemaining: sum('totalRemaining'),
        todayRemaining: sum('todayRemaining'),
        used: sum('used'),
        todayUsed: sum('todayUsed'),
        models: measured.length > 0 ? measured[0].quota.models : null,
        detail: mine.length > 1 ? mine.length + ' 个账号合计' : (measured[0] ? measured[0].quota.detail : '尚未添加 Key'),
        windows: measured.length > 0 ? measured[0].quota.windows : [],
      },
    }
  })
}

const FREE = {
  at: Date.now(),
  openrouter: { ok: true, total: 470, models: [
    { id: 'xingchen-agi/xing4.0-29b-a4b:free', name: 'XingChen 4.0', context: 262144, freeKind: 'long-term', note: '' },
    { id: 'deepseek/deepseek-v4.1-flash:free', name: 'DeepSeek V4.1 Flash', context: 163840, freeKind: 'long-term', note: '' },
  ] },
  opencode: { ok: true, total: 85, models: [
    { id: 'big-pickle', name: 'big-pickle', context: null, freeKind: 'daily', note: '' },
    { id: 'deepseek-v4.1-flash-free', name: 'deepseek-v4.1-flash-free', context: null, freeKind: 'daily', note: '' },
  ] },
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b || '{}'))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(PLUGIN + '/test/harness.html'))
    return
  }
  if (p === '/react.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(REACT)); return }
  if (p === '/react-dom.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(REACT_DOM)); return }
  if (p === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(PLUGIN + '/lib/client.js')); return }
  if (p === '/dsh-free-pool/providers') {
    const providers = buildProviders()
    return send(res, 200, { total: providers.length, providers })
  }
  if (p === '/dsh-free-pool/v1/route') {
    return send(res, 200, {
      profile: url.searchParams.get('profile') || 'auto',
      picked: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017', baseUrl: 'https://openrouter.ai/api/v1' },
      reason: 'OpenRouter · deepseek/deepseek-v4.1-flash-1017',
      tried: [],
      profiles: ['auto', 'auto-fast', 'auto-cheap', 'auto-code', 'auto-write'].map((id) => ({ id, name: id, hint: '' })),
    })
  }
  if (p === '/dsh-free-pool/quota') return send(res, 200, { at: Date.now(), probed: false, providers: buildProviders() })
  if (p === '/dsh-free-pool/quota/probe') {
    const body = JSON.parse(await readBody(req))
    const want = Array.isArray(body.slugs) && body.slugs.length > 0 ? new Set(body.slugs) : null
    const all = buildProviders()
    const providers = all
      .filter((x) => (want === null ? x.category !== 'custom' : want.has(x.slug)))
      .map((x) => ({ ...x, quota: { ...x.quota, state: x.quota.state === 'untested' ? 'ok' : x.quota.state } }))
    return send(res, 200, { at: Date.now(), probed: true, providers })
  }
  if (p === '/dsh-free-pool/free-models') return send(res, 200, FREE)
  if (p === '/dsh-free-pool/models') {
    const body = JSON.parse(await readBody(req))
    if (String(body.key || '').length < 8) return send(res, 400, { error: 'Key 被拒绝（HTTP 401），请确认 Key 有效且已启用该接口' })
    return send(res, 200, { baseUrl: body.baseUrl, count: 3, models: ['gpt-oss-120b', 'qwen/qwen3.8-27b', 'llama-4-scout'] })
  }
  if (p === '/dsh-free-pool/vault/add') {
    const body = JSON.parse(await readBody(req))
    const slug = body.slug || 'custom'
    const id = 'n-' + Math.random().toString(36).slice(2, 8)
    entries.push({ id, slug, label: body.label || slug, masked: 'sk-new…0000', baseUrl: body.baseUrl })
    return send(res, 200, { ok: true, id, masked: 'sk-new…0000' })
  }
  if (p === '/dsh-free-pool/vault/remove') {
    const body = JSON.parse(await readBody(req))
    entries = entries.filter((e) => e.id !== body.id)
    return send(res, 200, { ok: true })
  }
  if (p === '/dsh-free-pool/vault/export') {
    return send(res, 200, {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: 'freellmapi',
      count: entries.length,
      keys: entries.map((e) => ({ platform: e.slug, key: 'sk-real…value', label: e.label, baseUrl: e.baseUrl })),
    })
  }
  if (p === '/dsh-free-pool/vault/import') {
    const body = JSON.parse(await readBody(req))
    const keys = (body.data && body.data.keys) || body.keys || []
    return send(res, 200, { ok: true, added: keys.length, skipped: 0, errors: [], total: entries.length + keys.length })
  }
  if (p === '/dsh-free-pool/pool-models') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
    const line = (o) => res.write(JSON.stringify(o) + '\n')
    const groups = [
      { slug: 'openrouter', name: 'OpenRouter', vendor: 'OpenRouter', category: 'llm', baseUrl: 'https://openrouter.ai/api/v1', freeKind: 'long-term', keyLabel: 'OpenRouter', models: ['deepseek/deepseek-v4.1-flash:free', 'xingchen-agi/xing4.0-29b-a4b:free'], error: null },
      { slug: 'google', name: 'Google AI Studio', vendor: 'Google', category: 'llm', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', freeKind: 'long-term', keyLabel: 'Google', models: ['gemini-3.6-flash', 'gemini-3.6-pro'], error: null },
      { slug: 'groq', name: 'Groq', vendor: 'Groq', category: 'llm', baseUrl: 'https://api.groq.com/openai/v1', freeKind: 'long-term', keyLabel: 'Groq 主号', models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'], error: null },
      { slug: 'mistral', name: 'Mistral', vendor: 'Mistral', category: 'llm', baseUrl: 'https://api.mistral.ai/v1', freeKind: 'trial', keyLabel: 'Mistral', models: ['mistral-small-latest'], error: null },
      { slug: 'cerebras', name: 'Cerebras', vendor: 'Cerebras', category: 'llm', baseUrl: 'https://api.cerebras.ai/v1', freeKind: 'daily', keyLabel: 'Cerebras', models: [], error: 'Cerebras 被 Cloudflare 拦截（浏览器挑战页），此网络环境无法直连' },
    ]
    line({ kind: 'init', at: Date.now(), groups: groups.slice(0, 2) })
    for (const g of groups.slice(2)) line({ kind: 'group', group: g })
    line({ kind: 'done', at: Date.now() })
    res.end()
    return
  }
  if (p === '/dsh-free-pool/speed-test') {
    const body = JSON.parse(await readBody(req))
    const id = String(body.entryId || '')
    if (id.startsWith('groq')) {
      return send(res, 200, { ok: true, status: 200, model: 'openai/gpt-oss-120b', baseUrl: 'https://api.groq.com/openai/v1', ttftMs: 268, totalMs: 764, tokens: 18, tokensSource: 'usage', chars: 73, tps: 36.3, grade: 'excellent' })
    }
    if (id.startsWith('openrouter')) {
      return send(res, 200, { ok: true, status: 200, model: 'xingchen-agi/xing4.0-29b-a4b:free', baseUrl: 'https://openrouter.ai/api/v1', ttftMs: 4101, totalMs: 4342, tokens: 64, tokensSource: 'usage', chars: 238, tps: 265.6, grade: 'slow' })
    }
    return send(res, 200, { ok: false, status: 429, model: 'google/gemma-4-31b-it:free', baseUrl: 'https://openrouter.ai/api/v1', error: 'Provider returned error', ttftMs: null, totalMs: 3324 })
  }
  if (p === '/dsh-free-pool/checkin') return send(res, 200, { ok: true, message: '签到成功，获得 $5' })
  if (p === '/dsh-free-pool/checkin-all') return send(res, 200, { results: [{ slug: 'sharedchat', name: 'sharedchat', ok: true, message: '当前套餐仍在有效期内' }] })
  send(res, 404, { error: 'not found' })
})

const port = Number(process.env.PORT || 8791)
server.listen(port, '127.0.0.1', () => console.log('harness on http://127.0.0.1:' + port))
