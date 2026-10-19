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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-free-api-pool'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(PLUGIN_DIR, 'data')
const PROVIDERS_FILE = join(DATA_DIR, 'providers.json')
// A test harness sets DFP_VAULT_FILE so it can never write into the user's real vault.
const VAULT_FILE = process.env.DFP_VAULT_FILE !== undefined && process.env.DFP_VAULT_FILE !== ''
  ? process.env.DFP_VAULT_FILE
  : join(DATA_DIR, 'vault.json')
const TIMEOUT_MS = 15000
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

function entriesFor(providerRef) {
  const ref = typeof providerRef === 'string' ? providerRef : providerRef.slug
  const provider = findProvider(ref)
  if (provider !== undefined) {
    // An imported key may carry a slug the catalogue never uses ("custom", "groq2", …).
    // Its HOST still identifies the vendor. When several keys share a host, prefer the one
    // whose path matches the catalogue's (google: /v1beta/openai works, bare /v1 does not).
    const host = hostOf(String(provider.baseUrl || ''))
    const want = String(provider.baseUrl || '').replace(/\/+$/, '')
    const all = loadVault().entries.filter((e) => e.slug === provider.slug
      || (host !== '' && hostOf(String(e.baseUrl || '')) === host))
    if (all.length <= 1) return all
    const exact = all.filter((e) => String(e.baseUrl || '').replace(/\/+$/, '') === want)
    // A catalogue path that the user has no key for falls back to every candidate.
    return exact.length > 0 ? exact : all
  }
  // A custom card owns every entry whose base URL produced its key.
  return loadVault().entries.filter((e) => findProvider(e.slug) === undefined && providerKeyOf(e) === ref)
}

/** Every usable key for a card, so one provider row can report several accounts. */
function keysFor(providerRef) {
  return entriesFor(providerRef).filter((e) => typeof e.key === 'string' && e.key !== '')
}

/** First usable key for a catalog slug, from the vault only. */
function keyFor(slug) {
  const hit = keysFor(slug)[0]
  return hit === undefined ? '' : hit.key
}

function addEntry({ slug, label, baseUrl, key }) {
  const provider = findProvider(slug)
  const raw = String(key ?? '').trim()
  if (raw === '') throw new Error('Key 不能为空')
  // A custom entry carries its own base URL and label, so it does not need a catalog row.
  const customBase = String(baseUrl ?? '').trim()
  if (provider === undefined && customBase === '') {
    throw new Error('未知平台：' + slug + '（自定义平台必须填 Base URL）')
  }
  const vault = loadVault()
  const dup = vault.entries.find((e) => e.slug === slug && e.key === raw)
  if (dup !== undefined) throw new Error('这个 Key 已经添加过了')
  const entry = {
    id: randomUUID(),
    slug,
    label: String(label ?? '').trim() || (provider === undefined ? slug : provider.name),
    baseUrl: customBase || provider.baseUrl,
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

// ── FreeLLMAPI interop ─────────────────────────────────────────────────────
//
// The export format is the user's existing FreeLLMAPI vault:
//   { version: 1, exportedAt, source: "freellmapi",
//     keys: [{ platform, key, label, baseUrl? }] }
// `platform` is a catalog slug for known vendors, or "custom" for anything the user
// declared themselves — in which case baseUrl is required and label is their own name.

/** Map a FreeLLMAPI platform id onto a catalog slug, or 'custom' when we do not know it. */
function slugForPlatform(platform) {
  const id = String(platform ?? '').trim().toLowerCase()
  if (id === '') return 'custom'
  return findProvider(id) === undefined ? 'custom' : id
}

/**
 * Merge a FreeLLMAPI export into the vault.
 *
 * Only what is missing gets added. Two files that differ by one key must produce exactly
 * one new entry — and the comparison is by KEY, not by label or platform, because the same
 * key can legitimately appear under a renamed label, and a file can contain its own
 * duplicates. Re-importing the same file is therefore a no-op.
 */
function importFreeLLM(parsed) {
  const keys = Array.isArray(parsed?.keys) ? parsed.keys : Array.isArray(parsed) ? parsed : null
  if (keys === null) throw new Error('文件格式不对：缺少 keys 数组')
  const vault = loadVault()
  // Seed with everything already stored so a repeated import never duplicates.
  const known = new Set(vault.entries.map((e) => String(e.key || '').trim()).filter((k) => k !== ''))
  const added = []
  const duplicate = []
  const errors = []
  for (const raw of keys) {
    if (raw === null || typeof raw !== 'object') { errors.push('有一条不是对象，已跳过'); continue }
    const key = String(raw.key ?? '').trim()
    if (key === '') { errors.push('有一条缺少 key，已跳过'); continue }
    if (known.has(key)) { duplicate.push(key); continue }
    const platform = String(raw.platform ?? '').trim().toLowerCase()
    const slug = slugForPlatform(platform)
    const baseUrl = String(raw.baseUrl ?? '').trim()
    if (slug === 'custom' && baseUrl === '') {
      errors.push('自定义条目「' + (raw.label || platform || '未命名') + '」缺少 baseUrl，已跳过')
      continue
    }
    const provider = findProvider(slug)
    const label = String(raw.label ?? '').trim() || (provider === undefined ? platform : provider.name)
    const entry = {
      id: randomUUID(),
      slug,
      label,
      // A known vendor keeps its canonical base URL; a custom row keeps the user's.
      baseUrl: slug === 'custom' ? baseUrl : (provider.baseUrl || baseUrl),
      key,
      addedAt: new Date().toISOString(),
    }
    vault.entries.push(entry)
    known.add(key)
    added.push(entry)
  }
  if (added.length > 0) saveVault()
  return {
    ok: true,
    added: added.length,
    skipped: duplicate.length,
    errors: errors.slice(0, 20),
    total: vault.entries.length,
    message: added.length === 0
      ? '没有新增：这 ' + keys.length + ' 条都已经在库里了'
      : '新增 ' + added.length + ' 条，跳过已存在 ' + duplicate.length + ' 条',
  }
}



/** Emit the vault in FreeLLMAPI's shape, so either tool can read the other's file. */
function exportFreeLLM() {
  const entries = loadVault().entries
  const out = entries.map((e) => {
    const provider = findProvider(e.slug)
    const row = {
      platform: provider === undefined ? 'custom' : e.slug,
      key: e.key,
      label: e.label || '',
    }
    // A vendor row only needs baseUrl when it is not the catalog default, but FreeLLMAPI
    // writes it for every custom row, and the user asked for baseUrl in every export.
    row.baseUrl = e.baseUrl || (provider === undefined ? '' : provider.baseUrl)
    return row
  })
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'freellmapi',
    keys: out,
  }
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
    return {
      ok: response.ok,
      status: response.status,
      json,
      text,
      contentType: response.headers.get('content-type') || '',
      headers: response.headers,
    }
  } catch (error) {
    const message = error && error.name === 'AbortError' ? '请求超时' : String((error && error.message) || error)
    return { ok: false, status: 0, json: null, text: '', contentType: '', error: message }
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

/**
 * Auth headers for a vendor.
 *
 * Most OpenAI-compatible relays accept `Authorization: Bearer`. Google AI Studio does not:
 * its OpenAI-compatible surface authenticates with `x-goog-api-key`, and a Bearer token is
 * answered with 401 — which is why Google showed as "异常" regardless of a valid key.
 * Cloudflare's Workers AI takes a Bearer token but lives under /accounts/, handled by its
 * own probe.
 */
function authHeader(key, provider) {
  const slug = provider && provider.slug
  if (slug === 'google') return { 'x-goog-api-key': key }
  return { authorization: 'Bearer ' + key }
}

/**
 * Turn a failure into a message that names the actual cause.
 *
 * "异常" alone is useless: an auth problem, a Cloudflare challenge and an unreachable host
 * all looked identical. The panel can now say which one it is, which is the difference
 * between "fix your key" and "this site is unreachable from here".
 */
/**
 * Explain a failed call in terms the user can act on.
 *
 * Every message names WHICH of the four things went wrong, because "异常" tells nobody
 * whether to fix a key, wait, change network, or give up on the vendor:
 *   网络 — the host is unreachable from here
 *   密钥 — the vendor rejected the credential
 *   官方 — the vendor itself is broken or blocking non-browser clients
 *   限流 — the credential is fine but the allowance is spent
 */
function failureText(res, host) {
  if (res === undefined) return '网络不通：无法连接到 ' + host
  const ct = String(res.contentType || '')
  const body = String(res.text || '')
  const isHtml = /text\/html/i.test(ct) || /^\s*<(!doctype|html)/i.test(body)
  const vendorMsg = (() => {
    try {
      const parsed = JSON.parse(body)
      return String((parsed && parsed.error && parsed.error.message) || (parsed && parsed.message) || '').slice(0, 80)
    } catch (error) { return '' }
  })()
  if (res.status === 0) return '网络不通：' + host + ' 无响应（' + String(res.error || '连接失败').slice(0, 40) + '）'
  if (res.status === 401) return '密钥无效：' + host + ' 拒绝了该 Key（HTTP 401），请重新生成'
  if (res.status === 402) return '余额不足：' + host + ' 提示额度已用完（HTTP 402）'
  if (res.status === 403) {
    if (isHtml) return '官方拦截：' + host + ' 返回浏览器验证页（Cloudflare），非浏览器请求被拒'
    return '密钥被拒或地区受限：' + host + ' 返回 403' + (vendorMsg === '' ? '' : '（' + vendorMsg + '）')
  }
  if (res.status === 404) return '地址不对：' + host + ' 上找不到该接口（HTTP 404），Base URL 可能有误'
  if (res.status === 429) return '限流：' + host + ' 提示请求过多（HTTP 429），稍后再试'
  if (res.status >= 500) return '官方故障：' + host + ' 服务端出错（HTTP ' + res.status + '）' + (vendorMsg === '' ? '' : '（' + vendorMsg + '）')
  return '官方异常：' + host + ' 返回 HTTP ' + res.status + (vendorMsg === '' ? '' : '（' + vendorMsg + '）')
}

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

  const res = await httpJson(base + '/models', { headers: authHeader(token, provider) })
  if (res.status === 0) throw new Error('无法连接 ' + base + '：' + (res.error ?? '网络错误'))
  if (rejected(res)) throw new Error(failureText(res, hostOf(base)))
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
  if (chosen === '') {
    throw new Error('这条 Key 无法读取到可用模型，测速已跳过：请确认 Key 有效且该平台有聊天模型')
  }

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
        ...authHeader(entry.key, provider),
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
    recordUsage({
      at: Date.now(),
      kind: 'speed-test',
      provider: provider === undefined ? slug : provider.slug,
      providerName: provider === undefined ? (entry.label || slug) : provider.name,
      model: chosen,
      account: entry.label,
      channel: '测速',
      ok: false,
      status: statusCode,
      error: failure,
      totalMs: end - startedAt,
    })
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

  recordUsage({
    at: Date.now(),
    kind: 'speed-test',
    provider: provider === undefined ? slug : provider.slug,
    providerName: provider === undefined ? (entry.label || slug) : provider.name,
    model: chosen,
    account: entry.label,
    channel: '测速',
    ok: true,
    status: statusCode,
    totalMs: end - startedAt,
    ttftMs,
    tps,
    completionTokens: tokens,
    promptTokens: usageTokens !== null ? null : 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  })
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
  const res = await httpJson('https://opencode.ai/zen/v1/models', key === '' ? {} : { headers: authHeader(key, provider) })
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

function reject(res, host) {
  return blank('error', 'none', failureText(res, host || '该平台'))
}

function upstreamError(res, host) {
  // A platform's own message is the most specific fact available; fall back to the
  // classified reason (unreachable / Cloudflare challenge / auth) when it says nothing.
  const msg = (res.json && (res.json.message || (res.json.error && res.json.error.message))) || res.error
  if (msg !== undefined && msg !== null && String(msg).trim() !== '') {
    return blank('error', 'none', String(msg).slice(0, 160))
  }
  return blank('error', 'none', failureText(res, host || '该平台'))
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
  const models = await httpJson(base + '/models', { headers: authHeader(key, provider) })
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
      headers: { ...authHeader(key, provider), 'content-type': 'application/json' },
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
    const res = await httpJson(url, { headers: authHeader(key, provider) })
    if (rejected(res)) return reject(res, hostOf(provider.baseUrl))
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
  const lifetime = await httpJson(root + '/dashboard/billing/usage?start_date=1970-01-01&end_date=' + today, { headers: authHeader(key, provider) })
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
  const res = await httpJson('https://openrouter.ai/api/v1/key', { headers: authHeader(key, provider) })
  if (rejected(res)) return reject(res, hostOf(provider.baseUrl))
  if (!res.ok || res.json === null) return upstreamError(res, hostOf(provider.baseUrl))
  const d = res.json.data ?? {}
  const usage = num(d.usage)
  const credits = await httpJson('https://openrouter.ai/api/v1/credits', { headers: authHeader(key, provider) })
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
  const res = await httpJson(base + '/users/me/balance', { headers: authHeader(key, provider) })
  if (rejected(res)) return reject(res, hostOf(provider.baseUrl))
  if (!res.ok || res.json === null) return upstreamError(res, hostOf(provider.baseUrl))
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
  if (rejected(res)) return reject(res, hostOf(provider.baseUrl))
  if (!res.ok || res.json === null) return upstreamError(res, hostOf(provider.baseUrl))
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
  const res = await httpJson(base + '/models', { headers: authHeader(key, provider) })
  if (rejected(res)) return reject(res, hostOf(provider.baseUrl))
  if (!res.ok) return upstreamError(res, hostOf(provider.baseUrl))
  const list = extractModels(res.json, provider)
  return blank('console', 'console',
    '接口正常，可用模型 ' + list.length + ' 个；该平台未开放余额接口，请在控制台查看', {
      models: list.length,
    })
}

async function probeProvider(provider, key) {
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

function baseRow(provider) {
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

/**
 * Quota build, split so the panel never waits on the network.
 *
 * `quotaList()` renders every card from the vault alone: no HTTP at all, so 150+ keys paint
 * in milliseconds. Quota comes later through `quotaProbe()`, on demand or for the catalog.
 *
 * Probing everything on every open was the performance bug being fixed here. Measured on a
 * 162-key vault: 113 of 135 distinct relay base URLs never answer, and a full pass took
 * 101 seconds. Those are imported FreeLLMAPI relays the user may never ask about, so they
 * are probed only when the card is asked for, and a dead host is remembered for 10 minutes
 * so one timeout covers all its keys and all later opens.
 */
const PROBE_CACHE = new Map()
const PROBE_TTL_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 8000
const DEAD_HOSTS = new Map()
const DEAD_TTL_MS = 10 * 60_000

function cachedProbe(key) {
  const hit = PROBE_CACHE.get(key)
  if (hit === undefined) return null
  if (Date.now() - hit.at > PROBE_TTL_MS) {
    PROBE_CACHE.delete(key)
    return null
  }
  return hit
}

function storeProbe(key, quota) {
  PROBE_CACHE.set(key, { at: Date.now(), quota })
}

function deadHost(baseUrl) {
  const host = normalizeBase(baseUrl)
  const at = DEAD_HOSTS.get(host)
  if (at === undefined) return false
  if (Date.now() - at > DEAD_TTL_MS) {
    DEAD_HOSTS.delete(host)
    return false
  }
  return true
}

function markDead(baseUrl) {
  DEAD_HOSTS.set(normalizeBase(baseUrl), Date.now())
}

function accountView(entry, quota) {
  return {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    masked: maskKey(entry.key),
    quota,
  }
}

/** What a card shows before anyone asked about it: a cached answer, a dead mark, or nothing. */
function unknownQuota(entry) {
  const cached = cachedProbe(entry.key)
  if (cached !== null) return cached.quota
  if (deadHost(entry.baseUrl)) return blank('error', 'none', '该站点无响应（本次会话已标记，点「探测」可重试）')
  return blank('untested', 'none', '尚未探测；点卡片上的「探测」按需查询')
}

/**
 * Fold per-account quotas into the card's collapsed figure. The number is the SUM of what
 * the accounts actually measured, so a multi-key card reads as real headroom.
 */
function foldQuota(accounts, measured, failed) {
  const untested = accounts.filter((a) => a.quota && a.quota.state === 'untested')
  const sum = (f) => {
    let total = null
    for (const a of measured) {
      const v = a.quota ? a.quota[f] : null
      if (typeof v === 'number' && Number.isFinite(v)) total = (total ?? 0) + v
    }
    return total === null ? null : round(total, 4)
  }
  const windows = measured.flatMap((a) => (a.quota.windows || []).map((w) => ({ ...w, account: a.label })))
  const state = measured.length > 0 ? 'ok'
    : untested.length > 0 ? 'untested'
      : failed.length > 0 ? 'error' : 'console'
  const parts = []
  if (accounts.length > 1) parts.push(accounts.length + ' 个账号合计')
  if (measured.length > 0 && (failed.length > 0 || untested.length > 0)) {
    const bits = []
    if (failed.length > 0) bits.push(failed.length + ' 个异常')
    if (untested.length > 0) bits.push(untested.length + ' 个未探测')
    parts.push(measured.length + ' 个已测，' + bits.join(' / '))
  }
  if (measured.length > 0 && measured[0].quota.detail) parts.push(measured[0].quota.detail)
  if (measured.length === 0 && failed.length > 0) parts.push(failed[0].quota.detail)
  if (measured.length === 0 && failed.length === 0 && untested.length > 0) {
    parts.push('尚未探测；点卡片上的「探测」按需查询，避免一次等上百个站点')
  }
  return {
    state,
    nature: measured.length > 0 ? measured[0].quota.nature : 'none',
    currency: measured.length > 0 ? measured[0].quota.currency : null,
    todayCurrency: measured.length > 0 ? measured[0].quota.todayCurrency : null,
    totalRemaining: sum('totalRemaining'),
    todayRemaining: sum('todayRemaining'),
    used: sum('used'),
    todayUsed: sum('todayUsed'),
    models: measured.length > 0 ? measured[0].quota.models : null,
    detail: parts.join('；'),
    windows,
  }
}

function rowFrom(provider, entries, quotaOf) {
  const accounts = entries.map((entry) => accountView(entry, quotaOf(entry)))
  const measured = accounts.filter((a) => a.quota && a.quota.state === 'ok')
  const failed = accounts.filter((a) => a.quota && a.quota.state === 'error')
  return {
    ...baseRow(provider),
    keyCount: entries.length,
    keyLabels: entries.map((e) => e.label),
    accounts,
    quota: foldQuota(accounts, measured, failed),
    hasCredential: provider.category === 'custom' ? false : credentialsFor(provider).length > 0,
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('探测超时（' + Math.round(ms / 1000) + ' 秒）')), ms)),
  ])
}

