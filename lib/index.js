/**
 * dsh-free-api-pool — host half (v2).
 *
 * Owns, in this process only:
 *  - the provider catalog (data/providers.json): base URL, apply-page URL, free-tier kind,
 *  - the key vault (data/vault.json): keys the user adds from the panel, never sent back raw
 *    except through the explicit export route,
 *  - model discovery: POST a key and get that platform's real model IDs back,
 *  - daily free-model discovery for OpenRouter (`:free`) and OpenCode (`-free`),
 *  - quota probes that report a number only when the platform actually measured one,
 *  - best-effort check-in for relays that grant credit for it.
 *
 * Reporting rule (learned by probing these platforms live): a figure is shown only when the
 * platform publishes it. one-api/new-api relays answer billing/subscription with
 * `hard_limit_usd: 1e8`, a placeholder for "unlimited", so they report usage only. Platforms
 * with no balance endpoint are reported as console-only rather than guessed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-free-api-pool'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(PLUGIN_DIR, 'data')
const PROVIDERS_FILE = join(DATA_DIR, 'providers.json')
const VAULT_FILE = join(DATA_DIR, 'vault.json')
const TIMEOUT_MS = 15000
const CONCURRENCY = 6
const UA = 'dsh-free-api-pool/0.2.0'

/** Relay placeholder for "unlimited"; never a real quota. */
const SENTINEL = 1e8

let config = {
  credentialsFile: 'C:\\Users\\35238\\Documents\\夸克密码.csv',
}

// ── providers ──────────────────────────────────────────────────────────────

let providersCache = null

function loadProviders() {
  if (providersCache !== null) return providersCache
  try {
    providersCache = JSON.parse(readFileSync(PROVIDERS_FILE, 'utf8'))
  } catch (error) {
    providersCache = { schema: 'dsh-free-api-pool/providers/v2', providers: [] }
  }
  return providersCache
}

function findProvider(slug) {
  return (loadProviders().providers || []).find((p) => p.slug === slug)
}

// ── vault ──────────────────────────────────────────────────────────────────

/**
 * Vault shape:
 *   { schema, entries: [{ id, slug, label, baseUrl, key, addedAt }] }
 * Keys live here, in the host process. The list route masks them; only the export route
 * returns them, and only when the user asked for an export.
 */
let vaultCache = null

function loadVault() {
  if (vaultCache !== null) return vaultCache
  try {
    const parsed = JSON.parse(readFileSync(VAULT_FILE, 'utf8'))
    vaultCache = Array.isArray(parsed.entries) ? parsed : { schema: 'dsh-free-api-pool/vault/v1', entries: [] }
  } catch (error) {
    vaultCache = { schema: 'dsh-free-api-pool/vault/v1', entries: [] }
  }
  return vaultCache
}

function saveVault() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(VAULT_FILE, JSON.stringify(loadVault(), null, 2), 'utf8')
}

function maskKey(key) {
  const raw = String(key ?? '')
  if (raw.length <= 10) return raw === '' ? '' : '••••'
  return raw.slice(0, 6) + '…' + raw.slice(-4)
}

function entriesFor(slug) {
  return loadVault().entries.filter((e) => e.slug === slug)
}

/** First usable key for a slug, from the vault only. */
function keyFor(slug) {
  const hit = entriesFor(slug).find((e) => typeof e.key === 'string' && e.key !== '')
  return hit === undefined ? '' : hit.key
}

function addEntry({ slug, label, baseUrl, key }) {
  const provider = findProvider(slug)
  if (provider === undefined) throw new Error('未知平台：' + slug)
  const raw = String(key ?? '').trim()
  if (raw === '') throw new Error('Key 不能为空')
  const vault = loadVault()
  const dup = vault.entries.find((e) => e.slug === slug && e.key === raw)
  if (dup !== undefined) throw new Error('这个 Key 已经添加过了')
  const entry = {
    id: randomUUID(),
    slug,
    label: String(label ?? '').trim() || provider.name,
    baseUrl: String(baseUrl ?? '').trim() || provider.baseUrl,
    key: raw,
    addedAt: new Date().toISOString(),
  }
  vault.entries.push(entry)
  saveVault()
  return entry
}

function removeEntry(id) {
  const vault = loadVault()
  const index = vault.entries.findIndex((e) => e.id === id)
  if (index < 0) throw new Error('找不到这条 Key')
  const [removed] = vault.entries.splice(index, 1)
  saveVault()
  return removed
}

// ── credentials CSV (relay accounts, never returned) ───────────────────────

