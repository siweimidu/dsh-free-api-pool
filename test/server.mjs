/**
 * Renders the real client.js in a browser against a stubbed host, so the panel can be
 * inspected visually and driven without booting DSH. Serves the plugin's own file plus a
 * fixture host that mirrors the real route payloads.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'

const PLUGIN = 'C:/Users/35238/.dsh/profiles/desktop/dsh-free-api-pool'
const REACT = 'C:/Users/35238/.dsh/profiles/node_modules/react/umd/react.development.js'
const REACT_DOM = 'C:/Users/35238/.dsh/profiles/node_modules/react-dom/umd/react-dom.development.js'

// ── fixture host: real payload shapes captured from lib/index.js ───────────
const PROVIDERS = JSON.parse(readFileSync(PLUGIN + '/data/providers.json', 'utf8')).providers

const QUOTA = {
  at: Date.now(),
  providers: PROVIDERS.map((p) => {
    let quota
    if (p.slug === 'groq') {
      quota = { state: 'ok', nature: 'rate-limit', currency: 'requests', todayCurrency: 'requests', totalRemaining: 999, todayRemaining: 999, used: 1, todayUsed: null, models: 11, detail: '免费层实测：每分钟 1000 次请求，剩余 999 次（每次调用刷新）', windows: [{ label: '每分钟请求', unit: 'requests', limit: 1000, remaining: 999, used: 1, reset: '1m26.4s' }, { label: '每分钟 token', unit: 'tokens', limit: 8000, remaining: 7923, used: 77, reset: '577ms' }] }
    } else if (p.slug === 'openrouter') {
      quota = { state: 'ok', nature: 'balance', currency: 'USD', todayCurrency: 'models', totalRemaining: null, todayRemaining: 19, used: 0.2022, todayUsed: null, models: 19, detail: '免费层账号，当前 19 个模型免费，无付费余额（免费层）', windows: [] }
    } else if (p.slug === 'moonshot') {
      quota = { state: 'ok', nature: 'balance', currency: 'CNY', todayCurrency: null, totalRemaining: 3.37, todayRemaining: null, used: null, todayUsed: null, models: null, detail: '代金券 3.3670201 / 现金 0', windows: [] }
    } else if (p.slug === 'github') {
      quota = { state: 'ok', nature: 'rate-limit', currency: 'requests', todayCurrency: 'requests', totalRemaining: 4990, todayRemaining: 4990, used: 10, todayUsed: null, models: null, detail: 'GitHub API 速率额度（非模型额度），于 00:33:34 重置', windows: [] }
    } else if (p.slug === 'hcnsec') {
      quota = { state: 'error', nature: 'none', currency: null, todayCurrency: null, totalRemaining: null, todayRemaining: null, used: null, todayUsed: null, models: null, detail: 'Key 被拒绝（HTTP 401）', windows: [] }
    } else if (p.probe === 'static') {
      quota = { state: 'console', nature: 'console', currency: null, todayCurrency: null, totalRemaining: null, todayRemaining: null, used: null, todayUsed: null, models: null, detail: (p.freeNote || '免费额度') + '，该平台未开放余额接口，需在控制台查看', windows: [] }
    } else {
      quota = { state: 'nokey', nature: 'none', currency: null, todayCurrency: null, totalRemaining: null, todayRemaining: null, used: null, todayUsed: null, models: null, detail: '尚未添加 Key，添加后可自动查询', windows: [] }
    }
    const keyed = ['groq', 'openrouter', 'moonshot', 'github'].includes(p.slug)
    return {
      slug: p.slug, name: p.name, vendor: p.vendor, category: p.category,
      baseUrl: p.baseUrl, applyUrl: p.applyUrl, docsUrl: p.docsUrl,
      freeKind: p.freeKind, freeNote: p.freeNote, probe: p.probe,
      checkin: p.checkin === true || p.checkin === 'sharedchat',
      keyCount: keyed ? 1 : 0,
      keyLabels: keyed ? [p.name + ' 主号'] : [],
      hasCredential: ['agentrouter', 'hcnsec', 'sharedchat'].includes(p.slug),
      quota,
    }
  }),
}

const FREE = {
  at: Date.now(),
  openrouter: {
    ok: true, total: 470, models: [
      { id: 'xingchen-agi/xing4.0-29b-a4b:free', name: 'XingChen 4.0', context: 262144, freeKind: 'long-term', note: '' },
      { id: 'deepseek/deepseek-v4.1-flash:free', name: 'DeepSeek V4.1 Flash', context: 163840, freeKind: 'long-term', note: '' },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', context: 131072, freeKind: 'long-term', note: '' },
      { id: 'liquid/lfm-2.5-2.6b:free', name: 'LFM 2.5', context: 32768, freeKind: 'long-term', note: '' },
    ],
  },
  opencode: {
    ok: true, total: 85, models: [
      { id: 'big-pickle', name: 'big-pickle', context: null, freeKind: 'daily', note: '' },
      { id: 'beam-free', name: 'beam-free', context: null, freeKind: 'daily', note: '' },
      { id: 'mimo-v2.6-flash-free', name: 'mimo-v2.6-flash-free', context: null, freeKind: 'daily', note: '' },
      { id: 'deepseek-v4.1-flash-free', name: 'deepseek-v4.1-flash-free', context: null, freeKind: 'daily', note: '' },
    ],
  },
}

const KEYED = PROVIDERS.filter((p) => ['groq', 'openrouter', 'moonshot', 'github'].includes(p.slug))
  .map((p, i) => ({ id: 'k' + i, slug: p.slug, label: p.name + ' 主号', masked: 'sk-ab…cd12', baseUrl: p.baseUrl }))
let providersState = QUOTA.providers.map((p) => ({ ...p, keys: KEYED.filter((k) => k.slug === p.slug) }))

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
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
  if (p === '/dsh-free-pool/providers') return send(res, 200, { total: providersState.length, providers: providersState })
  if (p === '/dsh-free-pool/quota') return send(res, 200, { at: Date.now(), providers: providersState })
  if (p === '/dsh-free-pool/free-models') return send(res, 200, FREE)
  if (p === '/dsh-free-pool/models') {
    const body = JSON.parse(await readBody(req))
    if (String(body.key || '').length < 8) return send(res, 400, { error: 'Key 被拒绝（HTTP 401），请确认 Key 有效且已启用该接口' })
    return send(res, 200, { baseUrl: body.baseUrl, count: 3, models: ['gpt-oss-120b', 'qwen/qwen3.8-27b', 'llama-4-scout'] })
  }
  if (p === '/dsh-free-pool/vault/add') {
    const body = JSON.parse(await readBody(req))
    const id = 'k' + Math.random().toString(36).slice(2, 8)
    providersState = providersState.map((x) => x.slug === body.slug
      ? { ...x, keyCount: x.keyCount + 1, keys: [...(x.keys || []), { id, slug: body.slug, label: body.label || x.name, masked: 'sk-ab…cd12', baseUrl: body.baseUrl }] }
      : x)
    return send(res, 200, { ok: true, id, masked: 'sk-ab…cd12' })
  }
  if (p === '/dsh-free-pool/vault/remove') {
    const body = JSON.parse(await readBody(req))
    providersState = providersState.map((x) => ({
      ...x,
      keys: (x.keys || []).filter((k) => k.id !== body.id),
      keyCount: (x.keys || []).filter((k) => k.id !== body.id).length,
    }))
    return send(res, 200, { ok: true })
  }
  if (p === '/dsh-free-pool/vault/export') return send(res, 200, { schema: 'dsh-free-api-pool/vault-export/v1', exportedAt: new Date().toISOString(), count: 4, entries: KEYED.map((k) => ({ ...k, key: 'sk-real-key-value' })) })
  if (p === '/dsh-free-pool/checkin') return send(res, 200, { ok: true, message: '签到成功，获得 $5' })
  if (p === '/dsh-free-pool/checkin-all') return send(res, 200, { results: [{ slug: 'sharedchat', name: 'sharedchat', ok: true, message: '当前套餐仍在有效期内，到期后可以再次领取' }, { slug: 'hcnsec', name: '新疆幻城', ok: false, message: '该站登录需要 Cloudflare 人机验证，无法自动签到' }] })
  send(res, 404, { error: 'not found' })
})

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b || '{}'))
  })
}

server.listen(8791, '127.0.0.1', () => console.log('harness on http://127.0.0.1:8791'))