/** Probe one account and remember the answer, plus whether its host looks dead. */
async function probeAccount(provider, entry) {
  if (deadHost(entry.baseUrl)) {
    return { quota: blank('error', 'none', '该站点无响应（本次已标记，点「探测」重试）'), dead: true }
  }
  try {
    const quota = await withTimeout(probeProvider(provider, entry.key), PROBE_TIMEOUT_MS)
    if (quota.state === 'error') markDead(entry.baseUrl)
    storeProbe(entry.key, quota)
    return { quota, dead: quota.state === 'error' }
  } catch (error) {
    markDead(entry.baseUrl)
    return { quota: blank('error', 'none', String((error && error.message) || error).slice(0, 120)), dead: true }
  }
}

/** The list every panel open uses: vault-only, zero network, instant. */
function quotaList() {
  const catalog = loadProviders().providers || []
  const providers = [...catalog, ...customProviders()]
  return {
    at: Date.now(),
    probed: false,
    providers: providers.map((provider) => rowFrom(provider, keysFor(provider), unknownQuota)),
  }
}

/**
 * Probe a chosen set of cards.
 *  - `slugs: [...]` probes exactly those (the panel sends what it is about to show),
 *  - no `slugs` probes the catalog vendors only.
 * Imported relays are excluded from the default pass because most are dead, and one bad
 * host must not delay the rest: a dead mark makes its later keys return instantly.
 */
async function quotaProbe({ slugs, onlyWithKeys } = {}) {
  const catalog = loadProviders().providers || []
  const all = [...catalog, ...customProviders()]
  const want = Array.isArray(slugs) && slugs.length > 0 ? new Set(slugs) : null
  const targets = all.filter((p) => {
    if (want !== null) return want.has(p.slug)
    if (p.category === 'custom') return false
    if (onlyWithKeys !== false && keysFor(p).length === 0) return false
    return true
  })
  const rows = []
  await mapLimit(targets, 24, async (provider) => {
    const entries = keysFor(provider)
    if (entries.length === 0) {
      // A keyless card still has something true to say. A static (console-only) vendor is
      // console-only BY DESIGN, so claiming "no key yet" would be wrong for it; every other
      // keyless vendor really does just need a key.
      const keyless = (provider.probe || 'models') === 'static'
        ? blank('console', 'console', provider.checkin === 'sharedchat'
          ? '该站每日签到送 $50 Codex 额度，额度需在站内控制台查看'
          : (provider.freeNote || '免费额度') + '，该平台未开放余额接口，需在控制台查看')
        : blank('nokey', 'none', '尚未添加 Key，添加后点「探测」即可查询')
      rows.push({
        ...baseRow(provider),
        keyCount: 0,
        keyLabels: [],
        accounts: [],
        quota: keyless,
        hasCredential: provider.category === 'custom' ? false : credentialsFor(provider).length > 0,
      })
      return
    }
    const accounts = []
    for (const entry of entries) {
      const { quota } = await probeAccount(provider, entry)
      accounts.push(accountView(entry, quota))
    }
    const measured = accounts.filter((a) => a.quota && a.quota.state === 'ok')
    const failed = accounts.filter((a) => a.quota && a.quota.state === 'error')
    rows.push({
      ...baseRow(provider),
      keyCount: entries.length,
      keyLabels: entries.map((e) => e.label),
      accounts,
      quota: foldQuota(accounts, measured, failed),
      hasCredential: provider.category === 'custom' ? false : credentialsFor(provider).length > 0,
    })
  })
  return { at: Date.now(), probed: true, providers: rows }
}

/**
 * Rewrite the dfp-auto provider's baseURL to the port this process listens on.
 *
 * The Web GUI port changes between launches. A baseURL pinned to an old port makes DSH
 * treat the provider as unreachable, and the user sees "Select an available model" when
 * picking any Auto profile. Editing the profile at startup keeps them working.
 *
 * Only the dfp-auto row is touched, and only its baseURL line: the file is user-owned and
 * may contain comments and unrelated providers.
 */
const PROFILE_FILE = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

/**
 * Render a value as a YAML 1.1 block scalar. Values that are not unambiguously plain
 * strings (leading "[{", "#&*!|>?%@'\"", ":" / "#" inside, bool/null/number-like, …)
 * are emitted as double-quoted strings with backslash and quote escaped.
 * Fixes profile corruption when model ids look like "[AC混合]gemini-4-argon".
 */

// ── 配置文件安全写入 ────────────────────────────────────────────────────────
//
// The profile is a ~12,000-line file the user owns and DSH needs in order to boot. A single
// malformed character in it stops the whole application, so every write here follows the
// same four rules:
//
//   1. VALIDATE BEFORE WRITING. A structural check of the produced text; if it does not
//      pass, nothing is written and the caller is told why.
//   2. ATOMIC REPLACE. Write a temp file in the same directory, then rename over the target.
//      A crash mid-write can then never leave a half-written profile.
//   3. KEEP A ROLLING BACKUP. The last good copy stays on disk as <file>.dfp-backup, so a
//      user can always restore by hand.
//   4. NEVER THROW. This runs during plugin load; an exception would take DSH down with it.

const PROFILE_BACKUP = PROFILE_FILE + '.dfp-backup'
const PROFILE_TEMP = PROFILE_FILE + '.dfp-tmp'

/**
 * Structural check for the profile text before it is allowed to replace the real file.
 *
 * This is deliberately conservative and does not try to be a YAML parser: it verifies the
 * things this plugin could actually break — the file still has a providers block, every
 * provider key still sits at the expected indent, and no line ends with a dangling quote.
 * Anything suspicious refuses the write rather than risking the user's boot.
 */
function profileLooksSane(text) {
  if (typeof text !== 'string' || text.length < 100) return '内容过短'
  const lines = text.split(/\r?\n/)
  let head = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*providers:\s*$/.test(lines[i])) { head = i; break }
  }
  if (head < 0) return '找不到 providers 块'
  const baseIndent = lines[head].length - lines[head].trimStart().length
  let providerKeys = 0
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent <= baseIndent) break
    if (indent === baseIndent + 2 && line.trim().endsWith(':')) providerKeys += 1
  }
  if (providerKeys === 0) return 'providers 块为空'
  // An odd number of unescaped double quotes on a line means a broken scalar.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const quotes = (line.match(/(?<!\\)"/g) || []).length
    if (quotes % 2 !== 0) return '第 ' + (i + 1) + ' 行引号不配对'
  }
  return null
}

/**
 * Replace the profile atomically, but only when the new text passes the structural check.
 * Returns { ok, reason } so callers can report honestly instead of silently failing.
 */
function writeProfileSafely(text) {
  const problem = profileLooksSane(text)
  if (problem !== null) return { ok: false, reason: problem }
  try {
    // Keep the previous good copy before touching anything.
    try {
      if (existsSync(PROFILE_FILE)) {
        const current = readFileSync(PROFILE_FILE, 'utf8')
        if (profileLooksSane(current) === null) writeFileSync(PROFILE_BACKUP, current, 'utf8')
      }
    } catch (error) { /* a missing backup must not block the write */ }

    writeFileSync(PROFILE_TEMP, text, 'utf8')
    renameSync(PROFILE_TEMP, PROFILE_FILE)
    hostCatalogCache = null
    return { ok: true, reason: '' }
  } catch (error) {
    try { if (existsSync(PROFILE_TEMP)) unlinkSync(PROFILE_TEMP) } catch (e2) { /* ignore */ }
    return { ok: false, reason: String((error && error.message) || error).slice(0, 80) }
  }
}

function yamlScalar(value) {
  const s = String(value)
  if (s === '') return '""'
  if (
    /^[A-Za-z0-9_一-鿿][A-Za-z0-9_一-鿿.\-/:()（）]*$/.test(s)
    && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)
    && !/^[+-]?[0-9]/.test(s)
    && !/^[0-9.]+$/.test(s)
  ) {
    return s
  }
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}