function parseCsvLine(line) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i += 1 } else { quoted = false }
      } else { cell += ch }
    } else if (ch === '"') { quoted = true }
    else if (ch === ',') { cells.push(cell); cell = '' }
    else { cell += ch }
  }
  cells.push(cell)
  return cells
}

let credentialsCache = null

function loadCredentials() {
  const file = config.credentialsFile
  if (credentialsCache !== null && credentialsCache.file === file) return credentialsCache.rows
  const rows = []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    credentialsCache = { file, rows }
    return rows
  }
  const lines = text.split(/\r?\n/)
  const header = lines.length > 0 ? parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase()) : []
  const idx = {
    name: header.indexOf('name'),
    url: header.indexOf('url'),
    username: header.indexOf('username'),
    password: header.indexOf('password'),
  }
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const cells = parseCsvLine(line)
    const pick = (key) => (idx[key] >= 0 && idx[key] < cells.length ? cells[idx[key]].trim() : '')
    rows.push({
      name: pick('name'),
      url: pick('url'),
      host: hostOf(pick('url')),
      username: pick('username'),
      password: pick('password'),
    })
  }
  credentialsCache = { file, rows }
  return rows
}

function hostOf(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  try {
    return new URL(raw.includes('://') ? raw : 'https://' + raw).hostname.toLowerCase()
  } catch (error) {
    return ''
  }
}

function credentialsFor(provider) {
  const rows = loadCredentials()
  const want = hostOf(provider.baseUrl)
  if (want === '') return []
  const out = []
  for (const row of rows) {
    const h = row.host
    if (h === '') continue
    if (h === want || h.endsWith('.' + want) || want.endsWith('.' + h)) out.push(row)
  }
  return out.filter((r) => r.username !== '' && r.password !== '')
}

// ── http ───────────────────────────────────────────────────────────────────

async function httpJson(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const headers = { 'user-agent': UA, accept: 'application/json', ...(options.headers ?? {}) }
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch (error) { json = null }
    return { ok: response.ok, status: response.status, json, text, headers: response.headers }
  } catch (error) {
    const message = error && error.name === 'AbortError' ? '请求超时' : String((error && error.message) || error)
    return { ok: false, status: 0, json: null, text: '', error: message }
  } finally {
    clearTimeout(timer)
  }
}