// ── 宿主已注册的 provider / model ───────────────────────────────────────────
//
// DSH only accepts a selection whose provider AND model both exist in its own catalogue
// (requireModel -> modelAvailable). That catalogue lives in the user's profile, so the pool
// reads it here instead of guessing: sending "groq" when the profile registered "groq-free"
// is exactly what made switching fail with "Select an available model".

let hostCatalogCache = null
// Last reason a profile write was refused; surfaced to the panel so a refusal is visible.
let lastProfileError = ''
// Host context of the running instance; kept so a reload can re-apply against it.
let liveHostContext = null
// How many times this process has hot-reloaded; reported by /reload and the panel.
let reloadCount = 0
let hostCatalogAt = 0
const HOST_CATALOG_TTL_MS = 30_000

/** Parse the profile's provider block into { provider: [modelIds] }. */
function readHostCatalog() {
  if (hostCatalogCache !== null && Date.now() - hostCatalogAt < HOST_CATALOG_TTL_MS) {
    return hostCatalogCache
  }
  const out = {}
  try {
    if (existsSync(PROFILE_FILE)) {
      const rows = readFileSync(PROFILE_FILE, 'utf8').split(/\r?\n/)
      let inProviders = false
      let current = null
      let baseIndent = 0
      for (const line of rows) {
        const header = /^(\s*)providers:\s*$/.exec(line)
        if (header !== null) {
          inProviders = true
          baseIndent = header[1].length
          continue
        }
        if (!inProviders) continue
        const trimmed = line.trim()
        if (trimmed === '') continue
        const indent = line.length - line.trimStart().length
        // Model rows are "- id: ..." too, so a dash alone cannot mean "block over".
        // Only a list entry at or above the providers indent starts the next block.
        if (indent <= baseIndent && /^-\s/.test(trimmed)) break
        if (indent === baseIndent + 2 && trimmed.endsWith(':')) {
          const name = trimmed.slice(0, -1).trim()
          if (/^[A-Za-z0-9_-]+$/.test(name)) {
            current = name
            if (out[current] === undefined) out[current] = []
            continue
          }
        }
        const model = /^-\s*id:\s*(.+?)\s*$/.exec(trimmed)
        if (model !== null && current !== null) {
          let mid = model[1].trim()
          if (mid.length >= 2 && ((mid[0] === '"' && mid[mid.length - 1] === '"')
            || (mid[0] === "'" && mid[mid.length - 1] === "'"))) {
            mid = mid.slice(1, -1)
          }
          out[current].push(mid)
        }
      }
    }
  } catch (error) {
    // A missing or unreadable profile means no restriction is applied.
  }
  hostCatalogCache = out
  hostCatalogAt = Date.now()
  return out
}

/**
 * The provider name DSH actually registered for a catalogue slug.
 * Profiles use a "-free" suffix (groq-free, openrouter-free, ...); older entries use the
 * bare slug. Returns '' when nothing matches, so the caller can report a precise reason.
 */
function hostProviderFor(slug) {
  const catalog = readHostCatalog()
  const names = Object.keys(catalog)
  if (names.length === 0) return slug
  // Prefer the provider THIS PLUGIN maintains: it is the one whose model list is refreshed
  // from the vendor on every registration. A user's own "<slug>-free" entry is left
  // untouched by the plugin, so its list is whatever it was when they created it — often a
  // couple of models — and picking anything else is refused by the host.
  const owned = providerIdFor(slug)
  if (catalog[owned] !== undefined) return owned
  // Then a bare slug (older profiles), then the "-free" convention.
  for (const name of [slug, slug + '-free']) {
    if (catalog[name] !== undefined) return name
  }
  const related = names.find((n) => n.endsWith('-' + slug) || n.startsWith(slug + '-'))
  return related === undefined ? '' : related
}

/** The model ids DSH accepts for a registered provider, or null when unknown. */
function hostModelsFor(providerName) {
  const catalog = readHostCatalog()
  const list = catalog[providerName]
  return list === undefined || list.length === 0 ? null : list
}



// ── 配置自检与片段生成（只读）───────────────────────────────────────────────
//
// Plan C contract: this plugin NEVER writes cordis.patch.yml. It reads the profile, tells the
// user exactly what is missing or wrong, and generates the exact text they can paste. Every
// historical crash came from writing that file; not writing it removes the failure mode.

/** Result of comparing dfp-auto's baseURL with the live gateway, filled at startup. */
let gatewayProfileCheck = null

/**
 * Compare the profile's dfp-auto baseURL with the gateway URL.
 * Read-only. Returns { ok, current, expected } for the panel to display.
 */
function checkGatewayProfile(expectedUrl, state) {
  try {
    if (!existsSync(PROFILE_FILE)) return { ok: false, current: null, expected: expectedUrl, reason: '找不到配置文件' }
    const text = readFileSync(PROFILE_FILE, 'utf8')
    const m = /dfp-auto:[\s\S]{0,400}?baseURL:\s*(\S+)/.exec(text)
    const current = m === null ? null : m[1]
    return {
      ok: current === expectedUrl,
      current,
      expected: expectedUrl,
      state: state === undefined ? gatewayState : state,
      reason: current === null ? '配置里没有 dfp-auto 的 baseURL' : (current === expectedUrl ? '' : '与网关地址不一致'),
    }
  } catch (error) {
    return { ok: false, current: null, expected: expectedUrl, reason: String((error && error.message) || error).slice(0, 60) }
  }
}

/**
 * Build the profile snippet that registers one vendor, without touching the file.
 * The user pastes it (or asks the plugin to apply it explicitly from the panel).
 */
function providerSnippet(slug) {
  const provider = findProvider(slug) || customProviders().find((p) => p.slug === slug)
  if (provider === undefined) return { ok: false, reason: '不在平台目录中' }
  const entries = keysFor(provider)
  if (entries.length === 0) return { ok: false, reason: '没有可用的 Key' }
  const entry = entries[0]
  const baseUrl = trimBase(entry.baseUrl || provider.baseUrl)
  if (baseUrl === '') return { ok: false, reason: '缺少 Base URL' }
  const providerId = providerIdFor(slug)
  const host = readHostCatalog()[providerId]
  const existing = host === undefined ? null : hostModelsFor(providerId)
  const lines = []
  lines.push(providerId + ':')
  lines.push('  displayName: ' + yamlScalar(provider.name + '（免费池）'))
  lines.push('  apiKeyEnv: DFP_POOL_KEY')
  lines.push('  api: openai-completions')
  lines.push('  baseURL: ' + yamlScalar(baseUrl))
  lines.push('  models:')
  for (const id of existing === null ? [] : existing) {
    lines.push('    - id: ' + yamlScalar(id))
    lines.push('      name: ' + yamlScalar(id))
  }
  return {
    ok: true,
    providerId,
    snippet: lines.join('\n'),
    alreadyRegistered: host !== undefined,
    modelCount: existing === null ? 0 : existing.length,
    note: host === undefined ? '尚未注册，请把片段加到 providers 下' : '已注册，可覆盖更新',
  }
}

/**
 * Everything the panel needs to explain the current state in one read-only pass.
 * This is the "自检" the user asked for: it answers "why can't I use this platform".
 */
function selfCheck() {
  const catalog = loadProviders().providers || []
  const relays = customProviders()
  const hostCatalog = readHostCatalog()
  const rows = []
  for (const provider of [...catalog, ...relays]) {
    const keys = keysFor(provider)
    if (keys.length === 0) continue
    const providerId = providerIdFor(provider.slug)
    const registered = hostCatalog[providerId] !== undefined
    const models = registered ? hostModelsFor(providerId) : null
    rows.push({
      slug: provider.slug,
      name: provider.name,
      keys: keys.length,
      providerId,
      registered,
      models: models === null ? 0 : models.length,
      // The one sentence the user actually needs.
      verdict: registered
        ? (models === null || models.length === 0 ? '已注册但没有模型' : '可切换')
        : '未注册，无法切换',
    })
  }
  const usable = rows.filter((r) => r.registered && r.models > 0).length
  return {
    ok: true,
    gateway: gatewayProfileCheck,
    platforms: rows.length,
    usable,
    unusable: rows.length - usable,
    rows,
  }
}

// ── 自动注册 provider ───────────────────────────────────────────────────────
//
// Adding a key (by hand or via a FreeLLMAPI import) is a promise that the pool can use it.
// DSH only accepts a model whose provider AND model id are registered in the profile, so the
// plugin writes that registration itself: one provider per vendor, holding the models the
// vendor actually serves. Without this the pool would list choices DSH silently rejects.

/** Provider ids DSH already owns; never overwrite these. */
const RESERVED_PROVIDERS = new Set(['niao', 'sharedchat-codex', 'agentrouter', 'xiaomi', 'browser'])

/**
 * Slug -> provider id used in the profile. Must be stable across restarts: it is the key DSH
 * stores the selection under, and renaming it would orphan every saved choice.
 */
function providerIdFor(slug) {
  const raw = String(slug)
  // A custom relay's slug is "custom:<baseUrl>", which sanitises into a very long id. Use the
  // host instead: stable for that relay, short enough to read, and unique enough in practice.
  if (raw.startsWith('custom:')) {
    const host = hostOf(raw.slice('custom:'.length)) || 'relay'
    return 'dfp-r-' + host.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  }
  return 'dfp-' + raw.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
}

/** Where the profile's providers block starts, or -1. */
function providersBlockStart(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*providers:\s*$/.test(lines[i])) return i
  }
  return -1
}

/** The [start, end) line range of one provider block, or null. */
function findProviderBlock(lines, providerId) {
  const head = providersBlockStart(lines)
  if (head < 0) return null
  const baseIndent = lines[head].length - lines[head].trimStart().length
  const keyIndent = baseIndent + 2
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent <= baseIndent) break
    if (indent === keyIndent && line.trim() === providerId + ':') {
      let end = i + 1
      for (; end < lines.length; end += 1) {
        const next = lines[end]
        if (next.trim() === '') continue
        const nextIndent = next.length - next.trimStart().length
        if (nextIndent <= baseIndent) break
        if (nextIndent === keyIndent) break
      }
      return { start: i, end, keyIndent }
    }
  }
  return null
}

/**
 * Register (or refresh) one provider in the profile.
 *
 * Rewrites only that provider's block, preserving everything else byte for byte — the file is
 * user-owned and may carry comments and providers this plugin knows nothing about.
 * Returns true when the file changed.
 */
function upsertProviderInProfile(providerId, spec) {
  try {
    if (!existsSync(PROFILE_FILE)) return false
    if (RESERVED_PROVIDERS.has(providerId)) return false
    // The pool provider is owned by this plugin and must stay rewritable.
    if (providerId !== AUTO_PROVIDER && RESERVED_PROVIDERS.has(providerId)) return false
    if (spec.models.length === 0) return false

    const text = readFileSync(PROFILE_FILE, 'utf8')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)
    const head = providersBlockStart(lines)
    if (head < 0) return false
    const baseIndent = lines[head].length - lines[head].trimStart().length
    const keyIndent = baseIndent + 2
    const pad = ' '.repeat(keyIndent)
    const inner = ' '.repeat(keyIndent + 2)
    const modelPad = ' '.repeat(keyIndent + 4)

    const body = []
    body.push(pad + providerId + ':')
    body.push(inner + 'displayName: ' + yamlScalar(spec.displayName))
    body.push(inner + 'apiKeyEnv: ' + spec.apiKeyEnv)
    body.push(inner + 'api: openai-completions')
    body.push(inner + 'baseURL: ' + yamlScalar(spec.baseUrl))
    body.push(inner + 'models:')
    for (const id of spec.models) {
      body.push(modelPad + '- id: ' + yamlScalar(id))
      body.push(modelPad + '  name: ' + yamlScalar(id))
    }

    const found = findProviderBlock(lines, providerId)
    let next
    if (found === null) {
      // Append after the LAST line that belongs to the providers block.
      //
      // The block ends at the next line that is a sibling of `providers:` — which in this
      // profile is a top-level "- id:" list entry. Anchoring on "indent <= baseIndent" walks
      // past that entry (its indent is 0, equal to baseIndent+? depending on nesting) and
      // lands the new provider OUTSIDE the mapping, which breaks the file. So walk forward
      // only while lines remain inside the block, and stop at the first sibling.
      let insertAt = head + 1
      for (let i = head + 1; i < lines.length; i += 1) {
        const line = lines[i]
        if (line.trim() === '') continue
        const indent = line.length - line.trimStart().length
        // A top-level "- id:" or any line at/above the providers indent closes the block.
        if (indent <= baseIndent) break
        insertAt = i + 1
      }
      next = [...lines.slice(0, insertAt), ...body, ...lines.slice(insertAt)]
    } else {
      next = [...lines.slice(0, found.start), ...body, ...lines.slice(found.end)]
    }
    const out = next.join(eol)
    if (out === text) return false
    const written = writeProfileSafely(out)
    if (!written.ok) {
      // Refuse rather than risk the user's boot. The caller surfaces the reason.
      lastProfileError = written.reason
      return false
    }
    lastProfileError = ''
    return true
  } catch (error) {
    lastProfileError = String((error && error.message) || error).slice(0, 80)
    return false
  }
}

/** Remove a provider block this plugin created (used when its last key goes away). */
function removeProviderFromProfile(providerId) {
  try {
    if (!existsSync(PROFILE_FILE)) return false
    if (!providerId.startsWith('dfp-') || providerId === 'dfp-auto') return false
    const text = readFileSync(PROFILE_FILE, 'utf8')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)
    const found = findProviderBlock(lines, providerId)
    if (found === null) return false
    const out = [...lines.slice(0, found.start), ...lines.slice(found.end)].join(eol)
    return writeProfileSafely(out).ok
  } catch (error) {
    return false
  }
}

/**
 * Point the dfp-auto provider at the gateway URL.
 *
 * The URL is a constant now, so this only has to repair an older profile that still pins a
 * per-instance harness port. Only the dfp-auto baseURL line is touched.
 */
function writeGatewayPort(url) {
  try {
    if (!existsSync(PROFILE_FILE)) return false
    const text = readFileSync(PROFILE_FILE, 'utf8')
    if (text.includes('baseURL: ' + url)) return true
    const block = /(dfp-auto:[\s\S]{0,400}?baseURL:\s*)(http:\/\/127\.0\.0\.1:\d+\/dsh-free-pool\/v1)/
    if (!block.test(text)) return false
    const next = text.replace(block, (all, head) => head + url)
    if (next === text) return true
    return writeProfileSafely(next).ok
  } catch (error) {
    return false
  }
}


/**
 * Register a vendor with DSH so its models become selectable.
 *
 * Pulls the vendor's real model list, keeps only what may be used for free, and writes the
 * provider into the profile. Returns what happened so the caller can report it honestly:
 * a vendor that cannot be registered must not appear selectable in the pool.
 */
/**
 * Probe one platform and report what it would take to use it. READ-ONLY.
 *
 * The plugin used to fetch the model list and write a provider entry. That write is gone, so
 * this only answers: does the vendor answer, how many models does it offer, and is it already
 * registered. The panel turns that into either "可以切换" or a specific reason.
 */

/**
 * Register one vendor: pull its model list, filter to free models, write the provider entry.
 *
 * This is the feature the user imported 162 keys for — it must exist. The safety work below
 * it is what makes it acceptable: the write is validated first, replaced atomically, and
 * backed up, so a bad vendor can never leave a broken profile behind.
 */

/**
 * Rewrite dfp-auto's model list to the full pool catalogue.
 *
 * This is what puts every free model into DSH's own selector: the provider is one entry with
 * one display name (白嫖池), and its model list is the whole pool. Model ids are exposed as
 * "vendor/model", which the gateway resolves exactly.
 *
 * Returns { ok, models, reason }. The write is validated/atomic/backed up like every other.
 */
function syncPoolProvider() {
  const rows = poolCatalog().filter((row) => row.models.length > 0)
  const ids = AUTO_MODELS.map((m) => m.id)
  for (const row of rows) {
    for (const id of row.models) {
      const exposed = row.slug + '/' + id
      if (ids.indexOf(exposed) < 0) ids.push(exposed)
    }
  }
  if (ids.length <= AUTO_MODELS.length) {
    return { ok: false, models: ids.length, reason: '还没有已注册的厂商模型' }
  }
  const changed = upsertProviderInProfile(AUTO_PROVIDER, {
    displayName: POOL_DISPLAY_NAME,
    apiKeyEnv: 'DFP_POOL_KEY',
    baseUrl: gatewayBaseUrl(),
    models: ids,
  })
  if (!changed && lastProfileError !== '') {
    return { ok: false, models: ids.length, reason: lastProfileError }
  }
  return { ok: true, models: ids.length, reason: '' }
}

async function registerProviderFor(slug) {
  const provider = findProvider(slug) || customProviders().find((p) => p.slug === slug)
  if (provider === undefined) return { ok: false, reason: '不在平台目录中' }
  const entries = keysFor(provider)
  if (entries.length === 0) return { ok: false, reason: '没有可用的 Key' }

  // A vendor can hold several keys and the first may be revoked. Try each until one answers:
  // giving up on the vendor because of a dead key is what made working platforms look broken.
  let models = []
  let baseUrl = ''
  let lastReason = '没有可用的 Key'
  for (const entry of entries) {
    const candidate = trimBase(entry.baseUrl || provider.baseUrl)
    if (candidate === '') { lastReason = '缺少 Base URL'; continue }
    // Cloudflare-style URLs carry an account id the user must fill in themselves.
    if (/\{[^}]+\}/.test(candidate)) {
      lastReason = '地址里还有占位符，需要填入你自己的账号 ID：' + candidate
      continue
    }
    try {
      const res = await withTimeout(
        httpJson(candidate + '/models', { headers: authHeader(entry.key, provider) }),
        PROBE_TIMEOUT_MS,
      )
      if (!res.ok) { lastReason = failureText(res, hostOf(candidate)); continue }
      const ids = extractModels(res.json, provider)
      const items = Array.isArray(res.json.data) ? res.json.data
        : Array.isArray(res.json.models) ? res.json.models
          : Array.isArray(res.json) ? res.json : []
      const kept = freeModelsFor(provider, items, ids).filter((id) => !NOT_CHAT.test(id))
      if (kept.length === 0) { lastReason = '这个平台没有返回可用的免费模型'; continue }
      models = kept
      baseUrl = candidate
      break
    } catch (error) {
      lastReason = '网络不通：' + String((error && error.message) || error).slice(0, 60)
    }
  }
  if (models.length === 0) return { ok: false, reason: lastReason }
  if (models.length === 0) return { ok: false, reason: '这个平台没有返回可用的免费模型' }

  const providerId = providerIdFor(slug)
  const changed = upsertProviderInProfile(providerId, {
    // Every pool provider shares one display name so DSH groups them under 白嫖池 instead of
    // scattering 100+ vendor headings through the menu.
    displayName: POOL_DISPLAY_NAME,
    apiKeyEnv: 'DFP_POOL_KEY',
    baseUrl,
    models,
  })
  if (!changed && lastProfileError !== '') {
    return { ok: false, reason: '写入被拒绝：' + lastProfileError }
  }
  return { ok: true, providerId, models: models.length, displayName: provider.name }
}

/** Register every platform that holds a key. Runs concurrently so 140 vendors finish quickly. */

/**
 * Drop stale "dfp-r-<host>" provider entries whose host now belongs to a catalogue vendor.
 *
 * Before host-based vendor mapping, every imported key became its own relay provider. Those
 * entries skip free-model filtering and keep models that no longer exist. Returns how many
 * were removed.
 */
function pruneStaleRelayProviders() {
  const catalogue = loadProviders().providers || []
  const hosts = new Map()
  for (const provider of catalogue) {
    const host = hostOf(String(provider.baseUrl || ''))
    if (host !== '') hosts.set(host, provider.slug)
  }
  if (hosts.size === 0) return 0
  // providerIdFor() builds a relay id as "dfp-r-" + host with non-alphanumerics dashed.
  const relayIdFor = (host) => 'dfp-r-' + host.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const stale = new Set()
  for (const host of hosts.keys()) stale.add(relayIdFor(host))
  let removed = 0
  for (const providerId of Object.keys(readHostCatalog())) {
    if (!stale.has(providerId)) continue
    if (removeProviderFromProfile(providerId)) removed += 1
  }
  return removed
}

async function registerAllProviders() {
  // Build the work list from the VAULT, not just the catalogue: an imported key may carry a
  // slug the catalogue never uses, and its vendor must still be registered (and filtered).
  const targets = new Map()
  for (const provider of (loadProviders().providers || [])) targets.set(provider.slug, provider)
  for (const entry of loadVault().entries) {
    const provider = catalogueProviderForEntry(entry)
    if (provider !== undefined) targets.set(provider.slug, provider)
  }
  const all = [...targets.values(), ...customProviders()]
  const results = []
  await mapLimit(all, 4, async (provider) => {
    if (keysFor(provider).length === 0) return
    const r = await registerProviderFor(provider.slug)
    results.push({ slug: provider.slug, name: provider.name, ...r })
  })
  // Every vendor now has its own entry, so refresh the single pool provider that DSH shows.
  hostCatalogCache = null
  pruneStaleRelayProviders()
  hostCatalogCache = null
  syncPoolProvider()
  return results
}

async function inspectPlatform(slug) {
  const provider = findProvider(slug) || customProviders().find((p) => p.slug === slug)
  if (provider === undefined) return { ok: false, reason: '不在平台目录中' }
  const entries = keysFor(provider)
  if (entries.length === 0) return { ok: false, reason: '没有可用的 Key' }
  const entry = entries[0]
  const baseUrl = trimBase(entry.baseUrl || provider.baseUrl)
  if (baseUrl === '') return { ok: false, reason: '缺少 Base URL' }

  const providerId = providerIdFor(slug)
  const registered = readHostCatalog()[providerId] !== undefined
  const known = registered ? hostModelsFor(providerId) : null

  let models = []
  try {
    const res = await withTimeout(
      httpJson(baseUrl + '/models', { headers: authHeader(entry.key, provider) }),
      PROBE_TIMEOUT_MS,
    )
    if (!res.ok) {
      return { ok: false, reason: failureText(res, hostOf(baseUrl)), registered, providerId, models: 0 }
    }
    const ids = extractModels(res.json, provider)
    const items = Array.isArray(res.json.data) ? res.json.data
      : Array.isArray(res.json.models) ? res.json.models
        : Array.isArray(res.json) ? res.json : []
    models = freeModelsFor(provider, items, ids).filter((id) => !NOT_CHAT.test(id))
  } catch (error) {
    return { ok: false, reason: '网络不通：' + String((error && error.message) || error).slice(0, 60), registered, providerId, models: 0 }
  }

  if (models.length === 0) {
    return { ok: false, reason: '这个平台没有返回可用的免费模型', registered, providerId, models: 0 }
  }
  return {
    ok: true,
    registered,
    providerId,
    models: models.length,
    // Registered but the profile lists fewer models than the vendor serves: the user has to
    // update the snippet before those extra models become selectable.
    needsUpdate: registered && (known === null || known.length < models.length),
  }
}

/**
 * Every model the pool can reach, grouped by vendor.
 *
 * This is what the model picker shows. Vendors that answered are listed in the caller's
 * order; imported relays come last and only include those that actually answered, so a
 * vault with a hundred dead relays does not produce a hundred empty groups.
 *
 * Results are cached briefly: the picker is opened far more often than models change.
 */
const POOL_CACHE = new Map()
const POOL_TTL_MS = 10 * 60_000

/**
 * Model catalog for the pool picker.
 *
 * Answers in two phases, because the picker must open instantly:
 *  - phase "cached": every group already known from a previous run, no network at all;
 *  - phase "full":   the groups that still need a probe, each delivered as it lands.
 *
 * The HTTP route streams phase 1 as one JSON line and then one line per group, so the
 * picker renders known vendors immediately and fills in the rest as they answer. A vault
 * with a hundred relays can take half a minute in total, and none of that is spent before
 * the first pixel.
 */
function poolTargets(want) {
  const catalog = loadProviders().providers || []
  const all = [...catalog, ...customProviders()]
  const set = Array.isArray(want) && want.length > 0 ? new Set(want) : null
  return all.filter((p) => (set === null || set.has(p.slug)) && keysFor(p).length > 0)
}

function poolGroupBase(provider, entry) {
  const hostProvider = hostProviderFor(provider.slug)
  return {
    slug: provider.slug,
    // What DSH registered (e.g. "groq-free"); empty when the profile has no such provider,
    // in which case the model cannot be switched to and the client says why.
    hostProvider,
    hostModels: hostProvider === '' ? null : hostModelsFor(hostProvider),
    name: provider.name,
    vendor: provider.vendor,
    category: provider.category,
    baseUrl: trimBase(provider.baseUrl),
    freeKind: provider.freeKind,
    keyLabel: entry.label,
    models: [],
    error: null,
  }
}

/** One vendor's models, from cache when fresh. */
// ── 免费模型过滤 ────────────────────────────────────────────────────────────
//
// "Free" means two different things, and conflating them broke both cases:
//
//   A. free MODELS — the vendor prices this model at zero (OpenRouter's :free set).
//      A paid model here is a broken promise, so the rule is default-DENY: show a model
//      only when the vendor itself proves it is free.
//
//   B. free TIER — the vendor bills per token but gives every account a free allowance
//      (Groq, Cerebras, Google, Mistral). Their /models pricing is the PAID rate, so
//      filtering by price would hide the entire catalogue. What limits usage here is the
//      allowance, not the model, so the whole list is offered.
//
// A relay (custom) is the user's own key: their business, left untouched.

/** Vendors whose whole catalogue is free by policy (no per-model price published). */
const FREE_CATALOGUE = new Set(['agnes', 'agnes-cn', 'pollinations', 'llm7', 'ollama'])

/** Vendors with a per-account free allowance rather than free models. */
const FREE_TIER_VENDORS = new Set([
  'groq', 'cerebras', 'google', 'mistral', 'siliconflow', 'huggingface', 'github', 'cloudflare',
])

/**
 * Vendors that publish no price at all but DO have a documented free line, identified by
 * model-name pattern. Without this a vendor whose free models are real but unpriced would
 * be emptied out — which is exactly what happened to Zhipu, whose catalogue entry already
 * said "GLM-x.x-Flash 系列永久免费" while the filter ignored it.
 */
// Vendors whose /models list IS the free tier: they publish no pricing at all and every
// listed model is usable on the free allowance. Probed: agnes, antling, longcat, sambanova,
// modelscope, google, mistral, huggingface, llm7, ollama, pollinations, ainative, aion, amd.
// Probed each vendor's /models payload. These publish NO pricing at all: every model they
// list is usable on the free allowance, so the list itself is the free tier.
const FREE_LIST_IS_TIER = new Set([
  'agnes', 'agnes-cn', 'antling', 'longcat', 'modelscope',
  'google', 'mistral', 'huggingface', 'ollama', 'pollinations',
  'ainative', 'cohere', 'cerebras', 'cloudflare', 'github',
  'groq', 'nvidia', 'siliconflow', 'opencode', 'zhipu',
])