function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function round(value, digits = 4) {
  if (value === null || value === undefined) return null
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function pad2(n) { return String(n).padStart(2, '0') }

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function trimBase(url) { return String(url || '').replace(/\/+$/, '') }

/**
 * Relay web-API roots, most-likely first. one-api / new-api serve `/api/*` and
 * `/dashboard/*` at the site root, so a base URL ending in /v1 must be stripped before
 * those paths are appended — appending to /v1 yields a 404 that looks like a login failure.
 */
function relayRoots(base) {
  const trimmed = trimBase(base)
  const roots = []
  if (/\/v1$/.test(trimmed)) roots.push(trimmed.replace(/\/v1$/, ''))
  roots.push(trimmed)
  return [...new Set(roots)]
}

function authHeader(key) { return { authorization: 'Bearer ' + key } }

function rejected(res) { return res.status === 401 || res.status === 403 }

// ── model discovery ────────────────────────────────────────────────────────

/** Pull model IDs out of whichever list shape a platform answers with. */
function extractModels(json, provider) {
  if (json === null || typeof json !== 'object') return []
  const list = Array.isArray(json.data) ? json.data
    : Array.isArray(json.models) ? json.models
      : Array.isArray(json) ? json
        : []
  const strip = provider && typeof provider.modelsStripPrefix === 'string' ? provider.modelsStripPrefix : ''
  const ids = []
  for (const item of list) {
    let id = null
    if (typeof item === 'string') id = item
    else if (item && typeof item === 'object') {
      id = item.id ?? item.name ?? item.model ?? null
    }
    if (typeof id !== 'string' || id === '') continue
    if (strip !== '' && id.startsWith(strip)) id = id.slice(strip.length)
    ids.push(id)
  }
  return [...new Set(ids)]
}

/**
 * Ask a platform for its model list using a key the user just typed. This is the
 * "fill base URL + key, get model IDs automatically" path.
 */
async function discoverModels({ slug, baseUrl, key }) {
  const provider = slug ? findProvider(slug) : undefined
  const base = trimBase(baseUrl || (provider && provider.baseUrl) || '')
  if (base === '') throw new Error('缺少 Base URL')
  const token = String(key ?? '').trim()
  if (token === '') throw new Error('缺少 API Key')

  // Google's OpenAI-compatible surface answers at /models but needs the key as a query
  // parameter as well as a bearer token on some deployments; the bearer alone works here.
  const res = await httpJson(base + '/models', { headers: authHeader(token) })
  if (res.status === 0) throw new Error('无法连接 ' + base + '：' + (res.error ?? '网络错误'))
  if (rejected(res)) throw new Error('Key 被拒绝（HTTP ' + res.status + '），请确认 Key 有效且已启用该接口')
  if (!res.ok) {
    const msg = (res.json && (res.json.message || (res.json.error && res.json.error.message))) || ('HTTP ' + res.status)
    throw new Error('获取模型失败：' + String(msg).slice(0, 160))
  }
  const models = extractModels(res.json, provider)
  if (models.length === 0) throw new Error('接口返回成功，但没有解析到模型 ID')
  return { baseUrl: base, count: models.length, models }
}

// ── speed test ─────────────────────────────────────────────────────────────

/**
 * Measure a key end to end: time to first token, output throughput, total wall time.
 *
 * The measurement is taken from the streaming SSE frames themselves rather than from a
 * non-streaming response, because TTFT is the number that tells a user whether a free tier
 * is usable interactively — a total-only figure hides a 10-second stall behind a fast tail.
 *
 * Token counting prefers the provider's own `usage` object when the stream ends with one;
 * otherwise it counts content deltas, which is what `n` deltas means for these APIs. The
 * two are labelled differently in the result so the UI never claims a precision it lacks.
 */
async function speedTest({ slug, entryId, model, prompt }) {
  const provider = slug ? findProvider(slug) : undefined
  const entry = entryId
    ? loadVault().entries.find((e) => e.id === entryId)
    : loadVault().entries.find((e) => e.slug === slug)
  if (entry === undefined) throw new Error('找不到这条 Key，请先在「密钥」页添加')

  const base = trimBase(entry.baseUrl || (provider && provider.baseUrl) || '')
  if (base === '') throw new Error('该 Key 没有 Base URL')

  // Pick a model: the caller's choice, else the first *chat* model the platform lists.
  // Guard / embedding / TTS / image / rerank models either reject streaming or return no
  // text, which would make the measurement meaningless rather than merely slow.
  const NON_CHAT = /guard|embed|rerank|whisper|tts|orpheus|speech|audio|dall|image|vision-only|moderation|classif|prompt-guard|safety/i
  let chosen = String(model ?? '').trim()
  if (chosen === '') {
    const listed = await discoverModels({ slug, baseUrl: base, key: entry.key }).catch(() => null)
    if (listed !== null) {
      chosen = listed.models.find((id) => !NON_CHAT.test(id)) ?? ''
    }
  }
  if (chosen === '') throw new Error('无法确定要测速的模型，请先读取模型 ID')

  const text = String(prompt ?? '').trim() || '用一句话介绍你自己'
  const body = {
    model: chosen,
    stream: true,
    // A short, deterministic ask keeps the measurement about latency, not about how much
    // prose the model felt like writing.
    messages: [{ role: 'user', content: text }],
    max_tokens: 64,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  const startedAt = Date.now()
  let firstByteAt = null
  let firstTokenAt = null
  let endedAt = null
  let deltas = 0
  let chars = 0
  let usageTokens = null
  let statusCode = 0
  let failure = null

  try {
    const response = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'user-agent': UA,
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...authHeader(entry.key),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    statusCode = response.status
    if (!response.ok) {
      const errText = await response.text()
      let msg = 'HTTP ' + response.status
      try {
        const parsed = JSON.parse(errText)
        msg = (parsed.error && parsed.error.message) || parsed.message || msg
      } catch (error) { /* keep the status line */ }
      failure = String(msg).slice(0, 200)
    } else if (response.body === null) {
      failure = '上游没有返回流式响应体'
    } else {
      firstByteAt = Date.now()
      const decoder = new TextDecoder()
      let buffer = ''
      let done = false
      for await (const chunk of response.body) {
        if (firstByteAt === null) firstByteAt = Date.now()
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        // SSE frames are separated by a blank line; keep the tail for the next chunk.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '' || payload === '[DONE]') { if (payload === '[DONE]') done = true; continue }
            let json = null
            try { json = JSON.parse(payload) } catch (error) { continue }
            if (json.usage && num(json.usage.completion_tokens) !== null) {
              usageTokens = num(json.usage.completion_tokens)
            }
            const choice = Array.isArray(json.choices) ? json.choices[0] : null
            const delta = choice && choice.delta ? choice.delta : null
            // Reasoning models stream their thinking in `delta.reasoning` before any
            // `delta.content` arrives (verified against Groq's gpt-oss). Both are output
            // the user waits for, so both count as a first token.
            const piece = delta === null ? ''
              : typeof delta.content === 'string' && delta.content !== '' ? delta.content
                : typeof delta.reasoning === 'string' ? delta.reasoning : ''
            if (piece !== '') {
              if (firstTokenAt === null) firstTokenAt = Date.now()
              deltas += 1
              chars += piece.length
            }
          }
        }
        if (done) break
      }
      endedAt = Date.now()
    }
  } catch (error) {
    failure = error && error.name === 'AbortError'
      ? '测速超时（45 秒）'
      : String((error && error.message) || error)
  } finally {
    clearTimeout(timer)
  }

  const end = endedAt ?? Date.now()
  if (failure !== null) {
    return {
      ok: false,
      status: statusCode,
      model: chosen,
      baseUrl: base,
      error: failure,
      ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
      totalMs: end - startedAt,
    }
  }

  const ttftMs = firstTokenAt === null ? null : firstTokenAt - startedAt
  const generationMs = firstTokenAt === null ? null : end - firstTokenAt
  const tokens = usageTokens ?? deltas
  const tps = generationMs !== null && generationMs > 0 && tokens > 0
    ? round(tokens / (generationMs / 1000), 1)
    : null

  return {
    ok: true,
    status: statusCode,
    model: chosen,
    baseUrl: base,
    ttftMs,
    totalMs: end - startedAt,
    tokens,
    tokensSource: usageTokens !== null ? 'usage' : 'deltas',
    chars,
    tps,
    // A rough quality-of-experience label, so the list can be sorted at a glance.
    grade: ttftMs === null ? 'unknown'
      : ttftMs < 600 ? 'excellent'
        : ttftMs < 1500 ? 'good'
          : ttftMs < 3000 ? 'fair' : 'slow',
  }
}