// Publishes pricing but charges nothing on the allowance: filtering by price empties it.
// Probed: llm7 67/0 zero-priced, sambanova 6/0, aion 6/0, amd 16/1.
const FREE_ALLOWANCE = new Set(['llm7', 'sambanova', 'aion', 'amd', 'cohere', 'cloudflare', 'github', 'opencode'])

// Per-vendor patterns that narrow a list down to its free line when the vendor DOES publish
// prices (so "list is the tier" would be wrong).
const FREE_PATTERN = {
  // Zhipu: the Flash line is the free tier (glm-4.5-flash, glm-5.3-flash, ...-flashx).
  zhipu: /-flashx?$/i,
  // NVIDIA NIM publishes no price; its small instruct models are the free demo tier.
  nvidia: /(?:-|\/)(?:1b|3b|4b|7b|8b|mini|small|nano)(?:-|$)/i,
  // ModelScope: the Pro/paid tiers are the non-free ones.
  modelscope: /(?:^|\/)(?!.*-Pro$)/i,
  // SiliconFlow: only the Flash line is free (measured: the account lists 98 models, the
  // free tier is DeepSeek-V4.1-Flash and GLM-5.3-Flash).
  siliconflow: /-flash/i,
}

/** Vendors this rule applies to; relays keep their full list. */
const FIRST_PARTY = new Set([
  'openrouter', 'google', 'groq', 'mistral', 'cerebras', 'nvidia', 'cohere', 'huggingface',
  'zhipu', 'siliconflow', 'moonshot', 'github', 'cloudflare', 'modelscope', 'together',
  'sambanova', 'nebius', 'amd', 'dashscope', 'stepfun', 'longcat', 'sensenova', 'agnes',
  'antling', 'agnes-cn', 'ollama', 'llm7', 'pollinations',
  // Added: these carry free tiers and must be filtered like the rest.
  'opencode', 'ainative', 'aion',
])
/** True when a model entry says, in its own payload, that it costs nothing. */
function pricedFree(item) {
  if (item === null || typeof item !== 'object') return null
  const pricing = item.pricing
  if (pricing === null || typeof pricing !== 'object') return null
  const prompt = Number(pricing.prompt)
  const completion = Number(pricing.completion)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null
  return prompt === 0 && completion === 0
}

/**
 * Model ids a first-party vendor may expose in the pool.
 * `items` is the raw vendor payload so pricing evidence is available here.
 */
function freeModelsFor(provider, items, ids) {
  const slug = provider.slug
  // A genuine third-party relay is the user's own business: show what it serves.
  if (!FIRST_PARTY.has(slug)) return ids

  const pattern = FREE_PATTERN[slug]

  // Three cases, decided by probing each vendor's /models payload:
  //
  //   1. FREE_LIST_IS_TIER — publishes no pricing; the whole list is the free allowance.
  //   2. FREE_ALLOWANCE    — publishes pricing but charges nothing on the allowance;
  //                          filtering by price would empty it (llm7, sambanova, aion, amd).
  //   3. otherwise         — publishes real prices with a paid majority; keep only models
  //                          proven free (openrouter: 20 free of 469).
  if (FREE_LIST_IS_TIER.has(slug) || FREE_ALLOWANCE.has(slug)) {
    return pattern === undefined ? ids : ids.filter((id) => pattern.test(id))
  }

  const byId = new Map()
  for (const item of items) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string') byId.set(item.id, item)
  }
  const kept = []
  for (const id of ids) {
    if (pricedFree(byId.get(id)) === true) { kept.push(id); continue }
    if (/:free$|-free$/i.test(id)) { kept.push(id); continue }
    if (pattern !== undefined && pattern.test(id)) kept.push(id)
  }
  return kept
}

async function poolGroup(provider) {
  const entry = keysFor(provider)[0]
  const cacheKey = provider.slug + '|' + entry.key
  const cached = POOL_CACHE.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < POOL_TTL_MS) {
    return { ...cached.value, cached: true }
  }
  const group = poolGroupBase(provider, entry)
  if (deadHost(group.baseUrl)) {
    group.error = '站点无响应（本次已标记）'
    return group
  }
  try {
    const res = await withTimeout(
      httpJson(group.baseUrl + '/models', { headers: authHeader(entry.key, provider) }),
      PROBE_TIMEOUT_MS,
    )
    if (!res.ok) {
      group.error = failureText(res, hostOf(group.baseUrl))
      if (res.status === 0) markDead(group.baseUrl)
    } else {
      const ids = extractModels(res.json, provider)
      const items = Array.isArray(res.json.data) ? res.json.data
        : Array.isArray(res.json.models) ? res.json.models
          : Array.isArray(res.json) ? res.json : []
      // Free AND usable for chat: a free image or music model is not a pool model.
      const free = freeModelsFor(provider, items, ids).filter((id) => !NOT_CHAT.test(id))
      // Only models DSH will actually accept: offering the rest is a choice that cannot work.
      const hostModels = group.hostModels
      const usable = hostModels === null ? free : free.filter((id) => hostModels.includes(id))
      group.models = usable
      group.totalModels = ids.length
      if (free.length === 0 && ids.length > 0) {
        group.error = '该平台 ' + ids.length + ' 个模型都不是免费的，已全部隐藏'
      } else if (group.models.length === 0) {
        group.error = '接口正常但没有返回模型'
      }
    }
  } catch (error) {
    group.error = String((error && error.message) || error).slice(0, 120)
    markDead(group.baseUrl)
  }
  POOL_CACHE.set(cacheKey, { at: Date.now(), value: group })
  // Only persist a listing that actually has models; caching an error would keep the menu
  // empty for a day after one bad network moment.
  if (group.models.length > 0) savePoolDisk(provider.slug, group)
  return group
}

/** Groups already answered: the instant first response. */
// ── 模型清单磁盘缓存 ────────────────────────────────────────────────────────
//
// POOL_CACHE is per-process, so the first picker open after every restart re-probes every
// vendor and the menu sits empty until the stream starts producing. Persisting the last
// good listing lets the picker paint immediately and refresh in the background.
//
// Stale entries are served, not hidden: a model list from an hour ago is far more useful
// than a spinner, and the live probe corrects it a moment later.

const POOL_FILE = join(DATA_DIR, 'pool-cache.json')
const POOL_DISK_TTL_MS = 24 * 60 * 60_000

let poolDisk = null

function loadPoolDisk() {
  if (poolDisk !== null) return poolDisk
  poolDisk = {}
  try {
    if (existsSync(POOL_FILE)) {
      const parsed = JSON.parse(readFileSync(POOL_FILE, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') poolDisk = parsed
    }
  } catch (error) {
    // A corrupt cache is not an error worth reporting: it is rebuilt on the next probe.
  }
  return poolDisk
}

function savePoolDisk(provider, group) {
  const store = loadPoolDisk()
  store[provider] = { at: Date.now(), group }
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(POOL_FILE, JSON.stringify(store), 'utf8')
  } catch (error) {
    // Best-effort: a failed cache write must not fail the request.
  }
}

/** The last good listing for a provider, or null when absent/too old. */
function poolFromDisk(provider) {
  const hit = loadPoolDisk()[provider]
  if (hit === undefined || hit.group === undefined) return null
  if (Date.now() - hit.at > POOL_DISK_TTL_MS) return null
  return hit.group
}

function poolCached(want) {
  const out = []
  for (const provider of poolTargets(want)) {
    const entry = keysFor(provider)[0]
    const cached = POOL_CACHE.get(provider.slug + '|' + entry.key)
    if (cached !== undefined && Date.now() - cached.at < POOL_TTL_MS) {
      out.push({ ...cached.value, cached: true })
      continue
    }
    // Nothing in memory: serve the last persisted listing so the menu is never empty.
    const disk = poolFromDisk(provider.slug)
    if (disk !== null) out.push({ ...disk, cached: true, stale: true })
  }
  return out
}

// ── 用量记录与运行日志 ──────────────────────────────────────────────────────
//
// Every call the plugin makes on the user's behalf (speed test, Auto gateway) appends one
// record. The record is the single source for both the dashboard and the run log, so the
// two views can never disagree.
//
// Storage is an append-only JSONL file next to the vault: cheap to write, survives a crash
// mid-line (a torn line is skipped on read), and needs no migration when fields are added.

const USAGE_FILE = join(DATA_DIR, 'usage.jsonl')
const USAGE_MAX_LINES = 5000

/** Append one record. Never throws: telemetry must not break the request it describes. */
function recordUsage(record) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(USAGE_FILE, JSON.stringify(record) + '\n', 'utf8')
  } catch (error) {
    // Deliberately swallowed: a failed log must not fail the user's call.
  }
}

/** Read the log, newest last, tolerating a torn final line. */
function readUsage(limit = USAGE_MAX_LINES) {
  if (!existsSync(USAGE_FILE)) return []
  let text = ''
  try {
    text = readFileSync(USAGE_FILE, 'utf8')
  } catch (error) {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch (error) {
      // A partially written line from an interrupted write; skip it.
    }
  }
  return out.length > limit ? out.slice(out.length - limit) : out
}

/** Local YYYY-MM-DD, so "today" matches the user's clock rather than UTC. */
function dayOf(ms) {
  const t = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate())
}

/**
 * Aggregate the log into the numbers the dashboard shows.
 * `scope` is 'today' or 'all'; every field is summed from real records, never estimated.
 */
function usageSummary(scope) {
  const all = readUsage()
  const today = dayOf(Date.now())
  const rows = scope === 'today' ? all.filter((r) => dayOf(r.at) === today) : all

  const sum = (field) => rows.reduce((n, r) => n + (typeof r[field] === 'number' ? r[field] : 0), 0)
  const okRows = rows.filter((r) => r.ok === true)
  const speeds = okRows.map((r) => r.tps).filter((v) => typeof v === 'number' && v > 0)
  const ttfts = okRows.map((r) => r.ttftMs).filter((v) => typeof v === 'number' && v >= 0)
  const avg = (list) => (list.length === 0 ? null : round(list.reduce((a, b) => a + b, 0) / list.length, 1))

  const promptTokens = sum('promptTokens')
  const cachedTokens = sum('cachedTokens')
  return {
    scope,
    requests: rows.length,
    ok: okRows.length,
    failed: rows.length - okRows.length,
    successRate: rows.length === 0 ? null : round((okRows.length / rows.length) * 100, 1),
    promptTokens,
    completionTokens: sum('completionTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: promptTokens + sum('completionTokens'),
    cachedTokens,
    cacheHitRate: promptTokens === 0 ? null : round((cachedTokens / promptTokens) * 100, 1),
    avgTps: avg(speeds),
    avgTtftMs: avg(ttfts),
  }
}
// ── Auto 网关 ──────────────────────────────────────────────────────────────
//
// The plugin exposes an OpenAI-compatible endpoint at /dsh-free-pool/v1, and Auto models
// are routed through it. This is what makes Auto real: DSH only ever selects a provider +
// model id, so "auto" has to be a model id that something resolves at call time. Adding a
// provider entry in cordis.patch.yml is enough on the DSH side; the choosing happens here.
//
// Rules are explainable rather than clever: each profile is an ordered vendor preference,
// and the first vendor with a usable key and a reachable model wins. Every choice is
// reported in the x-dfp-route response header so Auto can be debugged.

const AUTO_MODELS = [
  { id: 'auto', name: 'Auto（自动选择）', hint: '按综合评分挑一个当前可用的模型',
    test: (m) => m.tier * 20 + Math.min(m.size, 120) },
  { id: 'auto-fast', name: 'Auto-Fast（最快）', hint: '优先低延迟大厂 + 大模型', mode: 'best-score',
    test: (m) => m.speed * 100 + (m.size >= 20 ? 50 : -200) },
  { id: 'auto-cheap', name: 'Auto-Cheap（最省额度）', hint: '优先真正免费的模型', mode: 'best-score',
    test: (m) => (m.zeroPrice ? 1000 : 0) + (m.free ? 200 : 0) + m.tier * 10 + m.size * 0.001 },
  { id: 'auto-code', name: 'Auto-Code（写代码）', hint: '优先代码能力强的模型系列', mode: 'best-score',
    test: (m) => (m.codeHint ? 1000 : 0) + m.tier * 10 + m.size },
  { id: 'auto-write', name: 'Auto-Write（写文章）', hint: '优先长上下文、擅长自然语言的模型', mode: 'best-score',
    test: (m) => (m.longContext ? 500 : 0) + (m.writeHint ? 400 : 0) + m.tier * 10 + m.size },
  // These two are ranked by live state rather than a fixed score, so their test() is only a
  // tie-breaker between targets with equal health.
  { id: 'auto-latency', name: 'Auto-Latency（实测最快）', hint: '按实测首字延迟排序，越用越准',
    test: (m) => m.tier * 10 + m.size * 0.01 },
  { id: 'auto-cost', name: 'Auto-Cost（单价最低）', hint: '按每百万 token 单价从低到高',
    test: (m) => m.tier * 10 + m.size * 0.01 },
]

/** Vendor preference per profile; order inside a list is the priority. */
const PROFILE_PREFERENCE = {
  auto: ['openrouter', 'google', 'groq', 'mistral', 'cerebras', 'nvidia', 'zhipu', 'siliconflow', 'moonshot', 'github'],
  'auto-fast': ['groq', 'cerebras', 'google', 'openrouter', 'mistral', 'siliconflow', 'nvidia'],
  'auto-cheap': ['google', 'groq', 'openrouter', 'cerebras', 'zhipu', 'siliconflow', 'ollama', 'llm7'],
  'auto-code': ['openrouter', 'google', 'groq', 'cerebras', 'mistral', 'zhipu', 'moonshot'],
  'auto-write': ['google', 'openrouter', 'mistral', 'moonshot', 'siliconflow', 'cerebras'],
  'auto-latency': ['groq', 'cerebras', 'google', 'openrouter', 'mistral', 'siliconflow', 'nvidia'],
  'auto-cost': ['google', 'groq', 'openrouter', 'cerebras', 'zhipu', 'siliconflow', 'ollama', 'llm7'],
}

/** Models that cannot serve a chat completion; never a routing target. */
const NOT_CHAT = /guard|embed|rerank|whisper|tts|orpheus|speech|audio|dall|image|moderation|classif|prompt-guard|vision-only|:batch|-batch|:extended|-extended|:thinking-|:online$|-online$|:floor$|:nitro$|lyria|veo|sora|imagen|stable-diffusion|flux|musicgen|bark|video/i

/**
 * Vendor quality tier (0-5). Auto uses this to avoid promoting an unknown relay over a
 * first-party vendor just because it happened to list more models.
 */
const TIER = {
  openrouter: 5, google: 5, groq: 4, mistral: 4, cerebras: 4, nvidia: 4, moonshot: 4, zhipu: 4,
  siliconflow: 3, github: 3, cohere: 3, together: 3, sambanova: 3, nebius: 3, amd: 3,
  huggingface: 2, cloudflare: 2, modelscope: 2, ollama: 2, llm7: 2, pollinations: 1,
  dashscope: 3, stepfun: 3, longcat: 2, sensenova: 2, agnes: 2, antling: 2,
}

/**
 * Capability proxy from the model id. Explicit parameter counts ("27b", "120b") are the
 * strongest signal available without calling the model; otherwise well-known families get
 * a conventional weight. It is only ever a tie-breaker.
 */
function modelSize(id) {
  const raw = String(id || '')
  // MoE ids often carry both total and active parameters ("550b-a55b"): the active count is
  // what runs per token, so prefer it when present.
  const active = /-a([0-9]+(?:\.[0-9]+)?)b/i.exec(raw)
  if (active !== null) return Math.min(300, Number(active[1]))
  const b = /([0-9]+(?:\.[0-9]+)?)\s*b(?:[-_]|$)/i.exec(raw)
  if (b !== null) return Math.min(300, Number(b[1]))
  if (/opus|gpt-4|gpt-5|sonnet|pro|max|large/i.test(raw)) return 120
  if (/-mini|small|flash|lite|nano|tiny/i.test(raw)) return 8
  return 30
}

/** Per-vendor latency profile. Measuring every model before choosing costs more than it saves. */
/**
 * Latency tier per vendor, from observed behaviour rather than marketing:
 *   3 = purpose-built inference (Groq LPU, Cerebras WSE)
 *   2 = first-party clouds with dedicated endpoints
 *   1 = aggregators that fan out to whichever upstream is cheapest
 *   0 = hosts known for queueing (NIM community endpoints, voucher-based relays)
 */
const VENDOR_SPEED = {
  groq: 3, cerebras: 3,
  google: 2, openrouter: 2, mistral: 2, siliconflow: 2, together: 2, sambanova: 2,
  zhipu: 1, moonshot: 1, dashscope: 1, stepfun: 1, nebius: 1, amd: 1,
  nvidia: 0, ollama: 0, huggingface: 0, cloudflare: 0, modelscope: 0, llm7: 0,
}

const ROUTE_CACHE = new Map()
const ROUTE_TTL_MS = 5 * 60_000

function autoModel(id) {
  const want = String(id || '').toLowerCase()
  return AUTO_MODELS.find((m) => m.id === want)
}

/** Candidate models for one vendor, tagged with the facts the rules use. */
async function candidatesFor(provider) {
  const entry = keysFor(provider)[0]
  if (entry === undefined) return []
  const cacheKey = 'models|' + provider.slug + '|' + entry.key
  const cached = ROUTE_CACHE.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < ROUTE_TTL_MS) return cached.value
  // Deliberately do NOT honour the dead mark here: one transient failure must not
  // permanently demote a first-party vendor for every later Auto call. The probe path
  // still uses deadHost; routing re-checks, and the model cache holds the answer.

  let models = []
  try {
    const res = await withTimeout(
      httpJson(trimBase(provider.baseUrl) + '/models', { headers: authHeader(entry.key, provider) }),
      PROBE_TIMEOUT_MS,
    )
    if (!res.ok) {
      if (res.status === 0) markDead(provider.baseUrl)
      ROUTE_CACHE.set(cacheKey, { at: Date.now(), value: [] })
      return []
    }
    models = extractModels(res.json, provider).filter((id) => !NOT_CHAT.test(id))
  } catch (error) {
    markDead(provider.baseUrl)
    return []
  }

  const quota = cachedProbe(entry.key)
  const balance = quota !== null && typeof quota.quota.totalRemaining === 'number' ? quota.quota.totalRemaining : null
  const tier = TIER[provider.slug] === undefined ? 1 : TIER[provider.slug]
  const value = models.map((id) => ({
    id,
    provider: provider.slug,
    baseUrl: trimBase(provider.baseUrl),
    key: entry.key,
    // Free-ness is a per-model property for aggregators (":free") and per-vendor otherwise.
    free: /:free$|-free$|free/i.test(id) || provider.freeKind === 'long-term',
    zeroPrice: /:free$|-free$/i.test(id),
    speed: VENDOR_SPEED[provider.slug] === undefined ? 2 : VENDOR_SPEED[provider.slug],
    tier,
    // A rough capability proxy from the model name: parameter count if stated, else 0.
    size: modelSize(id),
    longContext: /128k|200k|1m|long|pro|max|sonnet|gemini|gpt-4/i.test(id),
    codeHint: /coder|codestral|deepseek|qwen|gpt-oss|claude|devstral|kimi|glm|o3|o4/i.test(id),
    writeHint: /pro|max|plus|large|sonnet|opus|gemini|gpt-4|claude/i.test(id),
    balance,
  }))
  ROUTE_CACHE.set(cacheKey, { at: Date.now(), value })
  return value
}

/**
 * Pick one target for a profile. Vendor preference decides the vendor order and the
 * profile's own scorer decides the model inside it, so an explicit preference always
 * beats a marginally better score elsewhere — that is what makes profiles predictable.
 */

/**
 * Resolve a "vendor/model" request to that exact target.
 *
 * The gateway advertises pool models as "<vendorSlug>/<modelId>". A request carrying that
 * prefix means a specific model was chosen, so it is sent there directly. Auto ids have no
 * prefix and fall through to the router.
 */
function pinnedTarget(requested) {
  const raw = String(requested || '')
  const slash = raw.indexOf('/')
  if (slash <= 0) return null
  const slug = raw.slice(0, slash)
  const modelId = raw.slice(slash + 1)
  if (slug === '' || modelId === '') return null

  const provider = findProvider(slug) || customProviders().find((p) => p.slug === slug)
  if (provider === undefined) return null
  const entry = keysFor(provider)[0]
  if (entry === undefined) return null
  const baseUrl = trimBase(entry.baseUrl || provider.baseUrl)
  if (baseUrl === '') return null

  return {
    queue: [{
      target: {
        provider: provider.slug,
        key: entry.key,
        baseUrl,
        id: modelId,
      },
      // A pinned pick has no alternatives: if it fails the caller must say so.
      pinned: true,
    }],
    tried: [],
    picked: { provider: provider.slug, model: modelId },
  }
}

async function pickTarget(profile) {
  // "vendor/model" means the user picked a specific model from the pool in DSH's own menu.
  // Honour it exactly: no routing, no fallback — the request asked for that model.
  const pinned = pinnedTarget(profile)
  if (pinned !== null) return pinned

  const spec = autoModel(profile) || AUTO_MODELS[0]
  const pref = PROFILE_PREFERENCE[spec.id] || PROFILE_PREFERENCE.auto
  const catalog = loadProviders().providers || []
  const ordered = []
  for (const slug of pref) {
    const provider = catalog.find((p) => p.slug === slug)
    if (provider !== undefined && keysFor(provider).length > 0) ordered.push(provider)
  }
  // Anything else with a key is a last resort, never excluded outright.
  for (const provider of catalog) {
    if (ordered.indexOf(provider) >= 0) continue
    if (provider.category === 'custom') continue
    if (keysFor(provider).length > 0) ordered.push(provider)
  }

  const tried = []
  const all = []
  const eligible = []
  for (const provider of ordered) {
    // A vendor that already burned today's allowance is skipped for routing, not hidden:
    // the panel still shows it, and the reason is reported here.
    if (overBudget(provider.slug)) {
      tried.push(provider.name + '：已达今日预算');
      continue
    }
    eligible.push(provider)
  }
  // Parallel: one slow vendor must not delay the others. The first call after a restart
  // otherwise waits on every listing in sequence (measured at ~50s).
  const listings = await Promise.all(eligible.map((provider) =>
    candidatesFor(provider).catch(() => [])))
  for (let i = 0; i < eligible.length; i += 1) {
    const provider = eligible[i]
    const models = listings[i]
    if (models.length === 0) {
      tried.push(provider.name + '：无可用模型')
      continue
    }
    for (const m of models) {
      all.push({ m, provider, score: spec.test(m), rank: pref.indexOf(provider.slug) })
    }
  }

  // Health filters run before scoring so a benched target cannot win on score.
  const healthy = all.filter((e) => benchedFor(e.provider.slug, e.m.id) === 0)
  const benched = all.length - healthy.length
  if (benched > 0) tried.push(benched + ' 个目标冷却中')

  const withHealth = (list) => list.map((e) => ({
    ...e,
    // Measured TTFT when we have it; otherwise the vendor's static tier, so a brand-new
    // install still ranks sensibly before any real sample exists.
    measured: latencyOf(e.provider.slug, e.m.id),
    price: priceOf(e.m.id),
  }))

  let queue = []
  const ranked = withHealth(healthy)

  if (spec.id === 'auto-latency') {
    // Latency-first: real measurements beat static tiers, unmeasured targets sit in the
    // middle so they get sampled instead of being starved forever.
    ranked.sort((a, b) => {
      const av = a.measured === null ? 1500 : a.measured
      const bv = b.measured === null ? 1500 : b.measured
      return av - bv || b.score - a.score || a.rank - b.rank
    })
  } else if (spec.id === 'auto-cost') {
    ranked.sort((a, b) => a.price - b.price || b.score - a.score || a.rank - b.rank)
  } else if (spec.mode === 'best-score') {
    ranked.sort((a, b) => b.score - a.score || a.rank - b.rank)
  }

  if (spec.id === 'auto-latency' || spec.id === 'auto-cost' || spec.mode === 'best-score') {
    queue = ranked.slice(0, 12).map((e) => ({
      target: e.m,
      reason: e.provider.name + ' · ' + e.m.id + (e.measured === null ? '' : ' · ' + e.measured + 'ms'),
    }))
  } else {
    // Default: vendor preference decides the order, the score picks inside that vendor.
    for (const provider of ordered) {
      const mine = ranked.filter((e) => e.provider === provider).sort((a, b) => b.score - a.score)
      for (const e of mine.slice(0, 3)) {
        queue.push({ target: e.m, reason: provider.name + ' · ' + e.m.id })
      }
    }
  }
  return { queue, tried }
}


// ── 路由健康状态：冷却 / 实测延迟 / 成本 / 预算 ─────────────────────────────
//
// Four pieces of shared state, all keyed by "provider|model":
//   COOLDOWN  a target that just failed is not retried for a while (exponential, capped);
//   LATENCY   the rolling mean time-to-first-token actually observed;
//   COST      a per-model price used by the cost-first profile;
//   SPEND     tokens spent per vendor today, checked against a configured budget.
//
// They live in memory only. Persisting them would make a stale failure outlive the process,
// and the log already records every call for anyone who wants history.

const COOLDOWN = new Map()
const LATENCY = new Map()
const COST = new Map()
const SPEND = new Map()

const COOLDOWN_BASE_MS = 15_000
const COOLDOWN_MAX_MS = 10 * 60_000

function targetKey(provider, model) { return String(provider) + '|' + String(model) }

/**
 * Record a failure and return how long this target is benched.
 * The delay doubles per consecutive failure up to a cap, so a flapping vendor stops being
 * hammered while a one-off 502 costs only a few seconds.
 */
function benchTarget(provider, model, reason) {
  const key = targetKey(provider, model)
  const prev = COOLDOWN.get(key)
  const strikes = prev === undefined ? 1 : Math.min(prev.strikes + 1, 8)
  const ms = Math.min(COOLDOWN_BASE_MS * 2 ** (strikes - 1), COOLDOWN_MAX_MS)
  COOLDOWN.set(key, { until: Date.now() + ms, strikes, reason: String(reason || '').slice(0, 120) })
  return ms
}

/** Clear a target's strikes: it answered, so it is healthy again. */
function clearBench(provider, model) { COOLDOWN.delete(targetKey(provider, model)) }