// ── free model discovery (OpenRouter / OpenCode) ───────────────────────────

/**
 * OpenRouter publishes per-model pricing; a model priced 0 on both prompt and completion
 * is free right now. `:free` in the ID is the same fact, but pricing is the authority.
 */
async function freeModelsOpenRouter() {
  const res = await httpJson('https://openrouter.ai/api/v1/models')
  if (!res.ok || res.json === null) return { ok: false, error: 'OpenRouter 模型清单获取失败', models: [] }
  const all = Array.isArray(res.json.data) ? res.json.data : []
  const free = all.filter((m) => {
    const p = m.pricing ?? {}
    return num(p.prompt) === 0 && num(p.completion) === 0
  })
  return {
    ok: true,
    total: all.length,
    models: free.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: num(m.context_length),
      freeKind: 'long-term',
      note: '当前定价为 0（prompt/completion 均免费）',
    })),
  }
}

/**
 * OpenCode Zen has no pricing endpoint; its free tier is the `-free` suffix convention,
 * which the model list itself shows.
 */
async function freeModelsOpenCode() {
  const key = keyFor('opencode')
  const res = await httpJson('https://opencode.ai/zen/v1/models', key === '' ? {} : { headers: authHeader(key) })
  if (!res.ok || res.json === null) return { ok: false, error: 'OpenCode 模型清单获取失败', models: [] }
  const all = extractModels(res.json, undefined)
  const free = all.filter((id) => /-free$/.test(id))
  return {
    ok: true,
    total: all.length,
    models: free.map((id) => ({
      id,
      name: id,
      context: null,
      freeKind: 'daily',
      note: '带 -free 后缀，免费模型清单每日可能变化',
    })),
  }
}

async function freeModels() {
  const [openrouter, opencode] = await Promise.all([freeModelsOpenRouter(), freeModelsOpenCode()])
  return { at: Date.now(), openrouter, opencode }
}

// ── quota shape ────────────────────────────────────────────────────────────
//
// { state, nature, currency, todayCurrency, totalRemaining, todayRemaining, used,
//   todayUsed, models, detail, windows }
// nature: balance | daily-quota | usage-only | rate-limit | console | none
// state:  ok | console | nokey | error
// windows: [{ label, limit, remaining, used, reset, unit }] — per-window rate limits, which
// is the only real headroom Groq / Google / Cerebras publish.

function blank(state, nature, detail, extra = {}) {
  return {
    state,
    nature,
    currency: null,
    todayCurrency: null,
    totalRemaining: null,
    todayRemaining: null,
    used: null,
    todayUsed: null,
    models: null,
    detail,
    windows: [],
    ...extra,
  }
}

function reject(res) {
  return blank('error', 'none', 'Key 被拒绝（HTTP ' + res.status + '）')
}

function upstreamError(res) {
  const msg = (res.json && (res.json.message || (res.json.error && res.json.error.message))) || res.error || ('HTTP ' + res.status)
  return blank('error', 'none', String(msg).slice(0, 120))
}