/** Milliseconds remaining on a bench, or 0 when the target may be tried. */
function benchedFor(provider, model) {
  const hit = COOLDOWN.get(targetKey(provider, model))
  if (hit === undefined) return 0
  const left = hit.until - Date.now()
  if (left <= 0) { COOLDOWN.delete(targetKey(provider, model)); return 0 }
  return left
}

/** Rolling mean TTFT; a slow sample never erases a fast history entirely. */
function noteLatency(provider, model, ttftMs) {
  if (typeof ttftMs !== 'number' || ttftMs < 0) return
  const key = targetKey(provider, model)
  const prev = LATENCY.get(key)
  const value = prev === undefined ? ttftMs : Math.round(prev.mean * 0.7 + ttftMs * 0.3)
  LATENCY.set(key, { mean: value, samples: (prev === undefined ? 0 : prev.samples) + 1, at: Date.now() });
}

function latencyOf(provider, model) {
  const hit = LATENCY.get(targetKey(provider, model))
  return hit === undefined ? null : hit.mean
}

/**
 * Price per 1M tokens, in USD. Only used to rank the cost-first profile; a model with no
 * known price is treated as free, which matches the free-tier catalogue this plugin targets.
 */
const PRICE_PER_MTOK = [
  [/^gpt-oss|^openai\/gpt-oss/, 0],
  [/free$|:free/, 0],
  [/gemini.*flash/, 0.075],
  [/gemini.*pro/, 1.25],
  [/gpt-4o-mini|gpt-4\.1-mini/, 0.15],
  [/gpt-4o|gpt-4\.1/, 2.5],
  [/claude.*haiku/, 0.25],
  [/claude.*sonnet/, 3],
  [/claude.*opus/, 15],
  [/deepseek/, 0.28],
  [/qwen/, 0.2],
  [/llama/, 0.2],
  [/mistral-large/, 2],
  [/mistral/, 0.25],
]

function priceOf(model) {
  const key = targetKey('', model)
  const cached = COST.get(key)
  if (cached !== undefined) return cached
  const id = String(model || '').toLowerCase()
  let price = 0.5
  for (const [re, value] of PRICE_PER_MTOK) {
    if (re.test(id)) { price = value; break }
  }
  COST.set(key, price)
  return price
}

/**
 * Per-vendor daily budget in tokens. A vendor with no entry is unbudgeted.
 * 0 means "no budget"; the check below treats a missing entry the same way.
 */
const DAILY_BUDGET = {
  // Free tiers publish per-day caps in the same order of magnitude; a single runaway loop
  // should hit this before it burns the whole day's allowance.
  groq: 200_000,
  cerebras: 1_000_000,
  google: 500_000,
  mistral: 300_000,
  openrouter: 200_000,
}

function spendKey(provider) { return String(provider) + '|' + dayOf(Date.now()) }

function spentToday(provider) {
  const hit = SPEND.get(spendKey(provider))
  return hit === undefined ? 0 : hit
}

function noteSpend(provider, tokens) {
  if (typeof tokens !== 'number' || tokens <= 0) return
  const key = spendKey(provider)
  SPEND.set(key, spentToday(provider) + tokens);
}

/** True when the vendor has already used its configured daily allowance. */
function overBudget(provider) {
  const cap = DAILY_BUDGET[provider]
  if (cap === undefined || cap <= 0) return false
  return spentToday(provider) >= cap;
}

/** Human-readable state for the panel: what is benched and why. */
function routingState() {
  const now = Date.now()
  const cooling = []
  for (const [key, value] of COOLDOWN) {
    if (value.until <= now) continue
    const [provider, model] = key.split('|')
    cooling.push({ provider, model, secondsLeft: Math.ceil((value.until - now) / 1000), strikes: value.strikes, reason: value.reason })
  }
  const budgets = Object.keys(DAILY_BUDGET).map((provider) => ({
    provider,
    used: spentToday(provider),
    cap: DAILY_BUDGET[provider],
    over: overBudget(provider),
  }));
  return { cooling, budgets }
}

/** OpenAI-shaped model list for the gateway. */
/**
 * Every model the gateway can serve: the Auto profiles plus each registered vendor's models.
 *
 * The vendor models are exposed as "vendor/model" ids so one provider can carry the whole
 * pool. DSH shows exactly this list under the pool's single displayName, which is what keeps
 * the official menu to one heading instead of one per vendor.
 */
function gatewayModels() {
  const data = AUTO_MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: 'dsh-free-api-pool' }))
  const seen = new Set(data.map((m) => m.id))
  for (const row of poolCatalog()) {
    if (row.models === null || row.models.length === 0) continue
    for (const id of row.models) {
      // "vendor/model" keeps ids unique across vendors and readable in the menu.
      const exposed = row.slug + '/' + id
      if (seen.has(exposed)) continue
      seen.add(exposed)
      data.push({ id: exposed, object: 'model', owned_by: 'dsh-free-api-pool' })
    }
  }
  return { object: 'list', data }
}

/**
 * Snapshot of every registered vendor and its model ids, read from the profile.
 * Cheap (one file read, cached) and used both by the gateway and the self check.
 */
function poolCatalog() {
  const catalog = readHostCatalog()
  const rows = []
  for (const [providerId, models] of Object.entries(catalog)) {
    if (!providerId.startsWith('dfp-') || providerId === 'dfp-auto') continue
    rows.push({ slug: providerId.replace(/^dfp-/, ''), providerId, models: Array.isArray(models) ? models : [] })
  }
  return rows
}

/**
 * Forward one chat completion. Streaming bodies are piped through unchanged: the
 * gateway's job is choosing a target, not rewriting the wire format.
 */
async function gatewayChat(body, response) {
  const requested = body && body.model ? String(body.model) : 'auto'
  const picked = await pickTarget(requested)
  if (picked.queue.length === 0) {
    sendJson(response, 503, {
      error: {
        message: '免费池里没有可用模型：所有厂商要么没有 Key，要么全部不可达。'
          + '请在面板里检查 Key 或网络环境。'
          + (picked.tried.length > 0 ? '（' + picked.tried.slice(0, 4).join('；') + '）' : ''),
        type: 'no_available_model',
      },
    })
    return
  }

  const failures = []
  const startedAtGateway = Date.now()
  // A 402 (no credit), 429 (rate limit) or 5xx is a bad TARGET, not a bad request, so the
  // next candidate gets a turn before the user sees an error. A 4xx about the request
  // itself is returned as-is: retrying it elsewhere would only produce the same answer.
  for (const candidate of picked.queue) {
    const target = candidate.target
    const provider = findProvider(target.provider)
    const headers = {
      'content-type': 'application/json',
      accept: body.stream === true ? 'text/event-stream' : 'application/json',
      ...authHeader(target.key, provider),
    }

    let upstream
    try {
      upstream = await fetch(target.baseUrl + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, model: target.id }),
        signal: AbortSignal.timeout(180000),
      })
    } catch (error) {
      markDead(target.baseUrl)
      const wait = benchTarget(target.provider, target.id, String((error && error.message) || error))
      failures.push(candidate.reason + '：' + String((error && error.message) || error).slice(0, 60)
        + '（冷却 ' + Math.round(wait / 1000) + 's）')
      continue
    }

    // 402/429/5xx mean "this target cannot serve right now"; 404 means "this id does not
    // serve this endpoint" — both are the target's fault, so both fall through to the next
    // candidate rather than being returned as the user's answer.
    let retryable = upstream.status === 402 || upstream.status === 429
      || upstream.status === 404 || upstream.status >= 500
    let detail = ''
    // A 200 whose body is {"error":...} is a failed target too: OpenRouter returns exactly
    // that when the free upstream is overloaded.
    if (!retryable && upstream.status === 200 && body.stream !== true) {
      detail = await upstream.text().catch(() => '')
      try {
        const parsed = JSON.parse(detail)
        if (parsed !== null && typeof parsed === 'object' && parsed.error !== undefined) retryable = true
      } catch (error) {
        // Not JSON: leave it to the normal path, which forwards the text untouched.
      }
      if (!retryable) {
        // It was a real answer: replay it rather than losing the body we already read.
        const contentType = upstream.headers.get('content-type') || 'application/json'
        response.writeHead(upstream.status, {
          'content-type': contentType,
          'cache-control': 'no-store',
          'x-dfp-route': encodeURIComponent(candidate.reason),
        })
        response.end(detail)
        return
      }
    }
    if (retryable && detail === '') {
      detail = await upstream.text().catch(() => '')
    }
    if (retryable) {
      const wait = benchTarget(target.provider, target.id, 'HTTP ' + upstream.status)
      failures.push(candidate.reason + '：HTTP ' + upstream.status
        + '（冷却 ' + Math.round(wait / 1000) + 's）')
      // Clear the cache entry so the next call does not retry a known-broke target first.
      // Forget this vendor's model list so the next call re-lists it rather than
      // retrying a target that just proved it cannot serve.
      ROUTE_CACHE.delete('models|' + target.provider + '|' + target.key)
      if (failures.length === picked.queue.length) {
        sendJson(response, upstream.status, {
          error: {
            message: '所有候选模型都失败了：' + failures.join('；'),
            type: 'all_candidates_failed',
            detail: String(detail).slice(0, 400),
          },
        })
        return
      }
      continue
    }

    const contentType = upstream.headers.get('content-type') || 'application/json'
    // It answered: healthy again, and worth remembering how fast.
    clearBench(target.provider, target.id)
    noteLatency(target.provider, target.id, Date.now() - startedAtGateway)
    recordUsage({
      at: Date.now(),
      kind: 'gateway',
      provider: target.provider,
      providerName: provider === undefined ? target.provider : provider.name,
      model: target.id,
      account: '',
      channel: 'Auto',
      ok: true,
      status: upstream.status,
      requested: requested,
      fallbacks: failures.length,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      ttftMs: null,
      tps: null,
      totalMs: Date.now() - startedAtGateway,
    })
    response.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      // Surfacing the choice makes Auto debuggable instead of magic.
      'x-dfp-route': encodeURIComponent(candidate.reason),
      ...(failures.length > 0 ? { 'x-dfp-fallbacks': String(failures.length) } : {}),
    })
    if (upstream.body === null) {
      response.end()
      return
    }
    const reader = upstream.body.getReader()
    // Keep the last few KB so the final SSE frame (which carries token usage) can be read
    // without buffering the whole response.
    let tail = ''
    let seenChars = 0
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done) break
        const chunk = Buffer.from(step.value)
        response.write(chunk)
        seenChars += chunk.length
        tail = (tail + chunk.toString('utf8')).slice(-4096)
      }
    } catch (error) {
      // A client that walked away is normal; the stream simply ends.
    }
    // Charge the vendor's daily budget from the real usage frame when present.
    const usageHit = /"usage"\s*:\s*\{([^}]*)\}/.exec(tail)
    let charged = 0
    if (usageHit !== null) {
      const pt = /"prompt_tokens"\s*:\s*(\d+)/.exec(usageHit[1])
      const ct = /"completion_tokens"\s*:\s*(\d+)/.exec(usageHit[1])
      charged = (pt === null ? 0 : Number(pt[1])) + (ct === null ? 0 : Number(ct[1]))
    }
    // No usage frame (some relays omit it): approximate one token per 4 bytes of output.
    if (charged === 0) charged = Math.round(seenChars / 4)
    noteSpend(target.provider, charged)
    response.end()
    return
  }
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

/** Provider facts safe to send to the browser (no raw keys, no accounts). */
function publicProvider(p) {
  const entries = entriesFor(p)
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
    keyCount: entries.length,
    keys: entries.map((e) => ({
      id: e.id,
      label: e.label,
      masked: maskKey(e.key),
      baseUrl: e.baseUrl,
      addedAt: e.addedAt,
    })),
    hasCredential: p.category === 'custom' ? false : credentialsFor(p).length > 0,
    account: (() => {
      if (p.category === 'custom') return ''
      const c = credentialsFor(p)
      return c.length > 0 ? c[0].username : ''
    })(),
  }
}

/**
 * Identity of the card a vault entry belongs to.
 *
 * A catalog slug is its own identity. A custom entry is not: FreeLLMAPI writes every
 * user-declared relay as platform "custom", so grouping by slug would collapse dozens of
 * unrelated relays into one card. A custom entry is grouped by its normalized base URL
 * instead, which keeps "one relay, many keys" while separating different relays.
 */
function providerKeyOf(entry) {
  if (findProvider(entry.slug) !== undefined) return entry.slug
  return 'custom:' + normalizeBase(entry.baseUrl || entry.label || entry.slug)
}

function normalizeBase(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * Providers the user has keys for but that no catalog row describes — every `custom` row in
 * a FreeLLMAPI import lands here, and each distinct relay still has to appear as its own card.
 */

/**
 * Map a vault entry to its catalogue vendor, by slug first and by host second.
 *
 * Users import keys with whatever slug their export used ("custom", "groq2", …). When the
 * host belongs to a known vendor, that vendor's rules apply — which is what makes free-model
 * filtering work for imported keys. Returns undefined for a genuine relay.
 */
function catalogueProviderForEntry(entry) {
  const direct = findProvider(entry.slug)
  if (direct !== undefined) return direct
  const host = hostOf(String(entry.baseUrl || ''))
  if (host === '') return undefined
  const providers = loadProviders().providers || []
  for (const provider of providers) {
    if (hostOf(String(provider.baseUrl || '')) === host) return provider
  }
  return undefined
}

function customProviders() {
  const seen = new Map()
  for (const entry of loadVault().entries) {
    // A key whose host belongs to a known vendor is NOT a relay: it must go through that
    // vendor's registration so free-model filtering applies.
    if (catalogueProviderForEntry(entry) !== undefined) continue
    const key = providerKeyOf(entry)
    if (seen.has(key)) continue
    seen.set(key, {
      slug: key,
      name: entry.label || entry.slug,
      vendor: '自定义中转站',
      category: 'custom',
      baseUrl: entry.baseUrl,
      applyUrl: '',
      docsUrl: '',
      homepage: '',
      freeKind: 'unknown',
      freeNote: '自定义导入的中转站',
      probe: 'models',
      checkin: false,
      keyHint: '',
      needsAccount: false,
    })
  }
  return [...seen.values()]
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
    // ── Auto 网关（OpenAI 兼容）──────────────────────────────────────────
    // DSH selects a provider+model id and posts here; this is where "auto" becomes real.
    if (path === '/dsh-free-pool/v1/models' && method === 'GET') {
      sendJson(response, 200, gatewayModels())
      return
    }
    if (path === '/dsh-free-pool/v1/chat/completions' && method === 'POST') {
      await gatewayChat(await readJson(request), response)
      return
    }
    if (path === '/dsh-free-pool/v1/route') {
      // Debug aid: what Auto would choose right now, without making a completion.
      const profile = url.searchParams.get('profile') || 'auto'
      const picked = await pickTarget(profile)
      const head = picked.queue.length === 0 ? null : picked.queue[0]
      sendJson(response, 200, {
        profile,
        picked: head === null ? null : {
          provider: head.target.provider,
          model: head.target.id,
          baseUrl: head.target.baseUrl,
        },
        candidates: picked.queue.length,
        reason: head === null ? '' : head.reason,
        tried: picked.tried,
        health: routingState(),
        profiles: AUTO_MODELS.map((m) => ({ id: m.id, name: m.name, hint: m.hint })),
      })
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/providers') {
      const catalog = (loadProviders().providers || []).map(publicProvider)
      const providers = [...catalog, ...customProviders().map(publicProvider)]
      sendJson(response, 200, { total: providers.length, providers })
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/quota') {
      // Vault-only by default: zero network, so the panel paints instantly.
      sendJson(response, 200, quotaList())
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/quota/probe') {
      const input = await readJson(request)
      const slugs = Array.isArray(input.slugs) ? input.slugs.map((s) => String(s)) : []
      sendJson(response, 200, await quotaProbe({ slugs, onlyWithKeys: input.onlyWithKeys !== false }))
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/gateway') {
      sendJson(response, 200, {
        port: GATEWAY_PORT,
        baseUrl: gatewayBaseUrl(),
        state: gatewayState,
        // 'shared' means another DSH instance owns the port: requests still work, but it is
        // a strong hint that several instances are running and confusing each other.
        multipleInstances: gatewayConflict,
      })
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/reload') {
      // Re-import the host module and swap the live handler. Lets host-side changes take
      // effect without restarting DSH, which is otherwise the only way.
      const result = await reloadPlugin()
      sendJson(response, 200, { ok: result.ok, reason: result.reason, reloads: reloadCount })
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/self-check') {
      // Read-only. Reports which platforms can actually be switched to, and why the rest
      // cannot. Nothing here touches the profile.
      sendJson(response, 200, selfCheck())
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/snippet') {
      // The exact text to paste into providers, generated on demand and never written by us.
      sendJson(response, 200, providerSnippet(String(url.searchParams.get('slug') || '')))
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/register-all') {
      // Pull every vendor's model list and write its provider. One listing per vendor, so
      // this is slow by nature; the panel shows progress instead of blocking.
      const results = await registerAllProviders()
      sendJson(response, 200, {
        ok: true,
        total: results.length,
        registered: results.filter((r) => r.ok).length,
        results,
      })
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/usage') {
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'today'
      sendJson(response, 200, { at: Date.now(), summary: usageSummary(scope) })
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/usage/log') {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 50)))
      const rows = readUsage()
      // Newest first: a run log is read from the top.
      sendJson(response, 200, { at: Date.now(), total: rows.length, rows: rows.slice(-limit).reverse() })
      return
    }
    if (method === 'GET' && path === '/dsh-free-pool/free-models') {
      sendJson(response, 200, await freeModels())
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/pool-models') {
      const input = await readJson(request)
      const want = Array.isArray(input.slugs) ? input.slugs.map((v) => String(v)) : []

      // Stream newline-delimited JSON so the picker shows what is already known at once.
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      const line = (obj) => response.write(JSON.stringify(obj) + '\n')

      const cached = poolCached(want)
      line({ kind: 'init', at: Date.now(), groups: cached })

      const have = new Set(cached.map((g) => g.slug))
      const pending = poolTargets(want).filter((p) => !have.has(p.slug))
      // Bounded concurrency keeps a hundred slow relays from saturating the socket pool.
      await mapLimit(pending, 10, async (provider) => {
        const group = await poolGroup(provider)
        line({ kind: 'group', group })
      })
      line({ kind: 'done', at: Date.now() })
      response.end()
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
      // A stored key whose provider DSH does not know is a key the pool cannot use, so
      // adding one registers it. The write is validated, atomic and backed up.
      const registered = await registerProviderFor(entry.slug)
      sendJson(response, 200, {
        ok: true,
        id: entry.id,
        masked: maskKey(entry.key),
        registered,
        snippet: registered.ok === true ? null : providerSnippet(entry.slug),
      })
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/vault/remove') {
      const input = await readJson(request)
      const removed = removeEntry(String(input.id ?? '').trim())
      // Drop the provider only when this was its last key, so a sibling key keeps working.
      let unregistered = false
      const provider = findProvider(removed.slug) || customProviders().find((p) => p.slug === removed.slug)
      if (provider !== undefined && keysFor(provider).length === 0) {
        unregistered = removeProviderFromProfile(providerIdFor(removed.slug))
      }
      sendJson(response, 200, { ok: true, slug: removed.slug, unregistered })
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/vault/export') {
      sendJson(response, 200, { ...exportFreeLLM(), count: loadVault().entries.length })
      return
    }
    if (method === 'POST' && path === '/dsh-free-pool/vault/import') {
      const input = await readJson(request)
      // The browser posts the parsed file; a raw string is accepted too so curl works.
      const parsed = typeof input.data === 'string' ? JSON.parse(input.data) : (input.data ?? input)
      const result = importFreeLLM(parsed)
      // An import is a bulk add, so it registers too — that is the whole point of importing.
      const registration = result.added > 0 ? await registerAllProviders() : []
      sendJson(response, 200, {
        ...result,
        registered: registration.filter((r) => r.ok).length,
        registration,
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



// ── 热重载 ──────────────────────────────────────────────────────────────────
//
// DSH does not watch plugin directories (verified: editing a file leaves the running code
// untouched), so every host-side change otherwise needs a full restart. That is the main
// source of friction when iterating on this plugin.
//
// The reload below re-imports this module with a cache-busting query and re-applies it:
//
//   * the gateway listener is process-wide and already bound to the fixed port, so the new
//     module ADOPTS the existing server instead of trying to bind again (which would EADDRINUSE);
//   * the old module's route handler is replaced by pointing the host registration at the new
//     handler — the host keeps one registration per process;
//   * everything else (vault, catalog, caches) is read from disk, so nothing is lost.
//
// Exposed as POST /reload. It is intentionally not reachable from the panel: reloading while
// a request is in flight would drop it.

/** Set by the first module that binds the port; later reloads adopt it. */
const RELOAD_STATE_KEY = Symbol.for('dsh-free-api-pool.gateway')

/**
 * Re-import this module and swap the live route handler.
 * Returns { ok, reason } — never throws, because the caller is an HTTP route.
 */
async function reloadPlugin() {
  try {
    const selfUrl = import.meta.url
    const next = await import(selfUrl + '?reload=' + Date.now())
    if (next === null || typeof next.apply !== 'function') return { ok: false, reason: '模块没有导出 apply' }

    // Hand the bound server to the new module so it does not try to listen again.
    const shared = globalThis[RELOAD_STATE_KEY]
    if (shared !== undefined && shared.server !== null) {
      next.__adoptGateway === undefined ? null : next.__adoptGateway(shared)
    }

    // Replace the host's route handler in place: same registration, new closure.
    if (liveHostContext !== null) {
      next.apply(liveHostContext, { credentialsFile: config.credentialsFile })
    }
    reloadCount += 1
    return { ok: true, reason: '' }
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 120) }
  }
}

// ── 独立网关（固定端口）─────────────────────────────────────────────────────
//
// The pool's OpenAI-compatible surface used to live on the harness port, which changes on
// every launch. With several DSH instances running, the provider in the profile then points
// at whichever process happened to write the config last — so a selection made in the
// instance you are looking at lands on a different one and silently does nothing.
//
// A dedicated listener on a fixed loopback port removes the whole class of problem: the
// provider URL never changes, and every instance serves the same gateway.
//
// Concurrency: two instances will race for the port. The loser keeps running without its own
// listener — the winner already serves both, and the gateway is stateless per request — so a
// second failure is only logged, never fatal.

// The single heading every pool model appears under in DSH's model menu.
const POOL_DISPLAY_NAME = '白嫖池'
// The one provider that carries the whole pool into DSH's own model selector.
const AUTO_PROVIDER = 'dfp-auto'

const GATEWAY_PORT = 47113
const GATEWAY_HOST = '127.0.0.1'
let gatewayServer = null
let gatewayConflict = false
let gatewayState = 'starting'

/** Gateway URL the provider entry should use. */
function gatewayBaseUrl() {
  return 'http://' + GATEWAY_HOST + ':' + GATEWAY_PORT + '/dsh-free-pool/v1'
}

/**
 * Take over a gateway server that a previous module instance already bound.
 * Without this a reload would hit EADDRINUSE on its own port.
 */
export function __adoptGateway(shared) {
  if (shared === null || shared === undefined) return
  gatewayServer = shared.server
  gatewayState = 'listening'
  globalThis[RELOAD_STATE_KEY] = shared
}

/** Start the dedicated listener once per process; harmless when another instance owns it. */
function startGatewayServer() {
  return new Promise((resolve) => {
    // A previous instance (or a reload) already owns the port: reuse its server.
    const shared = globalThis[RELOAD_STATE_KEY]
    if (shared !== undefined && shared.server !== null) {
      gatewayServer = shared.server
      gatewayState = 'listening'
      resolve('adopted')
      return
    }
    const server = createServer((req, res) => {
      handleRoute(req, res).catch(() => {
        try { res.destroy() } catch (error) { /* already gone */ }
      })
    })
      .once('error', (error) => {
        if (error !== null && error !== undefined && error.code === 'EADDRINUSE') {
          // Another DSH instance owns the port and serves the same routes. That is fine for
          // requests, but it means several instances are running and the panel should say so.
          gatewayConflict = true
          gatewayState = 'shared'
          resolve('shared')
          return
        }
        gatewayState = 'error'
        resolve('error')
      })
      .once('listening', () => {
        gatewayServer = server
        gatewayState = 'listening'
        // Publish so a hot reload can adopt this exact server.
        globalThis[RELOAD_STATE_KEY] = { server, port: GATEWAY_PORT }
        resolve('listening')
      })
      .listen(GATEWAY_PORT, GATEWAY_HOST)
  })
}

/** Stop the listener this process owns, if any. */
function stopGatewayServer() {
  if (gatewayServer === null) return
  try { gatewayServer.close() } catch (error) { /* already closed */ }
  gatewayServer = null
}

export function apply(ctx, rowConfig = {}) {
  if (typeof rowConfig?.credentialsFile === 'string' && rowConfig.credentialsFile !== '') {
    config = { ...config, credentialsFile: rowConfig.credentialsFile }
  }
  ctx.inject(['webServer'], (hostCtx) => {
    liveHostContext = ctx
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-free-pool',
      handler: handleRoute,
    })
    hostCtx.effect(() => dispose, 'dsh-free-api-pool: http routes')

    // The gateway now owns a fixed port, so the provider URL is a constant rather than
    // something that has to be rewritten to match whichever instance started last.
    // The gateway owns a fixed port; point dfp-auto at it. An older profile may still pin a
    // per-instance harness port, which is why this runs on every boot.
    startGatewayServer()
      .then((state) => {
        try {
          writeGatewayPort(gatewayBaseUrl(), state)
          gatewayProfileCheck = checkGatewayProfile(gatewayBaseUrl(), state)
        } catch (error) {
          gatewayProfileCheck = null
        }
      })
      .catch(() => { gatewayProfileCheck = null })
    hostCtx.effect(() => () => stopGatewayServer(), 'dsh-free-api-pool: gateway listener')

    // A key stored by an older version has no provider yet; register those once at startup so
    // the pool never shows a model DSH would refuse. Runs in the background: it costs one
    // model listing per unregistered vendor.
    // A key stored before this feature existed (or a vendor that failed last time) has no
    // provider. Register those once at boot so the pool never shows a model DSH refuses.
    const startupTimer = setTimeout(() => {
      registerAllProviders().catch(() => { /* best effort; the panel reports failures */ })
    }, 3000)
    hostCtx.effect(() => () => clearTimeout(startupTimer), 'dsh-free-api-pool: register on boot')
  })
}