/** Read x-ratelimit-* headers into window descriptors (Groq, and any OpenAI-compatible peer). */
function rateWindows(headers) {
  if (!headers || typeof headers.get !== 'function') return []
  const pick = (name) => headers.get(name)
  const windows = []
  const add = (label, unit, limitName, remainingName, resetName) => {
    const limit = num(pick(limitName))
    const remaining = num(pick(remainingName))
    if (limit === null && remaining === null) return
    windows.push({
      label,
      unit,
      limit,
      remaining,
      used: limit !== null && remaining !== null ? limit - remaining : null,
      reset: pick(resetName) || null,
    })
  }
  add('每分钟请求', 'requests', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests')
  add('每分钟 token', 'tokens', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens')
  return windows
}

// ── probes ─────────────────────────────────────────────────────────────────

/**
 * Groq publishes per-window rate limits on every response but no balance. The header is the
 * measurement, so the panel shows the requests window instead of inventing a total.
 */
async function probeGroq(provider, key) {
  const base = trimBase(provider.baseUrl)
  const models = await httpJson(base + '/models', { headers: authHeader(key) })
  if (rejected(models)) return reject(models)
  if (!models.ok) return upstreamError(models)
  const list = extractModels(models.json, provider)

  // A tiny completion is the only way to obtain the live x-ratelimit-* headers: /models does
  // not carry them. One token of output keeps the cost negligible.
  let windows = []
  let detail = '免费层按分钟限速，额度随请求实时刷新'
  const first = list.find((id) => !/whisper|tts|guard/i.test(id)) || list[0]
  if (first !== undefined) {
    const probe = await httpJson(base + '/chat/completions', {
      method: 'POST',
      headers: { ...authHeader(key), 'content-type': 'application/json' },
      body: JSON.stringify({ model: first, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    })
    if (probe.headers !== undefined) windows = rateWindows(probe.headers)
    if (windows.length > 0) {
      const w = windows[0]
      detail = `免费层实测：每分钟 ${w.limit ?? '?'} 次请求，剩余 ${w.remaining ?? '?'} 次（每次调用刷新）`
    }
  }
  const primary = windows[0]
  return {
    state: 'ok',
    nature: 'rate-limit',
    currency: 'requests',
    todayCurrency: 'requests',
    totalRemaining: primary !== undefined ? primary.remaining : null,
    todayRemaining: primary !== undefined ? primary.remaining : null,
    used: primary !== undefined ? primary.used : null,
    todayUsed: null,
    models: list.length,
    detail,
    windows,
  }
}

async function probeRelay(provider, key) {
  const roots = relayRoots(provider.baseUrl)
  const subUrls = []
  for (const root of roots) {
    subUrls.push(root + '/dashboard/billing/subscription')
    if (!/\/v1$/.test(root)) subUrls.push(root + '/v1/dashboard/billing/subscription')
  }
  let sub = null
  let root = roots[0]
  for (const url of subUrls) {
    const res = await httpJson(url, { headers: authHeader(key) })
    if (rejected(res)) return reject(res)
    if (res.ok && res.json !== null) {
      sub = res.json
      root = url.replace(/\/dashboard\/billing\/subscription$/, '')
      break
    }
  }
  if (sub === null) return blank('console', 'console', '该中转站未开放余额接口')

  const limit = num(sub.hard_limit_usd) ?? num(sub.system_hard_limit_usd) ?? num(sub.soft_limit_usd)
  const unlimited = limit !== null && limit >= SENTINEL

  const today = localDate()
  const lifetime = await httpJson(root + '/dashboard/billing/usage?start_date=1970-01-01&end_date=' + today, { headers: authHeader(key) })
  const toUsd = (res) => {
    if (!res.ok || res.json === null) return null
    const cents = num(res.json.total_usage)
    return cents === null ? null : round(cents / 100, 4)
  }
  const used = toUsd(lifetime)
  if (used === null) return blank('console', 'console', '余额接口可用，但该站未返回用量数字')
  return {
    state: 'ok',
    nature: 'usage-only',
    currency: 'USD',
    totalRemaining: null,
    todayRemaining: null,
    used,
    todayUsed: null,
    models: null,
    detail: unlimited ? '该站声明不限额度，仅能读出累计已用金额' : '已用金额来自该站账单接口（仅累计值）；总额度未公开',
    windows: [],
  }
}

async function probeOpenRouter(provider, key) {
  const res = await httpJson('https://openrouter.ai/api/v1/key', { headers: authHeader(key) })
  if (rejected(res)) return reject(res)
  if (!res.ok || res.json === null) return upstreamError(res)
  const d = res.json.data ?? {}
  const usage = num(d.usage)
  const credits = await httpJson('https://openrouter.ai/api/v1/credits', { headers: authHeader(key) })
  const totalCredits = credits.ok && credits.json !== null ? num((credits.json.data ?? {}).total_credits) : null
  // Free-tier accounts spend into a negative allowance; a negative "remaining" would read as
  // a debt, so it is reported as no credit balance instead.
  const raw = totalCredits === null || usage === null ? null : round(totalCredits - usage, 4)
  const balance = raw !== null && raw > 0 ? raw : null

  // The free-model allowance is a per-day request budget, reported separately from credits.
  const free = await freeModelsOpenRouter()
  const freeCount = free.ok ? free.models.length : null
  const isFreeTier = d.is_free_tier === true
  return {
    state: 'ok',
    nature: 'balance',
    currency: 'USD',
    todayCurrency: 'models',
    totalRemaining: balance,
    todayRemaining: freeCount,
    used: usage,
    todayUsed: null,
    models: freeCount,
    detail: (isFreeTier ? '免费层账号' : '付费账号')
      + (freeCount !== null ? `，当前 ${freeCount} 个模型免费` : '')
      + (balance !== null ? `，余额 $${balance}` : '，无付费余额（免费层）'),
    windows: [],
  }
}

async function probeMoonshot(provider, key) {
  const base = trimBase(provider.baseUrl || 'https://api.moonshot.cn/v1')
  const res = await httpJson(base + '/users/me/balance', { headers: authHeader(key) })
  if (rejected(res)) return reject(res)
  if (!res.ok || res.json === null) return upstreamError(res)
  const d = res.json.data ?? {}
  return {
    state: 'ok',
    nature: 'balance',
    currency: 'CNY',
    todayCurrency: null,
    totalRemaining: num(d.available_balance),
    todayRemaining: null,
    used: null,
    todayUsed: null,
    models: null,
    detail: '代金券 ' + (num(d.voucher_balance) ?? 0) + ' / 现金 ' + (num(d.cash_balance) ?? 0),
    windows: [],
  }
}

async function probeGithub(provider, key) {
  const res = await httpJson('https://api.github.com/rate_limit', {
    headers: { authorization: 'Bearer ' + key, accept: 'application/vnd.github+json' },
  })
  if (rejected(res)) return reject(res)
  if (!res.ok || res.json === null) return upstreamError(res)
  const core = (res.json.resources ?? {}).core ?? {}
  const remaining = num(core.remaining)
  const limit = num(core.limit)
  const reset = num(core.reset)
  return {
    state: 'ok',
    nature: 'rate-limit',
    currency: 'requests',
    todayCurrency: 'requests',
    totalRemaining: remaining,
    todayRemaining: remaining,
    used: limit !== null && remaining !== null ? limit - remaining : null,
    todayUsed: null,
    models: null,
    detail: reset === null
      ? 'GitHub API 速率额度（非模型额度）'
      : 'GitHub API 速率额度（非模型额度），于 ' + new Date(reset * 1000).toLocaleTimeString('zh-CN') + ' 重置',
    windows: [],
  }
}

async function probeModels(provider, key) {
  const base = trimBase(provider.baseUrl)
  if (base === '') return blank('console', 'console', '该平台未公开 API 地址，请查看其控制台')
  const res = await httpJson(base + '/models', { headers: authHeader(key) })
  if (rejected(res)) return reject(res)
  if (!res.ok) return upstreamError(res)
  const list = extractModels(res.json, provider)
  return blank('console', 'console',
    '接口正常，可用模型 ' + list.length + ' 个；该平台未开放余额接口，请在控制台查看', {
      models: list.length,
    })
}

async function probeProvider(provider) {
  const key = keyFor(provider.slug)
  const probe = provider.probe || 'models'
  if (probe === 'static') {
    const note = provider.checkin === 'sharedchat'
      ? '该站每日签到送 $50 Codex 额度，额度需在站内控制台查看'
      : (provider.freeNote || '免费额度') + '，该平台未开放余额接口，需在控制台查看'
    return blank('console', 'console', note)
  }
  if (key === '') return blank('nokey', 'none', '尚未添加 Key，添加后可自动查询')
  switch (probe) {
    case 'billing': return probeRelay(provider, key)
    case 'openrouter': return probeOpenRouter(provider, key)
    case 'moonshot': return probeMoonshot(provider, key)
    case 'github': return probeGithub(provider, key)
    case 'groq': return probeGroq(provider, key)
    case 'models': return probeModels(provider, key)
    default: return probeModels(provider, key)
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = []
  for (let i = 0; i < size; i += 1) {
    runners.push((async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        try { out[index] = await worker(items[index], index) }
        catch (error) { out[index] = blank('error', 'none', String((error && error.message) || error)) }
      }
    })())
  }
  await Promise.all(runners)
  return out
}

async function buildQuota() {
  const providers = loadProviders().providers || []
  const results = await mapLimit(providers, CONCURRENCY, async (provider) => {
    const quota = await probeProvider(provider)
    const entries = entriesFor(provider.slug)
    const creds = credentialsFor(provider)
    return {
      slug: provider.slug,
      name: provider.name,
      vendor: provider.vendor,
      category: provider.category,
      baseUrl: provider.baseUrl,
      applyUrl: provider.applyUrl,
      docsUrl: provider.docsUrl,
      freeKind: provider.freeKind,
      freeNote: provider.freeNote,
      probe: provider.probe,
      checkin: provider.checkin === true || provider.checkin === 'sharedchat',
      keyCount: entries.length,
      keyLabels: entries.map((e) => e.label),
      hasCredential: creds.length > 0,
      quota,
    }
  })
  return { at: Date.now(), providers: results }
}

// ── check-in ───────────────────────────────────────────────────────────────

function checkinBlocked(message, provider) {
  if (provider && provider.checkinBlocked) return provider.checkinBlocked
  if (/turnstile|人机验证|captcha/i.test(message)) {
    return '该站登录需要 Cloudflare 人机验证，无法自动签到，请在网页手动签到'
  }
  if (/用户名或密码错误|封禁/.test(message)) {
    return '账号或密码错误（' + message + '），请更新凭据文件后重试'
  }
  return message
}

async function checkinRelay(provider) {
  const creds = credentialsFor(provider)
  if (creds.length === 0) throw new Error('未在凭据文件中找到 ' + provider.name + ' 的账号')
  const cred = creds[0]
  const root = relayRoots(provider.baseUrl)[0]
  const login = await httpJson(root + '/api/user/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: cred.username, password: cred.password }),
  })
  if (login.json === null) throw new Error('登录失败：' + (login.error ?? 'HTTP ' + login.status))
  if (login.json.success === false) throw new Error(checkinBlocked(String(login.json.message ?? '上游拒绝'), provider))
  const data = login.json.data ?? {}
  const token = data.access_token ?? data.token
  if (!token) throw new Error('登录成功但未返回 access_token')
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
  if (data.id !== undefined && data.id !== null) headers['new-api-user'] = String(data.id)
  const res = await httpJson(root + '/api/user/checkin', { method: 'POST', headers, body: '{}' })
  if (res.json === null) throw new Error('签到请求失败：' + (res.error ?? 'HTTP ' + res.status))
  const ok = res.json.success !== false
  return { ok, message: String(res.json.message ?? (ok ? '签到成功' : '签到失败')), data: res.json.data ?? null }
}

/**
 * sharedchat's daily claim: log in, then POST the claim. The endpoint treats an already
 * valid subscription as success ("到期后可以再次领取"), so this is idempotent per day.
 */
async function checkinSharedchat(provider) {
  const creds = credentialsFor(provider)
  if (creds.length === 0) throw new Error('未在凭据文件中找到 ' + provider.name + ' 的账号')
  const cred = creds[0]
  const origin = 'https://new.sharedchat.cc'
  const login = await httpJson(origin + '/frontend-api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userToken: cred.username, password: cred.password, token: '' }),
  })
  if (login.json === null || login.json.code !== 1) {
    throw new Error('登录失败：' + String((login.json && login.json.msg) || login.error || ('HTTP ' + login.status)))
  }
  const cookie = login.headers !== undefined && typeof login.headers.getSetCookie === 'function'
    ? (login.headers.getSetCookie()[0] || '').split(';')[0]
    : ''
  if (cookie === '') throw new Error('登录成功但没有拿到会话 Cookie')
  const body = {
    eventId: '',
    reason: '每日自动领取' + localDate().replace(/-/g, '') + '用于编程学习和项目开发',
    fingerprintCollectFailed: true,
    fingerprintCollectError: 'headless',
    collectedAt: new Date().toISOString(),
  }
  const claim = await httpJson(origin + '/frontend-api/vibe-code/codex/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const data = (claim.json && claim.json.data) || null
  if (claim.json === null || claim.json.code !== 1) {
    throw new Error('领取失败：' + String((claim.json && claim.json.msg) || claim.error || ('HTTP ' + claim.status)))
  }
  return {
    ok: true,
    message: (data && data.claimed === true ? '领取成功' : (data && data.message) || '套餐已生效'),
    data,
  }
}

async function checkin(slug) {
  const provider = findProvider(slug)
  if (provider === undefined) throw new Error('未知平台：' + slug)
  if (provider.checkin === 'sharedchat') return checkinSharedchat(provider)
  return checkinRelay(provider)
}

// ── routes ─────────────────────────────────────────────────────────────────

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) { return {} }
}

/** Provider facts safe to send to the browser (no keys, no accounts). */
function publicProvider(p) {
  return {
    slug: p.slug,
    name: p.name,
    vendor: p.vendor,
    category: p.category,
    baseUrl: p.baseUrl,
    applyUrl: p.applyUrl,
    docsUrl: p.docsUrl,
    homepage: p.homepage,
    freeKind: p.freeKind,
    freeNote: p.freeNote,
    probe: p.probe,
    checkin: p.checkin === true || p.checkin === 'sharedchat',
    keyHint: p.keyHint || '',
    needsAccount: p.needsAccount === true,
    keyCount: entriesFor(p.slug).length,
    keys: entriesFor(p.slug).map((e) => ({
      id: e.id,
      label: e.label,
      masked: maskKey(e.key),
      baseUrl: e.baseUrl,
      addedAt: e.addedAt,
    })),
    hasCredential: credentialsFor(p).length > 0,
    account: (() => {
      const c = credentialsFor(p)
      return c.length > 0 ? c[0].username : ''
    })(),
  }
}

async function handleRoute(request, response) {
  let url
  try { url = new URL(request.url ?? '/', 'http://127.0.0.1') } catch (error) {
    sendJson(response, 400, { error: 'bad request' })
    return
  }
  const method = request.method ?? 'GET'
  const path = url.pathname
  try {
    if (method === 'GET' && path === '/dsh-free-pool/providers') {
      const providers = (loadProviders().providers || []).map(publicProvider)
      sendJson(response, 200, { total: providers.length, providers })
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/quota') {
      sendJson(response, 200, await buildQuota())
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/free-models') {
      sendJson(response, 200, await freeModels())
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/models') {
      const input = await readJson(request)
      sendJson(response, 200, await discoverModels({
        slug: String(input.slug ?? '').trim(),
        baseUrl: String(input.baseUrl ?? '').trim(),
        key: String(input.key ?? ''),
      }))
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/vault/add') {
      const input = await readJson(request)
      const entry = addEntry({
        slug: String(input.slug ?? '').trim(),
        label: String(input.label ?? ''),
        baseUrl: String(input.baseUrl ?? ''),
        key: String(input.key ?? ''),
      })
      sendJson(response, 200, { ok: true, id: entry.id, masked: maskKey(entry.key) })
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/vault/remove') {
      const input = await readJson(request)
      const removed = removeEntry(String(input.id ?? '').trim())
      sendJson(response, 200, { ok: true, slug: removed.slug })
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/vault/export') {
      const entries = loadVault().entries.map((e) => ({
        slug: e.slug,
        label: e.label,
        baseUrl: e.baseUrl,
        key: e.key,
        addedAt: e.addedAt,
      }))
      sendJson(response, 200, {
        schema: 'dsh-free-api-pool/vault-export/v1',
        exportedAt: new Date().toISOString(),
        count: entries.length,
        entries,
      })
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/speed-test') {
      const input = await readJson(request)
      sendJson(response, 200, await speedTest({
        slug: String(input.slug ?? '').trim(),
        entryId: String(input.entryId ?? '').trim(),
        model: String(input.model ?? '').trim(),
        prompt: String(input.prompt ?? ''),
      }))
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/checkin') {
      const input = await readJson(request)
      const slug = String(input.slug ?? '').trim()
      if (slug === '') { sendJson(response, 400, { error: '缺少 slug' }); return }
      sendJson(response, 200, await checkin(slug))
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/checkin-all') {
      const targets = (loadProviders().providers || []).filter((p) => (p.checkin === true || p.checkin === 'sharedchat'))
      const results = []
      for (const provider of targets) {
        try {
          const r = await checkin(provider.slug)
          results.push({ slug: provider.slug, name: provider.name, ok: r.ok, message: r.message })
        } catch (error) {
          results.push({ slug: provider.slug, name: provider.name, ok: false, message: String((error && error.message) || error) })
        }
      }
      sendJson(response, 200, { results })
      return
    }
    sendJson(response, 404, { error: 'not found' })
  } catch (error) {
    sendJson(response, 400, { error: String((error && error.message) || error) })
  }
}

export function apply(ctx, rowConfig = {}) {
  if (typeof rowConfig?.credentialsFile === 'string' && rowConfig.credentialsFile !== '') {
    config = { ...config, credentialsFile: rowConfig.credentialsFile }
  }
  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-free-pool',
      handler: handleRoute,
    })
    hostCtx.effect(() => dispose, 'dsh-free-api-pool: http routes')
  })
}
