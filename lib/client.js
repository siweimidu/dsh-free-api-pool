/**
 * dsh-free-api-pool — browser half (plain JS, no build step).
 *
 * A「免费 API 池」button at `conversation.input.left` opens a dashboard in
 * `conversation.input.overlay` with four views:
 *
 *  - 概览   one card per provider. Collapsed it shows the SUM across the accounts you
 *           added; expanded it lists each account's own quota, so one dead key cannot hide
 *           the others' headroom. Adding another key to an existing provider happens right
 *           here.
 *  - 免费模型 OpenRouter `:free` and OpenCode `-free` models, re-probed on demand.
 *  - 密钥   add a key (base URL + label + key → model IDs fetched automatically), remove,
 *           import a FreeLLMAPI export, export back in the same shape.
 *  - 平台   every vendor with its free-tier kind and a button that opens the apply page.
 *
 * Design language: Doubao dashboard tokens — #0065fd primary, 19.2px radius, 3.84px
 * spacing unit, border-led separation with no drop shadows, tabular numerals, MiSans.
 *
 * Contrast: the panel reads the harness theme tokens for its surface, so it can be dark.
 * Hard-coding "#0065fd text on a 10% blue fill" is what made the selected tab unreadable in
 * dark mode, so the panel measures its own background luminance and switches to a lightened
 * accent palette when the surface is dark. That is a measurement, not a guess about which
 * theme is on.
 *
 * Secrets never reach this half: the host reports a masked form, and only the explicit
 * export route returns raw keys.
 */
window.__ModuleLoader__.load({
  id: 'dsh-free-api-pool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const NS = 'dsh-free-api-pool'

    /**
     * The host's own model-selection service, captured from the plugin context.
     *
     * `ctx.modelDirectories.directoryFor(sessionId).select({ provider, model })` is the
     * exact call the host's model menu makes, so a pick here changes the session for real
     * instead of only being remembered locally. It is the shared per-session directory, so
     * the host's own button re-renders to match — the two entries cannot disagree.
     */
    let modelDirectories = null

    // Last successful pool listing, kept across opens so the menu paints with content on the
    // first click instead of an empty body while the stream warms up.
    let poolMemo = null

    function selectHostModel(sessionId, provider, model) {
      if (modelDirectories === null || typeof modelDirectories.directoryFor !== 'function') {
        return Promise.resolve({ ok: false, error: '宿主未提供模型选择服务' })
      }
      let directory
      try {
        directory = modelDirectories.directoryFor(sessionId)
      } catch (err) {
        return Promise.resolve({ ok: false, error: (err && err.message) || String(err) })
      }
      if (directory === undefined || typeof directory.select !== 'function') {
        return Promise.resolve({ ok: false, error: '会话模型目录不可用' })
      }
      return Promise.resolve(directory.select({ provider, model }))
        .then((res) => (res && res.ok === true ? { ok: true } : {
          ok: false,
          error: res && res.error ? (res.error.message || res.error.code || String(res.error)) : '切换被拒绝',
        }))
        .catch((err) => ({ ok: false, error: (err && err.message) || String(err) }))
    }

    // Rendering 155 cards at once is what made the panel feel like it never loaded.
    const PAGE = 24

    // Auto ids are served by the plugin's own OpenAI-compatible provider (see README).
    const AUTO_PROVIDER = 'dfp-auto'

    // Auto profiles shown at the top of the picker (and served by the gateway provider).
    const AUTOS = [
      { id: 'auto', name: 'Auto', note: '自动挑一个当前可用的模型' },
      { id: 'auto-fast', name: 'Auto-Fast', note: '最快：优先低延迟大厂' },
      { id: 'auto-cheap', name: 'Auto-Cheap', note: '最省：优先免费与余额' },
      { id: 'auto-code', name: 'Auto-Code', note: '写代码：偏代码模型' },
      { id: 'auto-write', name: 'Auto-Write', note: '写文章：偏长上下文' },
      { id: 'auto-latency', name: 'Auto-Latency', note: '实测最快：按真实首字延迟排序' },
      { id: 'auto-cost', name: 'Auto-Cost', note: '单价最低：按每百万 token 排序' },
    ]

    // Default catalogue order. The user can move vendors up and down; the order is kept in
    // localStorage so it survives a reload. Imported relays always sort after these.
    const DEFAULT_ORDER = ['openrouter', 'google', 'groq', 'mistral', 'cerebras', 'nvidia', 'huggingface', 'zhipu', 'github', 'cohere', 'siliconflow', 'moonshot', 'cloudflare', 'modelscope', 'together', 'sambanova', 'nebius', 'amd', 'stepfun', 'longcat', 'sensenova', 'dashscope', 'agnes']
    const ORDER_KEY = 'dfp.pool.order'

    function loadOrder() {
      try {
        const raw = window.localStorage.getItem(ORDER_KEY)
        if (raw === null) return DEFAULT_ORDER.slice()
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ORDER.slice()
      } catch (err) {
        return DEFAULT_ORDER.slice()
      }
    }

    function saveOrder(order) {
      try { window.localStorage.setItem(ORDER_KEY, JSON.stringify(order)) } catch (err) { /* private mode */ }
    }

    const R = {
      providers: '/dsh-free-pool/providers',
      quota: '/dsh-free-pool/quota',
      probe: '/dsh-free-pool/quota/probe',
      freeModels: '/dsh-free-pool/free-models',
      models: '/dsh-free-pool/models',
      add: '/dsh-free-pool/vault/add',
      remove: '/dsh-free-pool/vault/remove',
      exportVault: '/dsh-free-pool/vault/export',
      importVault: '/dsh-free-pool/vault/import',
      speedTest: '/dsh-free-pool/speed-test',
      registerAll: '/dsh-free-pool/register-all',
      usage: '/dsh-free-pool/usage',
      usageLog: '/dsh-free-pool/usage/log',
      route: '/dsh-free-pool/v1/route',
      pool: '/dsh-free-pool/pool-models',
      checkin: '/dsh-free-pool/checkin',
      checkinAll: '/dsh-free-pool/checkin-all',
    }

    // A route that answers 404 means the host half in this process predates the call: the
    // client hot-reloads, the host does not. Say so instead of showing a bare "not found".
    const NEEDS_RESTART = 'DSH 主机端还是旧版本，请完全退出并重新打开 DeepSeekHarness 后重试'

    async function api(path, payload) {
      const init = payload === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      let res
      try {
        res = await fetch(path, init)
      } catch (err) {
        throw new Error('无法连接到 DSH 主机：' + (err && err.message ? err.message : String(err)))
      }
      let data = null
      try {
        data = await res.json()
      } catch (err) {
        data = null
      }
      if (res.status === 404) throw new Error(NEEDS_RESTART)
      if (data === null) throw new Error('请求失败（HTTP ' + res.status + '）')
      if (data.error) throw new Error(data.error)
      return data
    }

    // ── open/close store shared by button and panel ────────────────────────

    const listeners = new Set()
    let openState = false
    const subscribe = (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
    function setOpen(open) {
      openState = open
      listeners.forEach((fn) => fn())
    }
    function useOpen() {
      return React.useSyncExternalStore(subscribe, () => openState, () => false)
    }

    // ── surface luminance → palette ────────────────────────────────────────

    // ── icons (lucide geometry, stroke 2, round caps) ──────────────────────

    function Icon(props) {
      return React.createElement('svg', {
        className: props.className,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, props.children)
    }

    const GiftIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('rect', { x: 3, y: 8, width: 18, height: 4, rx: 1 }),
      React.createElement('path', { d: 'M12 8v13' }),
      React.createElement('path', { d: 'M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7' }),
      React.createElement('path', { d: 'M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5' }))

    const RefreshIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
      React.createElement('path', { d: 'M21 3v5h-5' }),
      React.createElement('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
      React.createElement('path', { d: 'M8 16H3v5' }))

    const CloseIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M18 6 6 18' }),
      React.createElement('path', { d: 'm6 6 12 12' }))

    const AlertIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('circle', { cx: 12, cy: 12, r: 10 }),
      React.createElement('path', { d: 'M12 8v4' }),
      React.createElement('path', { d: 'M12 16h.01' }))

    const KeyIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('circle', { cx: 7.5, cy: 15.5, r: 4.5 }),
      React.createElement('path', { d: 'm10.7 12.3 8.3-8.3' }),
      React.createElement('path', { d: 'm16 6 2 2' }),
      React.createElement('path', { d: 'm13 9 2 2' }))

    const SparkIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M12 3v4' }),
      React.createElement('path', { d: 'M12 17v4' }),
      React.createElement('path', { d: 'M3 12h4' }),
      React.createElement('path', { d: 'M17 12h4' }),
      React.createElement('path', { d: 'm5.6 5.6 2.8 2.8' }),
      React.createElement('path', { d: 'm15.6 15.6 2.8 2.8' }),
      React.createElement('path', { d: 'm18.4 5.6-2.8 2.8' }),
      React.createElement('path', { d: 'm8.4 15.6-2.8 2.8' }))

    const GridIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
      React.createElement('rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }))

    const ExternalIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M15 3h6v6' }),
      React.createElement('path', { d: 'M10 14 21 3' }),
      React.createElement('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }))

    const DownloadIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M12 3v12' }),
      React.createElement('path', { d: 'm7 10 5 5 5-5' }),
      React.createElement('path', { d: 'M21 21H3' }))

    const UploadIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M12 21V9' }),
      React.createElement('path', { d: 'm7 14 5-5 5 5' }),
      React.createElement('path', { d: 'M21 3H3' }))

    const PlusIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M12 5v14' }),
      React.createElement('path', { d: 'M5 12h14' }))

    const TrashIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M3 6h18' }),
      React.createElement('path', { d: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2' }),
      React.createElement('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }))

    const CheckIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M20 6 9 17l-5-5' }))

    const ListIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M8 6h13' }),
      React.createElement('path', { d: 'M8 12h13' }),
      React.createElement('path', { d: 'M8 18h13' }),
      React.createElement('path', { d: 'M3 6h.01' }),
      React.createElement('path', { d: 'M3 12h.01' }),
      React.createElement('path', { d: 'M3 18h.01' }))

    const GaugeIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M12 14 8 8' }),
      React.createElement('circle', { cx: 12, cy: 14, r: 8 }),
      React.createElement('path', { d: 'M12 2v2' }),
      React.createElement('path', { d: 'M4.2 5.2l1.4 1.4' }),
      React.createElement('path', { d: 'M19.8 5.2l-1.4 1.4' }))

    const ChevronIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: p.open ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6' }))

    // ── formatting ─────────────────────────────────────────────────────────

    function money(value, currency) {
      if (value === null || value === undefined) return '—'
      if (currency === 'CNY') return '¥' + Number(value).toFixed(2)
      if (currency === 'requests') return Number(value).toLocaleString('zh-CN') + ' 次'
      if (currency === 'models') return Number(value).toLocaleString('zh-CN') + ' 个'
      if (currency === 'tokens') return Number(value).toLocaleString('zh-CN') + ' token'
      if (currency === 'USD') return '$' + Number(value).toFixed(4)
      return String(value)
    }

    function hostOf(url) {
      const raw = String(url || '')
      if (raw === '') return '控制台'
      try {
        return new URL(raw).host
      } catch (err) {
        return raw
      }
    }

    const STATE_LABEL = {
      ok: '已测额度',
      untested: '未探测',
      console: '需控制台',
      nokey: '待添加 Key',
      error: '异常',
    }

    const NATURE_LABEL = {
      balance: '余额',
      'daily-quota': '每日额度',
      'usage-only': '仅用量',
      'rate-limit': '速率额度',
      console: '仅控制台',
      none: '',
    }

    const FREE_KIND_LABEL = {
      'long-term': '长期免费',
      daily: '每日刷新',
      trial: '新用户赠额',
      unknown: '以站内为准',
    }

    const FREE_KIND_CLASS = {
      'long-term': 'dfp-free-long',
      daily: 'dfp-free-daily',
      trial: 'dfp-free-trial',
      unknown: 'dfp-free-unknown',
    }

    // Tier order the user asked for: 长期免费 → 每日刷新 → 新用户赠额 → 其他,
    // then alphabetical by name inside each tier.
    const FREE_KIND_RANK = { 'long-term': 0, daily: 1, trial: 2, unknown: 3 }

    function tierRank(kind) {
      const r = FREE_KIND_RANK[kind]
      return r === undefined ? 3 : r
    }

    /** Sort platforms by tier first, then by display name (locale-aware, so 中文 sorts sanely). */
    function sortByTier(list) {
      return list.slice().sort((a, b) => {
        const byTier = tierRank(a.freeKind) - tierRank(b.freeKind)
        if (byTier !== 0) return byTier
        // Alphabetical by name (case-insensitive), falling back to the slug so the
        // order is stable when two names differ only by case or punctuation.
        const an = String(a.name).toLowerCase()
        const bn = String(b.name).toLowerCase()
        if (an < bn) return -1
        if (an > bn) return 1
        return String(a.slug) < String(b.slug) ? -1 : 1
      })
    }

    const GRADE_LABEL = {
      excellent: '极快',
      good: '良好',
      fair: '一般',
      slow: '偏慢',
      unknown: '未知',
    }

    /**
     * Open an external page.
     *
     * `window.open` alone is unreliable inside the desktop shell: the renderer often blocks
     * it silently, which is why "申请" and "文档" appeared dead. A real anchor click with
     * target=_blank goes through the host's link handling instead, and window.open is kept
     * only as a fallback for the browser build.
     */
    function openApply(url) {
      const href = String(url || '').trim()
      if (href === '') return
      const absolute = /^https?:\/\//i.test(href) ? href : 'https://' + href
      const a = document.createElement('a')
      a.href = absolute
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.style.display = 'none'
      document.body.appendChild(a)
      let opened = false
      try {
        a.click()
        opened = true
      } catch (err) {
        opened = false
      }
      document.body.removeChild(a)
      if (!opened) {
        try { window.open(absolute, '_blank', 'noopener,noreferrer') } catch (err) { /* last resort */ }
      }
    }

    function FreeChip(props) {
      const kind = props.kind || 'unknown'
      return React.createElement('span', { className: 'dfp-free ' + (FREE_KIND_CLASS[kind] || FREE_KIND_CLASS.unknown) },
        FREE_KIND_LABEL[kind] || FREE_KIND_LABEL.unknown)
    }

    function download(filename, text) {
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }

    // ── speed result ───────────────────────────────────────────────────────

    function SpeedResult(props) {
      const r = props.result
      if (!r) return null
      if (r.ok !== true) {
        return React.createElement('div', { className: 'dfp-speed dfp-speed-bad' },
          React.createElement(AlertIcon, { className: 'dfp-speed-icon' }),
          React.createElement('span', { className: 'dfp-speed-error' },
            '测速失败' + (r.status ? '（HTTP ' + r.status + '）' : '') + '：' + r.error))
      }
      const cells = [
        { k: '首字延迟', v: r.ttftMs === null ? '—' : r.ttftMs + ' ms' },
        { k: '输出速度', v: r.tps === null ? '—' : r.tps + ' tok/s' },
        { k: '总耗时', v: r.totalMs + ' ms' },
        { k: '输出 token', v: String(r.tokens) + (r.tokensSource === 'deltas' ? '（估）' : '') },
      ]
      return React.createElement('div', { className: 'dfp-speed' },
        React.createElement('div', { className: 'dfp-speed-head' },
          React.createElement(GaugeIcon, { className: 'dfp-speed-icon' }),
          React.createElement('span', { className: 'dfp-speed-model dfp-mono' }, r.model),
          React.createElement('span', { className: 'dfp-grade dfp-grade-' + r.grade },
            GRADE_LABEL[r.grade] || r.grade)),
        React.createElement('div', { className: 'dfp-speed-grid' },
          cells.map((c) => React.createElement('div', { className: 'dfp-speed-cell', key: c.k },
            React.createElement('span', { className: 'dfp-speed-k' }, c.k),
            React.createElement('span', { className: 'dfp-speed-v' }, c.v)))))
    }

    // ── left composer button ───────────────────────────────────────────────

    function LeftButton() {
      const open = useOpen()
      const [count, setCount] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        api(R.providers).then((data) => {
          if (alive) setCount((data.providers || []).length)
        }).catch(() => {
          if (alive) setCount(null)
        })
        return () => {
          alive = false
        }
      }, [])

      return React.createElement('button', {
        type: 'button',
        className: 'dfp-trigger' + (open ? ' dfp-open' : ''),
        onClick: () => setOpen(!open),
        title: '免费 API 池',
        'aria-expanded': open,
      },
        React.createElement(GiftIcon, { className: 'dfp-trigger-icon' }),
        React.createElement('span', { className: 'dfp-trigger-label' }, '免费 API 池'),
        count !== null && count > 0
          ? React.createElement('span', { className: 'dfp-trigger-count' }, String(count))
          : null)
    }


    // ── 免费池模型选择器 ───────────────────────────────────────────────────
    //
    // The picker lives in the composer's model seat: a 免费池 button beside the model
    // button, listing every model reachable through the vault, grouped by vendor, with
    // search. Order is OpenRouter → Google → Groq → Mistral → other vendors → relays,
    // and the user can move a vendor with the arrows (persisted locally).

    function PoolModelRow(props) {
      return React.createElement('button', {
        type: 'button',
        className: 'dfp-pop-model' + (props.active ? ' dfp-pop-model-on' : ''),
        onClick: () => props.onPick(props.model),
        title: props.model,
      },
        React.createElement('span', { className: 'dfp-pop-model-id' }, props.model),
        props.note
          ? React.createElement('span', { className: 'dfp-pop-model-note' }, props.note)
          : null,
        props.busy
          ? React.createElement('span', { className: 'dfp-pop-model-busy' }, '切换中…')
          : null,
        props.active ? React.createElement(CheckIcon, { className: 'dfp-pop-check' }) : null)
    }

    function PoolGroup(props) {
      const g = props.group
      const movable = g.slug !== '__auto'
      const head = React.createElement('div', { className: 'dfp-pop-group-head' },
        React.createElement('span', { className: 'dfp-pop-group-name' }, g.name),
        React.createElement('span', { className: 'dfp-pop-count' },
          movable ? (g.models.length > 0 ? g.models.length + ' 个' : '无') : null),
        React.createElement('span', { className: 'dfp-spacer' }),
        movable
          ? React.createElement('button', {
            type: 'button', className: 'dfp-move', title: '上移这个厂商',
            'aria-label': '上移',
            onClick: () => props.onMove(g.slug, -1),
          }, '↑')
          : null,
        movable
          ? React.createElement('button', {
            type: 'button', className: 'dfp-move', title: '下移这个厂商',
            'aria-label': '下移',
            onClick: () => props.onMove(g.slug, 1),
          }, '↓')
          : null)

      const body = g.error !== null
        ? React.createElement('div', { className: 'dfp-pop-error' }, g.error)
        : React.createElement('div', { className: 'dfp-pop-models' },
          g.models.map((m) => React.createElement(PoolModelRow, {
            key: m,
            model: m,
            note: g.notes === undefined ? '' : g.notes[m],
            active: props.picked === m,
            busy: props.busyModel === m,
            onPick: props.onPick,
          })))

      return React.createElement('div', { className: 'dfp-pop-group' }, head, body)
    }

    function PoolPicker(props) {
      const sessionId = props === undefined ? undefined : props.sessionId
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [order, setOrder] = React.useState(loadOrder)
      const [picked, setPicked] = React.useState('')
      const [busyModel, setBusyModel] = React.useState('')
      const boxRef = React.useRef(null)
      // Fixed positioning needs explicit coordinates: measure the trigger, then place the
      // menu above it (or below when there is no room), clamped to the viewport.
      const [pos, setPos] = React.useState(null)

      // The host streams NDJSON: a first line with everything cached, then one line per
      // vendor as it answers. Rendering the cached line immediately is what makes the
      // picker usable without waiting for a hundred relays to time out.
      const load = React.useCallback(() => {
        // Paint whatever the previous open produced, immediately.
        if (poolMemo !== null) {
          setData(poolMemo)
          setLoading(false)
        } else {
          setLoading(true)
        }
        setError('')
        const groups = poolMemo === null ? [] : poolMemo.groups.slice()
        const push = (g) => {
          const at = groups.findIndex((x) => x.slug === g.slug)
          if (at >= 0) groups[at] = g
          else groups.push(g)
          setData({ at: Date.now(), groups: groups.slice() })
        }
        fetch(R.pool, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).then((res) => {
          if (res.status === 404) throw new Error(NEEDS_RESTART)
          if (res.body === null || res.body === undefined) {
            return res.json().then((all) => {
              for (const g of all.groups || []) push(g)
              setLoading(false)
            })
          }
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          const pump = () => reader.read().then((step) => {
            if (step.done) {
              setLoading(false)
              setData((cur) => { poolMemo = cur; return cur })
              return
            }
            buffer += decoder.decode(step.value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const raw of lines) {
              if (raw.trim() === '') continue
              let msg
              try { msg = JSON.parse(raw) } catch (err) { continue }
              if (msg.kind === 'init') {
                for (const g of msg.groups || []) push(g)
                setLoading(false)
              } else if (msg.kind === 'group' && msg.group !== undefined) {
                push(msg.group)
              }
            }
            return pump()
          })
          return pump()
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
          setLoading(false)
        })
      }, [])

      // Refresh on every open, not only the first: the memo makes that invisible (content
      // is already on screen) while keeping the list current.
      React.useEffect(() => {
        if (open) load()
      }, [open, load])

      // Anchor to the trigger with fixed coordinates, matching how the host menu places
      // itself. Recomputed on open and on resize/scroll so it never drifts.
      React.useEffect(() => {
        if (!open) return undefined
        const place = () => {
          const box = boxRef.current
          if (box === null) return
          const rect = box.getBoundingClientRect()
          const margin = 8
          const maxH = Math.min(360, window.innerHeight - 96)
          const above = rect.top - margin
          const below = window.innerHeight - rect.bottom - margin
          const height = Math.min(maxH, Math.max(above, below))
          const openUp = above >= Math.min(240, height) || above >= below
          const top = openUp ? Math.max(margin, rect.top - height - 6) : rect.bottom + 6
          // Right-align with the trigger, like the host's own menu; the width is unknown
          // before paint, so anchor from the right and let the CSS max-width clamp it.
          const right = Math.max(margin, window.innerWidth - rect.right)
          setPos({ top, right, maxHeight: height })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onDoc = (event) => {
          if (boxRef.current !== null && !boxRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDoc)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // model id -> provider slug, built from the vendor groups; Auto ids belong to the
      // plugin's own gateway provider.
      // model id -> the provider name DSH registered for it (hostProvider, e.g. "groq-free").
      // Sending the catalogue slug instead is what made switching fail.
      const providerMap = new Map()
      for (const g of (data === null ? [] : data.groups || [])) {
        const registered = g.hostProvider === undefined ? '' : g.hostProvider
        for (const m of g.models || []) {
          if (!providerMap.has(m)) providerMap.set(m, registered)
        }
      }
      for (const a of AUTOS) providerMap.set(a.id, AUTO_PROVIDER)

      const providerOf = (model) => {
        const hit = providerMap.get(model)
        return hit === undefined ? '' : hit
      }

      const groups = (data === null ? [] : data.groups || []).slice()
      const rank = (g) => {
        const at = order.indexOf(g.slug)
        if (at >= 0) return at
        return g.category === 'custom' ? 9000 : 5000
      }
      groups.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)))

      // Auto sits above every vendor: it is the picker's default answer.

      const q = query.trim().toLowerCase()
      const filtered = groups
        .map((g) => ({
          ...g,
          models: q === '' ? g.models : g.models.filter((m) => String(m).toLowerCase().includes(q)),
        }))
        .filter((g) => g.models.length > 0 || (q === '' && g.error !== null))

      const move = (slug, dir) => {
        const current = groups.map((g) => g.slug)
        const at = current.indexOf(slug)
        const to = at + dir
        if (at < 0 || to < 0 || to >= current.length) return
        const next = current.slice()
        const item = next.splice(at, 1)[0]
        next.splice(to, 0, item)
        setOrder(next)
        saveOrder(next)
      }

      /**
       * A pick is a real switch, not a local memory: the model id is handed to the host's
       * session directory, which is the same call its own menu makes. Failures are shown
       * rather than swallowed, because a silent no-op is exactly the bug being fixed.
       */
      const choose = (model) => {
        const provider = providerOf(model)
        if (provider === '') {
          // The vendor is in the pool but DSH never registered it, so no switch can succeed.
          // Say that plainly instead of leaving the menu open with a generic error.
          setError('无法切换：DSH 里没有注册这个平台（缺少 ' + model.split('/')[0] + ' 对应的 provider）')
          return
        }
        if (sessionId === undefined) {
          setError('无法切换：当前没有会话')
          return
        }
        setBusyModel(model)
        selectHostModel(sessionId, provider, model).then((res) => {
          setBusyModel('')
          if (res.ok) {
            setPicked(model)
            setError('')
            setOpen(false)
            return
          }
          setError('切换失败：' + res.error)
          // A rejected switch means this exact provider/model pair is not selectable. Close
          // the menu anyway: leaving it open looks like the click did nothing.
          setOpen(false)
        })
      }

      const trigger = React.createElement('button', {
        type: 'button',
        className: 'dfp-trigger' + (open ? ' dfp-open' : ''),
        onClick: () => setOpen(!open),
        title: '从白嫖池选择模型',
        'aria-expanded': open,
      },
        React.createElement(SparkIcon, { className: 'dfp-trigger-icon' }),
        React.createElement('span', { className: 'dfp-trigger-label' },
          picked === '' ? '白嫖池' : String(picked).split('/').pop()))

      if (!open) {
        return React.createElement('div', { className: 'dfp-pool-wrap', ref: boxRef }, trigger)
      }

      const head = React.createElement('div', { className: 'dfp-pop-head' },
        React.createElement('input', {
          className: 'dfp-input dfp-pop-search',
          value: query,
          placeholder: '搜索模型…',
          autoFocus: true,
          onChange: (e) => setQuery(e.target.value),
        }),
        React.createElement('button', {
          type: 'button',
          className: 'dfp-mini',
          title: '重新拉取模型',
          onClick: () => {
            setData(null)
            load()
          },
        }, '刷新'))

      let body
      if (loading) {
        body = React.createElement('div', { className: 'dfp-empty' }, '正在向各平台拉取模型…')
      } else if (filtered.length === 0 && loading) {
        body = React.createElement('div', { className: 'dfp-empty' }, '正在向各平台拉取模型…')
      } else if (filtered.length === 0) {
        const empty = data !== null && (data.groups || []).length === 0
          ? '白嫖池里还没有可用的 Key'
          : '没有匹配的模型'
        body = React.createElement('div', { className: 'dfp-empty' }, empty)
      } else {
        const autoShown = AUTOS.filter((a) =>
          q === '' || a.name.toLowerCase().includes(q) || a.note.includes(q) || a.id.includes(q))
        const autoGroup = autoShown.length === 0
          ? null
          : React.createElement(PoolGroup, {
            key: '__auto',
            group: {
              slug: '__auto',
              name: 'Auto（推荐）',
              models: autoShown.map((a) => a.id),
              error: null,
              notes: Object.fromEntries(autoShown.map((a) => [a.id, a.note])),
            },
            picked,
            busyModel,
            onPick: choose,
            onMove: () => {},
          })
        body = [autoGroup].concat(filtered.map((g) => React.createElement(PoolGroup, {
          key: g.slug,
          group: g,
          picked,
          busyModel,
          onPick: choose,
          onMove: move,
        })))
      }

      const pop = React.createElement('div', {
        className: 'dfp-pop',
        style: pos === null
          ? { top: 0, right: 0, visibility: 'hidden' }
          : { top: pos.top, right: pos.right, maxHeight: pos.maxHeight },
      },
        head,
        loading && filtered.length > 0
          ? React.createElement('div', { className: 'dfp-pop-loading' }, '继续拉取中…')
          : null,
        error !== '' ? React.createElement('div', { className: 'dfp-pop-error' }, error) : null,
        React.createElement('div', { className: 'dfp-pop-body' }, body))

      return React.createElement('div', { className: 'dfp-pool-wrap', ref: boxRef }, trigger, pop)
    }


    // ── shared bits ────────────────────────────────────────────────────────

    function Stat(props) {
      return React.createElement('div', { className: 'dfp-stat' },
        React.createElement('span', { className: 'dfp-stat-v' }, props.value),
        React.createElement('span', { className: 'dfp-stat-k' }, props.label))
    }

    function Field(props) {
      return React.createElement('label', { className: 'dfp-field' },
        React.createElement('span', { className: 'dfp-field-k' }, props.label),
        props.children,
        props.hint ? React.createElement('span', { className: 'dfp-field-hint' }, props.hint) : null)
    }

    function Metric(props) {
      return React.createElement('div', { className: 'dfp-metric' },
        React.createElement('span', { className: 'dfp-metric-k' }, props.label),
        React.createElement('span', { className: 'dfp-metric-v' + (props.strong ? ' dfp-strong' : '') }, props.value))
    }

    /** One account's own quota strip: the numbers behind an expanded provider card. */
    function AccountRow(props) {
      const q = props.account.quota || {}
      const windows = Array.isArray(q.windows) ? q.windows : []
      const sp = props.speed
      return React.createElement('div', { className: 'dfp-account' },
        React.createElement('div', { className: 'dfp-account-head' },
          React.createElement('span', { className: 'dfp-account-label' }, props.account.label),
          React.createElement('span', { className: 'dfp-account-mask dfp-mono' }, props.account.masked),
          React.createElement('span', { className: 'dfp-chip dfp-chip-' + (q.state || 'console') },
            STATE_LABEL[q.state] || q.state || '未知'),
          React.createElement('span', { className: 'dfp-spacer' }),
          React.createElement('button', {
            type: 'button',
            className: 'dfp-mini',
            disabled: sp !== undefined && sp.running === true,
            onClick: () => props.onSpeed(props.account),
          }, sp !== undefined && sp.running === true ? '测速中…' : '测速'),
          React.createElement('button', {
            type: 'button',
            className: 'dfp-icon-btn',
            title: '删除这个 Key',
            onClick: () => props.onRemove(props.account.id),
          }, React.createElement(TrashIcon, { className: 'dfp-close' }))),
        React.createElement('div', { className: 'dfp-metrics' },
          React.createElement(Metric, {
            label: '剩余总量', strong: true,
            value: q.totalRemaining === null || q.totalRemaining === undefined ? '—' : money(q.totalRemaining, q.currency),
          }),
          React.createElement(Metric, {
            label: '今日剩余',
            value: q.todayRemaining === null || q.todayRemaining === undefined ? '—' : money(q.todayRemaining, q.todayCurrency || q.currency),
          }),
          React.createElement(Metric, {
            label: '已用',
            value: q.used === null || q.used === undefined ? '—' : money(q.used, q.currency),
          }),
          React.createElement(Metric, {
            label: '今日已用',
            value: q.todayUsed === null || q.todayUsed === undefined ? '—' : money(q.todayUsed, q.todayCurrency || q.currency),
          })),
        windows.length > 0
          ? React.createElement('div', { className: 'dfp-windows' },
            windows.map((w, i) => React.createElement('div', { className: 'dfp-window', key: i },
              React.createElement('span', { className: 'dfp-window-k' }, w.label),
              React.createElement('span', { className: 'dfp-window-v' },
                (w.remaining === null ? '—' : Number(w.remaining).toLocaleString('zh-CN'))
                + ' / '
                + (w.limit === null ? '—' : Number(w.limit).toLocaleString('zh-CN'))),
              w.reset ? React.createElement('span', { className: 'dfp-window-reset' }, w.reset + ' 后重置') : null)))
          : null,
        q.detail ? React.createElement('div', { className: 'dfp-detail' }, q.detail) : null,
        sp !== undefined && sp.running !== true
          ? React.createElement(SpeedResult, { result: sp })
          : null)
    }

    /** A provider card: totals when collapsed, one strip per account when expanded. */
    function ProviderCard(props) {
      const p = props.provider
      const q = p.quota || {}
      const accounts = Array.isArray(p.accounts) ? p.accounts : []
      const open = props.expanded === true
      const multi = p.keyCount > 1
      return React.createElement('div', { className: 'dfp-row' + (open ? ' dfp-row-open' : '') },
        React.createElement('div', { className: 'dfp-row-head' },
          multi
            ? React.createElement('button', {
              type: 'button',
              className: 'dfp-expand',
              onClick: () => props.onToggle(p.slug),
              title: open ? '收起，只看总额度' : '展开，查看每个账号的额度',
              'aria-expanded': open,
            }, React.createElement(ChevronIcon, { className: 'dfp-expand-icon', open }))
            : null,
          React.createElement('span', { className: 'dfp-name' }, p.name),
          React.createElement('span', { className: 'dfp-vendor' }, p.vendor),
          React.createElement('span', { className: 'dfp-chip dfp-chip-' + (q.state || 'console') },
            STATE_LABEL[q.state] || q.state || '未知'),
          NATURE_LABEL[q.nature]
            ? React.createElement('span', { className: 'dfp-nature' }, NATURE_LABEL[q.nature])
            : null,
          React.createElement(FreeChip, { kind: p.freeKind }),
          p.keyCount > 0
            ? React.createElement('span', { className: 'dfp-chip dfp-keys' },
              p.keyCount + ' 个 Key' + (multi && !open ? ' · 合计' : ''))
            : null,
          React.createElement('span', { className: 'dfp-spacer' }),
          // Always present: a card without a key still answers something useful
          // ("未添加 Key" / "需控制台"), and having the button everywhere removes the
          // impression that only some platforms can be probed.
          React.createElement('button', {
            type: 'button',
            className: 'dfp-mini',
            disabled: props.probing === p.slug,
            onClick: () => props.onProbe(p.slug),
            title: p.keyCount > 0 ? '现在查询这张卡的真实额度' : '这张卡还没有 Key，探测只会返回提示',
          }, props.probing === p.slug
            ? '探测中…'
            : (q.state === 'untested' || q.state === 'nokey' ? '探测' : '重测')),
          p.checkin
            ? React.createElement('button', {
              type: 'button',
              className: 'dfp-mini',
              disabled: props.busy === p.slug,
              onClick: () => props.onCheckin(p),
            }, props.busy === p.slug ? '签到中…' : '签到')
            : null,
          p.applyUrl
            ? React.createElement('button', {
              type: 'button',
              className: 'dfp-mini',
              onClick: () => openApply(p.applyUrl),
              title: '打开申请页：' + p.applyUrl,
            }, '申请 Key')
            : null,
          React.createElement('button', {
            type: 'button',
            className: 'dfp-mini dfp-mini-primary',
            onClick: () => props.onAdd(p),
          }, '添加 Key')),

        React.createElement('div', { className: 'dfp-meta' },
          React.createElement('span', { className: 'dfp-host' }, hostOf(p.baseUrl)),
          React.createElement('span', { className: 'dfp-sep' }, '·'),
          React.createElement('span', null, p.freeNote || '免费额度'),
          typeof q.models === 'number' && q.models > 0
            ? React.createElement(React.Fragment, null,
              React.createElement('span', { className: 'dfp-sep' }, '·'),
              React.createElement('span', null, q.models + ' 个模型'))
            : null),

        React.createElement('div', { className: 'dfp-metrics' },
          React.createElement(Metric, {
            label: multi ? '剩余总量（合计）' : '剩余总量',
            strong: true,
            value: q.totalRemaining === null || q.totalRemaining === undefined ? '—' : money(q.totalRemaining, q.currency),
          }),
          React.createElement(Metric, {
            label: multi ? '今日剩余（合计）' : '今日剩余',
            value: q.todayRemaining === null || q.todayRemaining === undefined ? '—' : money(q.todayRemaining, q.todayCurrency || q.currency),
          }),
          React.createElement(Metric, {
            label: multi ? '已用（合计）' : '已用',
            value: q.used === null || q.used === undefined ? '—' : money(q.used, q.currency),
          }),
          React.createElement(Metric, {
            label: multi ? '今日已用（合计）' : '今日已用',
            value: q.todayUsed === null || q.todayUsed === undefined ? '—' : money(q.todayUsed, q.todayCurrency || q.currency),
          })),

        q.detail ? React.createElement('div', { className: 'dfp-detail' }, q.detail) : null,
        props.note ? React.createElement('div', { className: 'dfp-note' }, props.note) : null,

        open && accounts.length > 0
          ? React.createElement('div', { className: 'dfp-accounts' },
            accounts.map((a) => React.createElement(AccountRow, {
              key: a.id,
              account: a,
              speed: props.speeds[a.id],
              onSpeed: props.onSpeed,
              onRemove: props.onRemove,
            })))
          : null)
    }

    // ── 概览 ───────────────────────────────────────────────────────────────

    function Overview(props) {
      const { providers, loading, busy, probing, onCheckin, onAdd, notes, error, expanded, onToggle, speeds, onSpeed, onRemove, onProbe } = props
      const [filter, setFilter] = React.useState('all')
      const measured = providers.filter((p) => (p.quota || {}).state === 'ok').length
      const ready = providers.filter((p) => p.keyCount > 0).length
      const checkinable = providers.filter((p) => p.checkin).length
      const totalKeys = providers.reduce((n, p) => n + (p.keyCount || 0), 0)

      const [query, setQuery] = React.useState('')
      const [limit, setLimit] = React.useState(PAGE)

      const shown = providers.filter((p) => {
        const st = (p.quota || {}).state
        if (filter === 'ok') return st === 'ok'
        if (filter === 'keyed') return p.keyCount > 0
        if (filter === 'issue') return st === 'error' || st === 'nokey'
        return true
      }).filter((p) => {
        const q = query.trim().toLowerCase()
        if (q === '') return true
        return [p.name, p.vendor, p.baseUrl, ...(p.keyLabels || [])]
          .some((v) => String(v || '').toLowerCase().includes(q))
      })

      const visible = shown.slice(0, limit)

      const FILTERS = [
        { id: 'all', label: '全部' },
        { id: 'ok', label: '已测额度' },
        { id: 'keyed', label: '已配置' },
        { id: 'issue', label: '待处理' },
      ]

      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-summary' },
          React.createElement(Stat, { label: '平台', value: String(providers.length) }),
          React.createElement(Stat, { label: 'Key 总数', value: String(totalKeys) }),
          React.createElement(Stat, { label: '已测到额度', value: String(measured) }),
          React.createElement(Stat, { label: '可签到', value: String(checkinable) })),

        React.createElement('div', { className: 'dfp-filters' },
          FILTERS.map((f) => React.createElement('button', {
            key: f.id,
            type: 'button',
            className: 'dfp-filter' + (filter === f.id ? ' dfp-filter-on' : ''),
            onClick: () => { setFilter(f.id); setLimit(PAGE) },
          }, f.label)),
          React.createElement('input', {
            className: 'dfp-input dfp-search',
            value: query,
            placeholder: '搜索平台 / 备注 / 域名',
            onChange: (e) => { setQuery(e.target.value); setLimit(PAGE) },
          }),
          React.createElement('span', { className: 'dfp-spacer' }),
          React.createElement('span', { className: 'dfp-hint' },
            ready + ' 个平台已配置 · 共 ' + shown.length + ' 个匹配')),

        error
          ? React.createElement('div', { className: 'dfp-alert' },
            React.createElement(AlertIcon, { className: 'dfp-alert-icon' }),
            React.createElement('span', null, error))
          : null,

        React.createElement('div', { className: 'dfp-list' },
          shown.length === 0
            ? React.createElement('div', { className: 'dfp-empty' },
              loading ? '正在查询各平台额度…' : '这里没有符合条件的平台')
            : visible.map((p) => React.createElement(ProviderCard, {
              key: p.slug,
              provider: p,
              busy,
              note: notes[p.slug],
              expanded: expanded[p.slug] === true,
              probing,
              onProbe,
              onToggle,
              onCheckin,
              onAdd,
              speeds,
              onSpeed,
              onRemove,
            })),
          shown.length > visible.length
            ? React.createElement('button', {
              type: 'button',
              className: 'dfp-more',
              onClick: () => setLimit(limit + PAGE),
            }, '再显示 ' + Math.min(PAGE, shown.length - visible.length) + ' 个（共 ' + shown.length + ' 个）')
            : null))
    }

    // ── 免费模型 ───────────────────────────────────────────────────────────

    function FreeModels(props) {
      const { data, loading, onRefresh } = props
      const groups = [
        { key: 'openrouter', title: 'OpenRouter', note: '定价为 0 的模型（:free 后缀）', url: 'https://openrouter.ai/models?max_price=0' },
        { key: 'opencode', title: 'OpenCode Zen', note: '带 -free 后缀的模型', url: 'https://opencode.ai/auth' },
      ]
      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-fm-head' },
          React.createElement('span', { className: 'dfp-hint' },
            loading ? '正在探测各平台免费模型…' : '每日自动探测，可随时手动刷新'),
          React.createElement('span', { className: 'dfp-spacer' }),
          React.createElement('button', {
            type: 'button',
            className: 'dfp-btn',
            onClick: onRefresh,
            disabled: loading,
          },
            React.createElement(RefreshIcon, { className: 'dfp-btn-icon' }),
            loading ? '探测中…' : '重新探测')),

        React.createElement('div', { className: 'dfp-list' },
          groups.map((g) => {
            const section = data ? data[g.key] : null
            const models = section && Array.isArray(section.models) ? section.models : []
            return React.createElement('div', { className: 'dfp-fm-group', key: g.key },
              React.createElement('div', { className: 'dfp-fm-group-head' },
                React.createElement('span', { className: 'dfp-fm-group-name' }, g.title),
                React.createElement('span', { className: 'dfp-vendor' }, g.note),
                React.createElement('span', { className: 'dfp-chip dfp-keys' }, models.length + ' 个免费'),
                React.createElement('span', { className: 'dfp-spacer' }),
                React.createElement('button', {
                  type: 'button',
                  className: 'dfp-mini',
                  onClick: () => openApply(g.url),
                }, '打开站点')),
              section && section.ok === false
                ? React.createElement('div', { className: 'dfp-detail' }, section.error || '探测失败')
                : null,
              models.length === 0
                ? React.createElement('div', { className: 'dfp-empty' }, loading ? '探测中…' : '暂无免费模型')
                : React.createElement('div', { className: 'dfp-model-grid' },
                  models.map((m) => React.createElement('div', { className: 'dfp-model', key: m.id, title: m.note || '' },
                    React.createElement('span', { className: 'dfp-model-id' }, m.id),
                    React.createElement('span', { className: 'dfp-model-meta' },
                      React.createElement(FreeChip, { kind: m.freeKind }),
                      m.context
                        ? React.createElement('span', { className: 'dfp-model-ctx' }, Math.round(m.context / 1000) + 'K')
                        : null)))))
          })))
    }

    // ── 密钥 ───────────────────────────────────────────────────────────────

    function Vault(props) {
      const { providers, onChanged, focusSlug } = props
      const [slug, setSlug] = React.useState('')
      const [label, setLabel] = React.useState('')
      const [baseUrl, setBaseUrl] = React.useState('')
      const [key, setKey] = React.useState('')
      const [models, setModels] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [ok, setOk] = React.useState('')
      const [speeds, setSpeeds] = React.useState({})
      const fileRef = React.useRef(null)

      const selected = providers.find((p) => p.slug === slug)

      // A「添加 Key」click in 概览 lands here with that provider preselected.
      React.useEffect(() => {
        if (!focusSlug) return
        const hit = providers.find((p) => p.slug === focusSlug)
        if (hit === undefined) return
        setSlug(hit.slug)
        setLabel('')
        setBaseUrl(hit.baseUrl || '')
        setModels(null)
      }, [focusSlug])

      const reset = () => {
        setSlug('')
        setLabel('')
        setBaseUrl('')
        setKey('')
        setModels(null)
      }

      const discover = () => {
        setError('')
        setOk('')
        setBusy('discover')
        api(R.models, { slug, baseUrl, key }).then((res) => {
          setModels(res)
          setBusy('')
          setOk('已从该平台读取到 ' + res.count + ' 个模型 ID')
        }).catch((err) => {
          setModels(null)
          setBusy('')
          setError(err && err.message ? err.message : String(err))
        })
      }

      const save = () => {
        setError('')
        setOk('')
        setBusy('save')
        api(R.add, { slug, label, baseUrl, key }).then((res) => {
          // Registration is part of the add: report whether the model actually became usable.
          const reg = res === null || res.registered === undefined ? null : res.registered
          const note = reg === null
            ? '已保存'
            : reg.ok === true
              ? '已保存并注册到 DSH（' + reg.models + ' 个模型可直接切换）'
              : '已保存，但未能注册：' + reg.reason
          setOk(note)
          reset()
          setBusy('')
          onChanged()
        }).catch((err) => {
          setBusy('')
          setError(err && err.message ? err.message : String(err))
        })
      }

      const remove = (id) => {
        setError('')
        setOk('')
        api(R.remove, { id }).then(() => {
          setOk('已删除')
          onChanged()
        }).catch((err) => setError(err && err.message ? err.message : String(err)))
      }

      const speed = (entry) => {
        setSpeeds((prev) => ({ ...prev, [entry.id]: { running: true } }))
        api(R.speedTest, { entryId: entry.id }).then((res) => {
          setSpeeds((prev) => ({ ...prev, [entry.id]: res }))
        }).catch((err) => {
          setSpeeds((prev) => ({
            ...prev,
            [entry.id]: { ok: false, error: err && err.message ? err.message : String(err) },
          }))
        })
      }

      const exportAll = () => {
        setError('')
        setOk('')
        api(R.exportVault, {}).then((data) => {
          download('freellmapi-keys-' + new Date().toISOString().slice(0, 10) + '.json',
            JSON.stringify(data, null, 2))
          setOk('已导出 ' + data.keys.length + ' 条（FreeLLMAPI 格式，含 baseURL / 名称 / 密钥）')
        }).catch((err) => setError(err && err.message ? err.message : String(err)))
      }

      const importFile = (event) => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        setError('')
        setOk('')
        setBusy('import')
        const reader = new FileReader()
        reader.onload = () => {
          let parsed
          try {
            parsed = JSON.parse(String(reader.result))
          } catch (err) {
            setBusy('')
            setError('JSON 解析失败：' + (err && err.message ? err.message : String(err)))
            return
          }
          api(R.importVault, { data: parsed }).then((res) => {
            setBusy('')
            setOk('导入完成：新增 ' + res.added + ' 条'
              + (res.registered === undefined ? '' : '，已注册 ' + res.registered + ' 个平台')
              + (res.skipped > 0 ? '，跳过重复 ' + res.skipped + ' 条' : '')
              + (res.errors && res.errors.length > 0 ? '，' + res.errors.length + ' 条有问题' : ''))
            if (res.errors && res.errors.length > 0) setError(res.errors.join('；'))
            onChanged()
          }).catch((err) => {
            setBusy('')
            setError(err && err.message ? err.message : String(err))
          })
        }
        reader.readAsText(file)
        event.target.value = ''
      }

      const withKeys = sortByTier(providers.filter((p) => p.keyCount > 0))
      const totalKeys = providers.reduce((n, p) => n + (p.keyCount || 0), 0)
      const options = providers.filter((p) => p.category !== 'custom')

      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-card' },
          React.createElement('div', { className: 'dfp-card-title' },
            React.createElement(PlusIcon, { className: 'dfp-card-icon' }),
            '添加密钥',
            React.createElement('span', { className: 'dfp-spacer' }),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn',
              onClick: () => fileRef.current && fileRef.current.click(),
              disabled: busy === 'import',
            },
              React.createElement(UploadIcon, { className: 'dfp-btn-icon' }),
              busy === 'import' ? '导入中…' : '导入 FreeLLMAPI'),
            React.createElement('input', {
              ref: fileRef,
              type: 'file',
              accept: '.json,application/json',
              style: { display: 'none' },
              onChange: importFile,
            })),
          React.createElement('div', { className: 'dfp-card-sub' },
            '选平台 → 填 Key → 自动读取该平台的模型 ID → 保存。同一平台可以加多个 Key，概览里展开即可分别看额度。'),

          React.createElement('div', { className: 'dfp-form' },
            React.createElement(Field, { label: '平台', hint: '自定义中转站选「自定义」并填 Base URL' },
              React.createElement(PlatformPicker, {
                providers: options,
                value: slug,
                onChange: (next) => {
                  setSlug(next)
                  setModels(null)
                  const hit = providers.find((p) => p.slug === next)
                  setBaseUrl(hit && hit.category !== 'custom' ? hit.baseUrl : '')
                },
              })),
            React.createElement(Field, {
              label: '备注名',
              hint: '用于区分同一平台的多个账号，例如「主号」「小号」',
            },
              React.createElement('input', {
                className: 'dfp-input',
                value: label,
                placeholder: selected ? selected.name : '例如：Groq 主号',
                onChange: (e) => setLabel(e.target.value),
              })),
            React.createElement(Field, {
              label: 'Base URL',
              hint: selected && selected.baseUrl === baseUrl ? '已自动填入，可修改' : '填写 OpenAI 兼容地址',
            },
              React.createElement('input', {
                className: 'dfp-input dfp-mono',
                value: baseUrl,
                placeholder: 'https://api.example.com/v1',
                onChange: (e) => setBaseUrl(e.target.value),
              })),
            React.createElement(Field, {
              label: 'API Key',
              hint: selected && selected.keyHint ? '格式：' + selected.keyHint : '',
            },
              React.createElement('input', {
                className: 'dfp-input dfp-mono',
                type: 'password',
                value: key,
                placeholder: '粘贴 Key',
                onChange: (e) => setKey(e.target.value),
              }))),

          React.createElement('div', { className: 'dfp-form-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn',
              onClick: discover,
              disabled: busy !== '' || baseUrl === '' || key === '',
            },
              React.createElement(SparkIcon, { className: 'dfp-btn-icon' }),
              busy === 'discover' ? '拉取中…' : '拉取模型 ID'),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn dfp-btn-primary',
              onClick: save,
              disabled: busy !== '' || key === '' || (slug === '' && baseUrl === ''),
            }, busy === 'save' ? '保存中…' : '保存密钥'),
            selected && selected.applyUrl
              ? React.createElement('button', {
                type: 'button',
                className: 'dfp-btn',
                onClick: () => openApply(selected.applyUrl),
              },
                React.createElement(ExternalIcon, { className: 'dfp-btn-icon' }),
                '去申请')
              : null),

          error
            ? React.createElement('div', { className: 'dfp-alert' },
              React.createElement(AlertIcon, { className: 'dfp-alert-icon' }),
              React.createElement('span', null, error))
            : null,
          ok
            ? React.createElement('div', { className: 'dfp-ok' },
              React.createElement(CheckIcon, { className: 'dfp-alert-icon' }),
              React.createElement('span', null, ok))
            : null,

          models !== null
            ? React.createElement('div', { className: 'dfp-discovered' },
              React.createElement('div', { className: 'dfp-discovered-head' },
                '模型 ID（' + models.count + ' 个）',
                React.createElement('span', { className: 'dfp-spacer' }),
                React.createElement('button', {
                  type: 'button',
                  className: 'dfp-mini',
                  onClick: () => {
                    if (navigator.clipboard) navigator.clipboard.writeText(models.models.join('\n'))
                  },
                }, '复制全部')),
              React.createElement('div', { className: 'dfp-model-grid' },
                models.models.map((id) => React.createElement('span', { className: 'dfp-model-pill', key: id }, id))))
            : null),

        React.createElement('div', { className: 'dfp-card' },
          React.createElement('div', { className: 'dfp-card-title' },
            React.createElement(KeyIcon, { className: 'dfp-card-icon' }),
            '已保存的密钥',
            React.createElement('span', { className: 'dfp-chip dfp-keys' }, totalKeys + ' 条'),
            React.createElement('span', { className: 'dfp-spacer' }),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn',
              onClick: exportAll,
              disabled: totalKeys === 0,
            },
              React.createElement(DownloadIcon, { className: 'dfp-btn-icon' }),
              '导出全部'),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn',
              disabled: busy === 'register',
              onClick: () => {
                setBusy('register')
                setOk('')
                setError('')
                api(R.registerAll, {}).then((res) => {
                  setBusy('')
                  setOk('已注册 ' + res.registered + ' / ' + res.total + ' 个平台到 DSH')
                  const failed = (res.results || []).filter((x) => x.ok !== true)
                  if (failed.length > 0) {
                    setError(failed.slice(0, 3).map((x) => x.slug + '：' + x.reason).join('；'))
                  }
                  onChanged()
                }).catch((err) => {
                  setBusy('')
                  setError(err && err.message ? err.message : String(err))
                })
              },
            }, busy === 'register' ? '注册中…' : '注册到 DSH')),
          React.createElement('div', { className: 'dfp-card-sub' },
            '存在本机 data/vault.json，面板只显示掩码。导出为 FreeLLMAPI 格式：platform / key / label / baseUrl，可直接导回 FreeLLMAPI。'),
          withKeys.length === 0
            ? React.createElement('div', { className: 'dfp-empty' }, '还没有添加任何密钥')
            : React.createElement('div', { className: 'dfp-key-list' },
              withKeys.map((p) => React.createElement('div', { className: 'dfp-key-group', key: p.slug },
                React.createElement('div', { className: 'dfp-key-group-head' },
                  React.createElement('span', { className: 'dfp-name' }, p.name),
                  React.createElement('span', { className: 'dfp-vendor' }, p.vendor),
                  React.createElement(FreeChip, { kind: p.freeKind }),
                  React.createElement('span', { className: 'dfp-spacer' }),
                  React.createElement('span', { className: 'dfp-hint' }, p.keyCount + ' 条')),
                (p.keys || []).map((k) => {
                  const sp = speeds[k.id]
                  return React.createElement('div', { className: 'dfp-key-block', key: k.id },
                    React.createElement('div', { className: 'dfp-key' },
                      React.createElement('span', { className: 'dfp-key-label' }, k.label),
                      React.createElement('span', { className: 'dfp-key-mask dfp-mono' }, k.masked),
                      React.createElement('span', { className: 'dfp-key-url dfp-mono' }, hostOf(k.baseUrl)),
                      React.createElement('span', { className: 'dfp-spacer' }),
                      React.createElement('button', {
                        type: 'button',
                        className: 'dfp-mini',
                        disabled: sp !== undefined && sp.running === true,
                        onClick: () => speed(k),
                        title: '实测首字延迟与输出速度',
                      }, sp !== undefined && sp.running === true ? '测速中…' : '测速'),
                      React.createElement('button', {
                        type: 'button',
                        className: 'dfp-icon-btn',
                        title: '删除这条 Key',
                        onClick: () => remove(k.id),
                      }, React.createElement(TrashIcon, { className: 'dfp-close' }))),
                    sp !== undefined && sp.running !== true
                      ? React.createElement(SpeedResult, { result: sp })
                      : null)
                }))))))
    }

    // ── 数据看板 / 运行日志 ─────────────────────────────────────────────────
    //
    // Two views over one record store: the dashboard aggregates, the log lists individual
    // calls. Both read the same rows, so a number on the dashboard can always be traced to
    // the lines that produced it.

    function fmtNum(v) {
      if (v === null || v === undefined) return '—'
      return Number(v).toLocaleString('zh-CN')
    }

    function fmtPct(v) {
      if (v === null || v === undefined) return '—'
      return String(v) + '%'
    }

    function StatCard(props) {
      return React.createElement('div', { className: 'dfp-stat-card' },
        React.createElement('div', { className: 'dfp-stat-title' }, props.title),
        React.createElement('div', { className: 'dfp-stat-big' }, props.value),
        props.sub ? React.createElement('div', { className: 'dfp-stat-sub' }, props.sub) : null)
    }

    function Dashboard() {
      const [scope, setScope] = React.useState('today')
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')

      // One slot per scope: switching back shows that scope's last numbers instantly
      // instead of flashing the other scope's figures or a row of dashes.
      const [cache, setCache] = React.useState({})

      const load = React.useCallback(() => {
        setLoading(true)
        setError('')
        api(R.usage + '?scope=' + scope).then((res) => {
          setCache((prev) => ({ ...prev, [scope]: res.summary }))
          setLoading(false)
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
          setLoading(false)
        })
      }, [scope])

      React.useEffect(() => { load() }, [load])

      // Prefer this scope's own cached numbers; only fall back to the last fetched scope
      // when this one has never loaded, so the first render is never a dash-only flash.
      const m = cache[scope] || data || {}
      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-filters' },
          React.createElement('button', {
            type: 'button',
            className: 'dfp-filter' + (scope === 'today' ? ' dfp-filter-on' : ''),
            onClick: () => setScope('today'),
          }, '今日数据'),
          React.createElement('button', {
            type: 'button',
            className: 'dfp-filter' + (scope === 'all' ? ' dfp-filter-on' : ''),
            onClick: () => setScope('all'),
          }, '全部历史'),
          React.createElement('span', { className: 'dfp-spacer' }),
          React.createElement('button', {
            type: 'button',
            className: 'dfp-btn',
            onClick: load,
            disabled: loading,
            // Only the button reflects the busy state; the cards keep their last numbers so
            // the grid never blinks between the two scopes.
            'aria-busy': loading,
          },
            React.createElement(RefreshIcon, { className: 'dfp-btn-icon' }),
            loading ? '读取中…' : '刷新')),

        error !== '' ? React.createElement('div', { className: 'dfp-alert' }, error) : null,

        React.createElement('div', { className: 'dfp-cards' },
          React.createElement(StatCard, {
            title: '消耗 TOKEN',
            value: fmtNum(m.totalTokens),
            sub: '输入 ' + fmtNum(m.promptTokens) + ' · 输出 ' + fmtNum(m.completionTokens) + ' · 思考 ' + fmtNum(m.reasoningTokens),
          }),
          React.createElement(StatCard, {
            title: '平均生成速度',
            value: m.avgTps === null || m.avgTps === undefined ? '—' : m.avgTps + ' tok/s',
            sub: '首字 ' + (m.avgTtftMs === null || m.avgTtftMs === undefined ? '—' : (m.avgTtftMs / 1000).toFixed(2) + ' s'),
          }),
          React.createElement(StatCard, {
            title: '上下文缓存命中率',
            value: fmtPct(m.cacheHitRate),
            sub: '缓存命中 ' + fmtNum(m.cachedTokens),
          }),
          React.createElement(StatCard, {
            title: '请求数 & 成功率',
            value: fmtNum(m.requests),
            sub: '成功率 ' + fmtPct(m.successRate) + ' · 失败 ' + fmtNum(m.failed),
          })),

        React.createElement('div', { className: 'dfp-hint dfp-dash-note' },
          '数据来自插件实际发起的调用（测速 / Auto 网关），按本机时区统计。'))
    }

    function RunLog() {
      const [limit, setLimit] = React.useState(20)
      const [data, setData] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')

      const [health, setHealth] = React.useState(null)

      const load = React.useCallback(() => {
        setLoading(true)
        setError('')
        api(R.usageLog + '?limit=' + limit).then((res) => {
          setData(res)
          setLoading(false)
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
          setLoading(false)
        })
        // Routing health is best-effort: a log view must still render without it.
        api(R.route + '?profile=auto').then((res) => {
          setHealth(res === null || res.health === undefined ? null : res.health)
        }).catch(() => { setHealth(null) })
      }, [limit])

      React.useEffect(() => { load() }, [load])

      const rows = data === null ? [] : data.rows || []
      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-filters' },
          [10, 20, 50, 100].map((n) => React.createElement('button', {
            key: n,
            type: 'button',
            className: 'dfp-filter' + (limit === n ? ' dfp-filter-on' : ''),
            onClick: () => setLimit(n),
          }, String(n))),
          React.createElement('span', { className: 'dfp-spacer' }),
          React.createElement('span', { className: 'dfp-hint' },
            data === null ? '' : '共 ' + data.total + ' 条 · 本页 ' + rows.length + ' 条'),
          React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: load, disabled: loading },
            React.createElement(RefreshIcon, { className: 'dfp-btn-icon' }),
            loading ? '读取中…' : '刷新')),

        error !== '' ? React.createElement('div', { className: 'dfp-alert' }, error) : null,

        health !== null && health.cooling !== undefined && health.cooling.length > 0
          ? React.createElement('div', { className: 'dfp-health' },
            React.createElement('span', { className: 'dfp-health-k' }, '冷却中'),
            health.cooling.slice(0, 4).map((c) =>
              React.createElement('span', { className: 'dfp-health-item', key: c.provider + c.model },
                c.provider + ' · ' + String(c.model).split('/').pop() + ' ' + c.secondsLeft + 's')))
          : null,

        health !== null && health.budgets !== undefined
          ? React.createElement('div', { className: 'dfp-health' },
            React.createElement('span', { className: 'dfp-health-k' }, '今日预算'),
            health.budgets.map((b) => React.createElement('span', {
              key: b.provider,
              className: 'dfp-health-item' + (b.over ? ' dfp-health-over' : ''),
            }, b.provider + ' ' + Math.round((b.used / b.cap) * 100) + '%')))
          : null,

        rows.length === 0
          ? React.createElement('div', { className: 'dfp-empty' }, '还没有调用记录。用「测速」或 Auto 网关跑一次就会出现。')
          : React.createElement('div', { className: 'dfp-table' },
            React.createElement('div', { className: 'dfp-tr dfp-th' },
              ['时间', '渠道', '模型', '结果', '耗时', '首字', '速度'].map((h) =>
                React.createElement('span', { key: h, className: 'dfp-td' }, h))),
            rows.map((r, i) => React.createElement('div', { className: 'dfp-tr', key: String(r.at) + i },
              React.createElement('span', { className: 'dfp-td' }, new Date(r.at).toLocaleString('zh-CN', { hour12: false })),
              React.createElement('span', { className: 'dfp-td' }, r.channel || r.kind || ''),
              React.createElement('span', { className: 'dfp-td dfp-mono' }, r.model || ''),
              React.createElement('span', { className: 'dfp-td' },
                React.createElement('span', { className: 'dfp-chip ' + (r.ok ? 'dfp-chip-ok' : 'dfp-chip-error') },
                  r.ok ? '成功' : '失败')),
              React.createElement('span', { className: 'dfp-td' },
                r.totalMs === undefined || r.totalMs === null ? '—' : (r.totalMs / 1000).toFixed(2) + 's'),
              React.createElement('span', { className: 'dfp-td' },
                r.ttftMs === undefined || r.ttftMs === null ? '—' : (r.ttftMs / 1000).toFixed(2) + 's'),
              React.createElement('span', { className: 'dfp-td' },
                r.tps === undefined || r.tps === null ? '—' : r.tps + ' tok/s')))))
    }
    // ── 平台选择器 ─────────────────────────────────────────────────────────
    //
    // A native <select> renders as an OS widget and cannot follow the host theme, which is
    // why it looked out of place. This is a button plus a searchable menu, built from the
    // same parts and tokens as the model picker so the two read as one product.

    function PlatformPicker(props) {
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [pos, setPos] = React.useState(null)
      const boxRef = React.useRef(null)
      const selected = props.providers.find((p) => p.slug === props.value)

      React.useEffect(() => {
        if (!open) return undefined
        const place = () => {
          const box = boxRef.current
          if (box === null) return
          const rect = box.getBoundingClientRect()
          const margin = 8
          const maxH = Math.min(340, window.innerHeight - 96)
          const below = window.innerHeight - rect.bottom - margin
          const above = rect.top - margin
          const height = Math.min(maxH, Math.max(below, above))
          const openUp = below < Math.min(200, height) && above > below
          const top = openUp ? Math.max(margin, rect.top - height - 6) : rect.bottom + 6
          setPos({ top, left: Math.max(margin, rect.left), maxHeight: height })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onDoc = (event) => {
          if (boxRef.current !== null && !boxRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDoc)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const q = query.trim().toLowerCase()
      const list = sortByTier(props.providers.filter((p) =>
        q === '' || String(p.name).toLowerCase().includes(q) || String(p.vendor).toLowerCase().includes(q)))

      const trigger = React.createElement('button', {
        type: 'button',
        className: 'dfp-select' + (open ? ' dfp-select-on' : ''),
        onClick: () => setOpen(!open),
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
      },
        React.createElement('span', { className: 'dfp-select-label' },
          selected === undefined ? '选择平台…' : selected.name),
        selected === undefined
          ? null
          : React.createElement(FreeChip, { kind: selected.freeKind }),
        React.createElement(ChevronIcon, { className: 'dfp-select-chevron', open }))

      if (!open) {
        return React.createElement('div', { className: 'dfp-select-wrap', ref: boxRef }, trigger)
      }

      const menu = React.createElement('div', {
        className: 'dfp-pop dfp-select-pop',
        role: 'listbox',
        style: pos === null
          ? { top: 0, left: 0, visibility: 'hidden' }
          : { top: pos.top, left: pos.left, maxHeight: pos.maxHeight },
      },
        React.createElement('div', { className: 'dfp-pop-head' },
          React.createElement('input', {
            className: 'dfp-pop-search',
            value: query,
            placeholder: '搜索平台…',
            autoFocus: true,
            onChange: (e) => setQuery(e.target.value),
          })),
        React.createElement('div', { className: 'dfp-pop-body' },
          list.length === 0
            ? React.createElement('div', { className: 'dfp-empty' }, '没有匹配的平台')
            : list.map((p) => React.createElement('button', {
              key: p.slug,
              type: 'button',
              role: 'option',
              'aria-selected': p.slug === props.value,
              className: 'dfp-pop-model' + (p.slug === props.value ? ' dfp-pop-model-on' : ''),
              onClick: () => {
                props.onChange(p.slug)
                setOpen(false)
                setQuery('')
              },
            },
              React.createElement('span', { className: 'dfp-select-name' }, p.name),
              React.createElement(FreeChip, { kind: p.freeKind }),
              p.slug === props.value
                ? React.createElement(CheckIcon, { className: 'dfp-pop-check' })
                : null))))

      return React.createElement('div', { className: 'dfp-select-wrap', ref: boxRef }, trigger, menu)
    }
    // ── 平台目录 ───────────────────────────────────────────────────────────

    function Catalog(props) {
      const { providers } = props
      const [kind, setKind] = React.useState('all')
      const KINDS = [
        { id: 'all', label: '全部' },
        { id: 'long-term', label: '长期免费' },
        { id: 'daily', label: '每日刷新' },
        { id: 'trial', label: '新用户赠额' },
      ]
      const shown = sortByTier(providers.filter((p) => p.category !== 'custom' && (kind === 'all' || p.freeKind === kind)))
      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-filters' },
          KINDS.map((k) => React.createElement('button', {
            key: k.id,
            type: 'button',
            className: 'dfp-filter' + (kind === k.id ? ' dfp-filter-on' : ''),
            onClick: () => setKind(k.id),
          }, k.label)),
          React.createElement('span', { className: 'dfp-spacer' }),
          React.createElement('span', { className: 'dfp-hint' }, '点「申请」在新标签打开官方密钥页')),

        React.createElement('div', { className: 'dfp-list' },
          shown.map((p) => React.createElement('div', { className: 'dfp-cat-row', key: p.slug },
            React.createElement('div', { className: 'dfp-cat-main' },
              React.createElement('div', { className: 'dfp-cat-title' },
                React.createElement('span', { className: 'dfp-name' }, p.name),
                React.createElement('span', { className: 'dfp-vendor' }, p.vendor),
                React.createElement(FreeChip, { kind: p.freeKind }),
                p.keyCount > 0
                  ? React.createElement('span', { className: 'dfp-chip dfp-keys' }, p.keyCount + ' 个 Key')
                  : null),
              React.createElement('div', { className: 'dfp-cat-note' }, p.freeNote || ''),
              React.createElement('div', { className: 'dfp-meta' },
                React.createElement('span', { className: 'dfp-host' }, hostOf(p.baseUrl)),
                p.keyHint
                  ? React.createElement(React.Fragment, null,
                    React.createElement('span', { className: 'dfp-sep' }, '·'),
                    React.createElement('span', null, 'Key 格式：' + p.keyHint))
                  : null)),
            React.createElement('div', { className: 'dfp-cat-actions' },
              React.createElement('button', {
                type: 'button',
                className: 'dfp-btn dfp-btn-primary',
                onClick: () => openApply(p.applyUrl),
                disabled: !p.applyUrl,
              },
                React.createElement(ExternalIcon, { className: 'dfp-btn-icon' }),
                '申请'),
              p.docsUrl
                ? React.createElement('button', {
                  type: 'button',
                  className: 'dfp-btn',
                  onClick: () => openApply(p.docsUrl),
                }, '文档')
                : null)))))
    }

    // ── panel shell ────────────────────────────────────────────────────────

    function Panel() {
      const open = useOpen()
      const [tab, setTab] = React.useState('overview')
      const [providers, setProviders] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [probing, setProbing] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notes, setNotes] = React.useState({})
      const [quotaAt, setQuotaAt] = React.useState(0)
      const [freeData, setFreeData] = React.useState(null)
      const [freeLoading, setFreeLoading] = React.useState(false)
      const [focusSlug, setFocusSlug] = React.useState('')
      const [expanded, setExpanded] = React.useState({})
      const [speeds, setSpeeds] = React.useState({})

      // Two calls, deliberately separate: `loadQuota` is vault-only and returns in ~40ms,
      // so the panel paints immediately even with 150+ keys; `probeQuota` does the network
      // work and is only run for cards the user is actually looking at, or on request.
      const loadQuota = React.useCallback(() => {
        setError('')
        return api(R.quota).then((data) => {
          setProviders(data.providers || [])
          setQuotaAt(data.at || Date.now())
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
        })
      }, [])

      const probeQuota = React.useCallback((slugs) => {
        setLoading(true)
        setError('')
        return api(R.probe, slugs && slugs.length > 0 ? { slugs } : {}).then((data) => {
          // Merge by slug: a targeted probe must not drop the cards it did not look at.
          setProviders((prev) => {
            const byslug = new Map((data.providers || []).map((p) => [p.slug, p]))
            const merged = prev.map((p) => byslug.get(p.slug) ?? p)
            // A slug the list did not have yet (a fresh custom relay) is appended.
            for (const p of data.providers || []) {
              if (!merged.some((m) => m.slug === p.slug)) merged.push(p)
            }
            return merged
          })
          setQuotaAt(data.at || Date.now())
          setLoading(false)
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
          setLoading(false)
        })
      }, [])

      const loadFree = React.useCallback(() => {
        setFreeLoading(true)
        return api(R.freeModels).then((data) => {
          setFreeData(data)
          setFreeLoading(false)
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
          setFreeLoading(false)
        })
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        loadQuota()
        return undefined
      }, [open, loadQuota])

      React.useEffect(() => {
        if (!open || tab !== 'free') return undefined
        if (freeData !== null) return undefined
        loadFree()
        return undefined
      }, [open, tab, freeData, loadFree])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      const onCheckin = (provider) => {
        setBusy(provider.slug)
        setNotes((prev) => ({ ...prev, [provider.slug]: '' }))
        api(R.checkin, { slug: provider.slug }).then((res) => {
          setNotes((prev) => ({ ...prev, [provider.slug]: res.message || (res.ok ? '签到成功' : '签到失败') }))
          setBusy('')
          loadQuota()
        }).catch((err) => {
          setNotes((prev) => ({ ...prev, [provider.slug]: err && err.message ? err.message : String(err) }))
          setBusy('')
        })
      }

      const onCheckinAll = () => {
        setBusy('__all__')
        api(R.checkinAll).then((res) => {
          const next = {}
          for (const item of res.results || []) next[item.slug] = item.message
          setNotes((prev) => ({ ...prev, ...next }))
          setBusy('')
          loadQuota()
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
          setBusy('')
        })
      }

      const onAdd = (provider) => {
        setFocusSlug(provider.slug)
        setTab('vault')
      }

      const onToggle = (slug) => {
        setExpanded((prev) => ({ ...prev, [slug]: prev[slug] !== true }))
      }

      const onProbe = (slug) => {
        setProbing(slug)
        probeQuota([slug]).then(() => setProbing(''))
      }

      const onSpeed = (account) => {
        setSpeeds((prev) => ({ ...prev, [account.id]: { running: true } }))
        api(R.speedTest, { entryId: account.id }).then((res) => {
          setSpeeds((prev) => ({ ...prev, [account.id]: res }))
        }).catch((err) => {
          setSpeeds((prev) => ({
            ...prev,
            [account.id]: { ok: false, error: err && err.message ? err.message : String(err) },
          }))
        })
      }

      const onRemove = (id) => {
        api(R.remove, { id }).then(() => {
          loadQuota()
        }).catch((err) => setError(err && err.message ? err.message : String(err)))
      }

      const TABS = [
        { id: 'overview', label: '概览', icon: GridIcon },
        { id: 'dashboard', label: '数据看板', icon: GaugeIcon },
        { id: 'logs', label: '运行日志', icon: ListIcon },
        { id: 'free', label: '免费模型', icon: SparkIcon },
        { id: 'vault', label: '密钥', icon: KeyIcon },
        { id: 'catalog', label: '平台', icon: GiftIcon },
      ]

      const checkinable = providers.filter((p) => p.checkin).length

      return React.createElement('div', {
        className: 'dfp-backdrop',
        onClick: (event) => {
          if (event.target === event.currentTarget) setOpen(false)
        },
      },
        React.createElement('div', {
          className: 'dfp-panel',
          role: 'dialog',
          'aria-label': '免费 API 池',
        },
          React.createElement('div', { className: 'dfp-head' },
            React.createElement('div', { className: 'dfp-head-text' },
              React.createElement('div', { className: 'dfp-title' }, '免费 API 池'),
              React.createElement('div', { className: 'dfp-sub' },
                providers.length + ' 个平台'
                + (quotaAt > 0 ? ' · 额度更新于 ' + new Date(quotaAt).toLocaleTimeString('zh-CN') : ''))),
            React.createElement('span', { className: 'dfp-spacer' }),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn dfp-btn-primary',
              onClick: () => probeQuota(),
              disabled: loading,
            },
              React.createElement(RefreshIcon, { className: 'dfp-btn-icon' }),
              loading ? '查询中…' : '刷新额度'),
            checkinable > 0
              ? React.createElement('button', {
                type: 'button',
                className: 'dfp-btn',
                onClick: onCheckinAll,
                disabled: busy === '__all__',
              }, busy === '__all__' ? '签到中…' : '一键签到')
              : null,
            React.createElement('button', {
              type: 'button',
              className: 'dfp-icon-btn',
              onClick: () => setOpen(false),
              title: '关闭',
              'aria-label': '关闭',
            }, React.createElement(CloseIcon, { className: 'dfp-close' }))),

          React.createElement('div', { className: 'dfp-tabs' },
            TABS.map((t) => React.createElement('button', {
              key: t.id,
              type: 'button',
              className: 'dfp-tab' + (tab === t.id ? ' dfp-tab-on' : ''),
              onClick: () => setTab(t.id),
            },
              React.createElement(t.icon, { className: 'dfp-tab-icon' }),
              t.label))),

          React.createElement('div', { className: 'dfp-body' },
            tab === 'overview'
              ? React.createElement(Overview, {
                providers, loading, busy, notes, error, probing,
                expanded, onToggle,
                onProbe,
                speeds, onSpeed, onRemove,
                onCheckin, onAdd,
              })
              : null,
            tab === 'dashboard' ? React.createElement(Dashboard) : null,
            tab === 'logs' ? React.createElement(RunLog) : null,
            tab === 'free'
              ? React.createElement(FreeModels, {
                data: freeData,
                loading: freeLoading,
                onRefresh: () => {
                  setFreeData(null)
                  loadFree()
                },
              })
              : null,
            tab === 'vault'
              ? React.createElement(Vault, {
                providers,
                focusSlug,
                onChanged: () => {
                  loadQuota()
                },
              })
              : null,
            tab === 'catalog'
              ? React.createElement(Catalog, { providers })
              : null),

          React.createElement('div', { className: 'dfp-foot' },
            '额度只显示平台真实提供的数字；「需控制台」表示该平台没有余额接口。密钥仅保存在本机 data/vault.json，导出为 FreeLLMAPI 格式。')))
    }

    // ── styles ─────────────────────────────────────────────────────────────
    //
    // Doubao dashboard tokens: #0065fd accent, 19.2px radius, 3.84px spacing unit.
    // A second palette (`.dfp-dark`) is applied when the measured surface luminance is dark,
    // because a 10%-blue fill under #0065fd text is unreadable there.

    const STYLES = `

/* ── DSH-native styling ──────────────────────────────────────────────────────
   Every colour, font and radius below comes from the harness's own tokens, so the
   panel inherits the theme the user picked (light / dark / system) instead of
   guessing at it. Hard-coded #0065fd plus a downloaded MiSans webfont were what made
   text unreadable and blurry: the app's brand token resolves to near-black, and a
   webfont that arrives late renders as a different fallback first.
   Tokens used: --dsw-alias-bg-layer-1/2/3, bg-overlay, bg-mask-1, border-l1/l2,
   label-primary/secondary/tertiary, brand-primary, label-primary-foreground,
   button-primary-fill, state-success/error/warn, font-family, markdown-code. */

.dfp-trigger, .dfp-panel, .dfp-pool-wrap, .dfp-pop {
  --db-radius: var(--dsw-radius-lg, 16px);
  --db-radius-sm: var(--dsw-radius-md, 12px);
  --db-bg: var(--dsw-alias-bg-layer-1, #fff);
  --db-bg-sunken: var(--dsw-alias-bg-layer-2, #f5f6f7);
  --db-bg-card: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1, #fff));
  --db-fg: var(--dsw-alias-label-primary, #0f1115);
  --db-fg-2: var(--dsw-alias-label-secondary, #61666b);
  /* label-tertiary is 3.71:1 on white — below AA for small text, so hints use the
     secondary tone (5.8:1 light / 10.4:1 dark) which the app guarantees to be legible. */
  --db-fg-3: var(--dsw-alias-label-secondary, #61666b);
  --db-fg-4: var(--dsw-alias-label-tertiary, #81858c);
  --db-border: var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  --db-border-strong: var(--dsw-alias-border-l2, rgba(0,0,0,.14));
  --db-on-accent: var(--dsw-alias-label-primary-foreground, #fff);
  --db-accent-fill: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0f1115));
  --db-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
  --db-ok: var(--dsw-alias-state-success-primary, #0f9d76);
  --db-err: var(--dsw-alias-state-error-primary, #dc4444);
  --db-warn: var(--dsw-alias-state-warn-label, #b87514);
  /* Translucent scrollbar thumb: reads as an overlay, not a solid column. */
  --db-scroll-thumb: color-mix(in srgb, var(--db-fg-3, #81858c) 45%, transparent);
  --db-scroll-thumb-hover: color-mix(in srgb, var(--db-fg-2, #61666b) 70%, transparent);
  --db-font: var(--dsw-font-family, inherit);
  --db-mono: var(--dsw-font-markdown-code, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.dfp-trigger { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; border-radius: var(--dsw-radius-sm, 8px); flex: 0 0 auto; max-width: 132px; border: 1px solid var(--db-border); background: transparent; color: var(--db-fg-2); cursor: pointer; font-family: var(--db-font); font-size: 12px; line-height: 1; transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }
.dfp-trigger:hover { background: var(--db-hover); color: var(--db-fg); }
.dfp-trigger.dfp-open { border-color: var(--db-border-strong); color: var(--db-fg); background: var(--db-hover); }
.dfp-trigger:focus-visible { outline: 2px solid var(--db-fg); outline-offset: 1px; }
.dfp-trigger-icon { width: 14px; height: 14px; flex: none; }
.dfp-trigger-label { max-width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfp-trigger-count { flex: none; min-width: 18px; height: 16px; padding: 0 5px; border-radius: 8px; background: var(--db-bg-sunken); color: var(--db-fg-2); font-size: 10px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }

.dfp-backdrop { position: fixed; inset: 0; z-index: 200; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24)); display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
.dfp-panel { box-sizing: border-box; width: 900px; max-width: calc(100vw - 48px); height: min(86vh, 880px); display: flex; flex-direction: column; background: var(--db-bg); border: 1px solid var(--db-border-strong); border-radius: var(--db-radius); padding: 16px; color: var(--db-fg); font-family: var(--db-font); font-size: 13px; line-height: 1.55; text-align: left; -webkit-font-smoothing: antialiased; }

.dfp-head { display: flex; align-items: center; gap: 8px; }
.dfp-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dfp-title { font-weight: 600; font-size: 15px; color: var(--db-fg); }
.dfp-sub { color: var(--db-fg-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.dfp-spacer { flex: 1 1 auto; }

.dfp-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 15px; border: 1px solid var(--db-border-strong); background: var(--db-bg-card); color: var(--db-fg); cursor: pointer; font-family: var(--db-font); font-size: 12px; line-height: 1; transition: background 120ms ease, border-color 120ms ease; white-space: nowrap; }
.dfp-btn:hover:not(:disabled) { background: var(--db-hover); }
.dfp-btn:disabled { opacity: .45; cursor: default; }
.dfp-btn-primary { background: var(--db-accent-fill); border-color: transparent; color: var(--db-on-accent); }
.dfp-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.dfp-btn-icon { width: 13px; height: 13px; flex: none; }
.dfp-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border-radius: 15px; border: 1px solid transparent; background: transparent; color: var(--db-fg-2); cursor: pointer; }
.dfp-icon-btn:hover { background: var(--db-hover); color: var(--db-fg); }
.dfp-close { width: 15px; height: 15px; }

.dfp-tabs { display: flex; align-items: center; gap: 4px; margin-top: 14px; padding-bottom: 6px; border-bottom: 1px solid var(--db-border); }
.dfp-tab { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--db-fg-2); cursor: pointer; font-family: var(--db-font); font-size: 12px; line-height: 1; }
.dfp-tab:hover { background: var(--db-hover); color: var(--db-fg); }
/* Selected: the app's own foreground/background pair, the one combination it guarantees
   to be legible in both themes. */
.dfp-tab-on, .dfp-tab-on:hover { background: var(--db-fg); color: var(--db-bg); border-color: transparent; font-weight: 600; }
.dfp-tab-icon { width: 14px; height: 14px; flex: none; }

.dfp-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dfp-view { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; overflow-y: auto; padding-right: 2px; }

.dfp-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.dfp-stat { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); background: var(--db-bg-sunken); }
.dfp-stat-v { font-size: 20px; font-weight: 600; color: var(--db-fg); font-variant-numeric: tabular-nums; line-height: 1.2; }
.dfp-stat-k { font-size: 12px; color: var(--db-fg-3); }

.dfp-filters { display: flex; align-items: center; gap: 6px; margin-top: 12px; flex-wrap: wrap; row-gap: 8px; }
.dfp-filter { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--db-border); background: transparent; color: var(--db-fg-2); cursor: pointer; font-family: var(--db-font); font-size: 12px; line-height: 1; }
.dfp-filter:hover { background: var(--db-hover); color: var(--db-fg); }
.dfp-filter-on, .dfp-filter-on:hover { background: var(--db-fg); border-color: transparent; color: var(--db-bg); }
.dfp-hint { font-size: 12px; color: var(--db-fg-3); }
.dfp-search { flex: 1 1 180px; min-width: 140px; max-width: 260px; width: auto; height: 28px; border-radius: var(--dsw-radius-sm, 8px); }
.dfp-more { align-self: center; margin: 4px 0 8px; height: 30px; padding: 0 16px; border-radius: 15px; border: 1px solid var(--db-border-strong); background: var(--db-bg-card); color: var(--db-fg); cursor: pointer; font-family: var(--db-font); font-size: 12px; }
.dfp-more:hover { background: var(--db-hover); }
.dfp-row { padding: 14px 16px; border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); background: var(--db-bg-card); }
.dfp-row:hover { border-color: var(--db-border-strong); }
.dfp-row-open { border-color: var(--db-border-strong); background: var(--db-bg-sunken); }
.dfp-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px; }
.dfp-expand { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border-radius: 6px; border: 1px solid var(--db-border); background: transparent; color: var(--db-fg-2); cursor: pointer; flex: none; }
.dfp-expand:hover { background: var(--db-hover); color: var(--db-fg); }
.dfp-expand-icon { width: 13px; height: 13px; }
.dfp-name { font-weight: 600; font-size: 13px; color: var(--db-fg); }
.dfp-vendor { font-size: 12px; color: var(--db-fg-3); }
.dfp-chip { padding: 1px 7px; border-radius: 9px; border: 1px solid var(--db-border-strong); font-size: 12px; line-height: 18px; color: var(--db-fg-2); white-space: nowrap; }
.dfp-chip-ok { border-color: var(--db-ok); color: var(--db-ok); }
.dfp-chip-console, .dfp-chip-untested { border-color: var(--db-border-strong); color: var(--db-fg-3); }
.dfp-chip-nokey { border-color: var(--db-warn); color: var(--db-warn); }
.dfp-chip-error { border-color: var(--db-err); color: var(--db-err); }
.dfp-keys { border-color: var(--db-fg-2); color: var(--db-fg-2); }
.dfp-nature { padding: 1px 6px; border-radius: 9px; background: var(--db-bg-sunken); font-size: 11px; line-height: 16px; color: var(--db-fg-3); white-space: nowrap; }

.dfp-free { padding: 1px 7px; border-radius: 9px; font-size: 11px; line-height: 16px; white-space: nowrap; border: 1px solid transparent; }
.dfp-free-long { color: var(--db-ok); border-color: var(--db-ok); }
.dfp-free-daily { color: var(--db-fg-2); border-color: var(--db-border-strong); }
.dfp-free-trial { color: var(--db-warn); border-color: var(--db-warn); }
.dfp-free-unknown { color: var(--db-fg-3); border-color: var(--db-border); }

.dfp-mini { height: 22px; padding: 0 9px; border-radius: 11px; border: 1px solid var(--db-border-strong); background: transparent; color: var(--db-fg); cursor: pointer; font-family: var(--db-font); font-size: 11px; line-height: 1; white-space: nowrap; }
.dfp-mini:hover:not(:disabled) { background: var(--db-hover); }
.dfp-mini:disabled { opacity: .45; cursor: default; }
.dfp-mini-primary { font-weight: 500; }

.dfp-meta { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--db-fg-3); flex-wrap: wrap; }
.dfp-host { font-family: var(--db-mono); font-size: 12px; }
.dfp-sep { opacity: .5; }
.dfp-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px 16px; margin-top: 12px; }
.dfp-metric { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dfp-metric-k { font-size: 12px; color: var(--db-fg-3); }
.dfp-metric-v { font-size: 13px; color: var(--db-fg); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dfp-strong { font-weight: 600; }

.dfp-windows { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dfp-window { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--db-border); border-radius: 9px; background: var(--db-bg-sunken); font-size: 11px; font-variant-numeric: tabular-nums; color: var(--db-fg); }
.dfp-window-k { color: var(--db-fg-3); }
.dfp-window-v { font-weight: 600; }
.dfp-window-reset { color: var(--db-fg-3); font-size: 11px; }

.dfp-detail, .dfp-note { margin-top: 6px; font-size: 12.5px; color: var(--db-fg-3); line-height: 1.55; }

.dfp-accounts { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--db-border); display: flex; flex-direction: column; gap: 8px; }
.dfp-account { padding: 10px; border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); background: var(--db-bg); }
.dfp-account-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dfp-account-label { font-weight: 600; font-size: 12px; color: var(--db-fg); }
.dfp-account-mask { font-size: 11px; color: var(--db-fg-3); }

.dfp-fm-head { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.dfp-fm-group { border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); padding: 10px; background: var(--db-bg-card); }
.dfp-fm-group-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dfp-fm-group-name { font-weight: 600; font-size: 13px; color: var(--db-fg); }
.dfp-model-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dfp-model { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--db-border); border-radius: 9px; background: var(--db-bg-sunken); font-size: 11px; max-width: 100%; }
.dfp-model-id { font-family: var(--db-mono); font-size: 11px; color: var(--db-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.dfp-model-meta { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.dfp-model-ctx { color: var(--db-fg-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.dfp-model-pill { padding: 2px 8px; border: 1px solid var(--db-border); border-radius: 9px; background: var(--db-bg-sunken); font-family: var(--db-mono); font-size: 11px; color: var(--db-fg); }

.dfp-card { border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); padding: 12px; margin-top: 12px; background: var(--db-bg-card); }
.dfp-card-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; color: var(--db-fg); }
.dfp-card-icon { width: 15px; height: 15px; flex: none; color: var(--db-fg-2); }
.dfp-card-sub { margin-top: 4px; font-size: 12px; color: var(--db-fg-3); line-height: 1.6; }
.dfp-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.dfp-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dfp-field-k { font-size: 12px; color: var(--db-fg-2); }
.dfp-field-hint { font-size: 12px; color: var(--db-fg-3); }
.dfp-input { height: 32px; padding: 0 10px; border: 1px solid var(--db-border-strong); border-radius: var(--db-radius-sm); background: var(--db-bg); color: var(--db-fg); font-family: var(--db-font); font-size: 12px; box-sizing: border-box; width: 100%; }
.dfp-input:focus { outline: none; border-color: var(--db-fg-2); }
.dfp-mono { font-family: var(--db-mono); font-size: 12px; }

/* Platform picker: a button that reads like a host input, not an OS widget. */
.dfp-select-wrap { position: relative; display: block; width: 100%; min-width: 0; }
.dfp-select {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 34px;
  padding: 0 10px; box-sizing: border-box; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, var(--db-border));
  border-radius: var(--dsw-radius-md, 10px);
  background: transparent; color: var(--dsw-alias-label-primary, var(--db-fg));
  font-family: var(--db-font); font-size: 13px; line-height: 18px; text-align: left;
}
.dfp-select:hover { background: var(--dsw-alias-interactive-bg-hover, var(--db-hover)); }
.dfp-select-on { border-color: var(--dsw-alias-border-l2, var(--db-border-strong)); }
.dfp-select-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfp-select-chevron { width: 14px; height: 14px; flex: none; color: var(--dsw-alias-label-caption, var(--db-fg-3)); }
.dfp-select-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfp-select-pop { min-width: 320px; }
.dfp-form-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.dfp-discovered { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--db-border); }
.dfp-discovered-head { display: flex; align-items: center; font-size: 12px; color: var(--db-fg-3); }

.dfp-key-list { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.dfp-key-group { border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); padding: 8px 10px; }
.dfp-key-group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dfp-key-block { border-top: 1px solid var(--db-border); }
.dfp-key { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 12px; }
.dfp-key-label { font-weight: 500; color: var(--db-fg); }
.dfp-key-mask { color: var(--db-fg-3); }
.dfp-key-url { color: var(--db-fg-3); font-size: 11px; }

.dfp-speed { display: flex; flex-direction: column; gap: 6px; padding: 10px; margin-bottom: 6px; border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); background: var(--db-bg-sunken); }
.dfp-speed-bad { flex-direction: row; align-items: center; border-color: var(--db-err); }
.dfp-speed-head { display: flex; align-items: center; gap: 6px; }
.dfp-speed-icon { width: 14px; height: 14px; flex: none; color: var(--db-fg-2); }
.dfp-speed-bad .dfp-speed-icon { color: var(--db-err); }
.dfp-speed-model { font-size: 11px; color: var(--db-fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfp-speed-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.dfp-speed-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dfp-speed-k { font-size: 11px; color: var(--db-fg-3); }
.dfp-speed-v { font-size: 13px; font-weight: 600; color: var(--db-fg); font-variant-numeric: tabular-nums; }
.dfp-speed-error { font-size: 12px; color: var(--db-fg); }
.dfp-grade { padding: 1px 7px; border-radius: 9px; font-size: 11px; line-height: 16px; border: 1px solid transparent; white-space: nowrap; }
.dfp-grade-excellent { color: var(--db-ok); border-color: var(--db-ok); }
.dfp-grade-good { color: var(--db-fg-2); border-color: var(--db-border-strong); }
.dfp-grade-fair { color: var(--db-warn); border-color: var(--db-warn); }
.dfp-grade-slow { color: var(--db-err); border-color: var(--db-err); }
.dfp-grade-unknown { color: var(--db-fg-3); border-color: var(--db-border); }

.dfp-cat-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px; border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); background: var(--db-bg-card); }
.dfp-cat-row:hover { border-color: var(--db-border-strong); }
.dfp-cat-main { flex: 1 1 auto; min-width: 0; }
.dfp-cat-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dfp-cat-note { margin-top: 4px; font-size: 12px; color: var(--db-fg-3); }
.dfp-cat-actions { display: flex; align-items: center; gap: 6px; flex: none; }


/* Dashboard cards: same surface/radius language as the rest of the panel. */
.dfp-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.dfp-stat-card { padding: 16px; border: 1px solid var(--dsw-alias-border-l1, var(--db-border)); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-2, var(--db-bg-sunken)); }
.dfp-stat-title { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, var(--db-fg-2)); }
.dfp-stat-big { margin-top: 6px; font-size: 26px; line-height: 32px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, var(--db-fg)); }
.dfp-stat-sub { margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); }
.dfp-dash-note { margin-top: 10px; }

/* Run log table. */
.dfp-move {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, var(--db-fg-3));
  cursor: pointer;
  font-family: var(--db-font);
  font-size: 12px;
  line-height: 1;
}
.dfp-move:hover { background: var(--dsw-alias-interactive-bg-hover, var(--db-hover)); color: var(--dsw-alias-label-primary, var(--db-fg)); }
.dfp-move:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l2, var(--db-border-strong)); }
.dfp-health { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; }
.dfp-health-k { color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); }
.dfp-health-item { padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1, var(--db-border)); border-radius: 9px; color: var(--dsw-alias-label-secondary, var(--db-fg-2)); font-variant-numeric: tabular-nums; }
.dfp-health-over { border-color: var(--dsw-alias-state-error-primary, var(--db-err)); color: var(--dsw-alias-state-error-primary, var(--db-err)); }
.dfp-table { margin-top: 12px; border: 1px solid var(--dsw-alias-border-l1, var(--db-border)); border-radius: var(--dsw-radius-md, 12px); overflow: hidden; }
.dfp-tr { display: grid; grid-template-columns: 1.4fr .7fr 1.6fr .6fr .6fr .6fr .8fr; gap: 8px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1, var(--db-border)); font-size: 12px; line-height: 18px; }
.dfp-tr:first-child { border-top: 0; }
.dfp-th { background: var(--dsw-alias-bg-layer-2, var(--db-bg-sunken)); color: var(--dsw-alias-label-secondary, var(--db-fg-2)); font-weight: 500; }
.dfp-td { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, var(--db-fg)); }
.dfp-th .dfp-td { color: inherit; }

.dfp-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--db-border); font-size: 12px; color: var(--db-fg-3); line-height: 1.6; }

.dfp-pool-wrap { position: relative; display: inline-flex; align-items: center; }

/* Popover matched to the host's model selector: same shell radius, same row height,
   same muted group headers, same trailing check mark on the active row. */
/* Matched to the host's own model menu (ModelSelect.module.css): fixed positioning so it
   is not clipped by the composer, host radius/padding/elevation, host scrollbar tokens.
   Background comes from the theme token only — a hard-coded light fallback is what made
   this popover render white on a dark theme. */
.dfp-pop {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: min(320px, 100vw - 32px);
  max-width: min(420px, 100vw - 32px);
  /* right-anchored: the box grows leftwards from the trigger's right edge */
  max-height: min(360px, 100vh - 96px);
  display: flex;
  flex-direction: column;
  padding: 4px;
  overflow: hidden;
  border: 0;
  border-radius: var(--dsw-radius-lg, 12px);
  /* Host menu material, matched exactly: a translucent fill (--dsw-menu-surface-fill is
     ~45% in dark, ~58% in light) behind a 40px backdrop blur. --dsw-specific-menu is the
     opaque 94% variant and made this read as a solid slab. */
  background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay, var(--db-bg)));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  color: var(--dsw-alias-label-primary, var(--db-fg));
  box-shadow: var(--dsw-elevation-prominent, 0 10px 32px rgba(0,0,0,.24));
  --dsh-scrollbar-thumb: var(--db-scroll-thumb);
  --dsh-scrollbar-thumb-hover: var(--db-scroll-thumb-hover);
}

.dfp-pop-head { display: flex; align-items: center; gap: 6px; padding: 2px 2px 3px; flex-shrink: 0; }
/* Matches the host menu search: no border, no fill — it reads as a placeholder row
   until you type, rather than a boxed input. */
.dfp-pop-search {
  flex: 1 1 auto;
  min-width: 0;
  height: auto;
  padding: 5px 7px;
  box-sizing: border-box;
  border: 0 solid transparent;
  border-radius: var(--dsw-radius-md, 10px);
  background: transparent;
  color: var(--dsw-alias-label-primary, var(--db-fg));
  font-family: var(--db-font);
  font-size: 13px;
  line-height: 18px;
}
.dfp-pop-search::placeholder { color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); }
.dfp-pop-search:focus { outline: none; border-color: transparent; }
.dfp-pop-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 2px; padding-right: 2px; min-width: 300px; }

/* Group header: muted caption like the host's group label, with breathing room above. */
.dfp-pop-group { display: flex; flex-direction: column; min-width: 0; }
.dfp-pop-group + .dfp-pop-group { margin-top: 6px; }
.dfp-pop-group-head {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  /* Sticky so the label holds its place while models scroll beneath it. The fill is the same
     translucent material as a model row, just one step darker, and the corners match the row
     radius — so the header reads as part of the list rather than a separate bar. */
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 6px 0 2px;
  padding: 3px 8px;
  border-radius: var(--dsw-radius-md, 10px);
  /* Fully opaque, so models scrolling underneath never show through. The fill is the solid
     layer-1 surface (the same colour the menu's translucency sits on), which keeps the hue in
     family with the rows while being completely solid in both themes. */
  background: var(--dsw-alias-bg-layer-1, var(--db-bg, #232324));
}
.dfp-pop-group-name { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); }
.dfp-pop-count { font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); font-variant-numeric: tabular-nums; }

/* Rows: host option geometry — 34px min height, radius-md, 5px/7px padding, 6px gap. */
.dfp-pop-models { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.dfp-pop-model {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: auto;
  min-width: 100%;
  min-height: 34px;
  padding: 5px 7px;
  border: 0;
  border-radius: var(--dsw-radius-md, 10px);
  background: transparent;
  color: var(--dsw-alias-label-primary, var(--db-fg));
  cursor: pointer;
  font-family: var(--db-font);
  font-size: 13px;
  line-height: 18px;
  text-align: left;
}
.dfp-pop-model:hover { background: var(--dsw-alias-interactive-bg-hover, var(--db-hover)); }
.dfp-pop-model-on { background: var(--dsw-alias-interactive-bg-hover, var(--db-hover)); }
.dfp-pop-model-id { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfp-pop-model-note { flex: 1 1 auto; min-width: 0; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.dfp-pop-model-busy { flex: none; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); }
.dfp-pop-check { width: 14px; height: 14px; flex: 0 0 14px; margin-left: auto; color: var(--dsw-alias-label-primary, var(--db-fg)); }
.dfp-pop-loading, .dfp-pop-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, var(--db-fg-3)); padding: 4px 8px 8px; }
.dfp-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--db-border); font-size: 12px; color: var(--db-fg-3); line-height: 1.6; }

.dfp-pool-wrap { position: relative; display: inline-flex; align-items: center; }

/* Popover matched to the host's model selector: same shell radius, same row height,
   same muted group headers, same trailing check mark on the active row. */
.dfp-pop-body, .dfp-view, .dfp-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 4px 2px 0;
  scrollbar-width: thin;
  scrollbar-color: var(--db-scroll-thumb) transparent;
}

/* The host hides scrollbars globally (::-webkit-scrollbar{display:none}), so display:block
   is required or the bar is sized but never painted. The thumb is translucent so it reads
   as an overlay on the list rather than a solid column. */
.dfp-pop-body::-webkit-scrollbar, .dfp-view::-webkit-scrollbar, .dfp-list::-webkit-scrollbar {
  display: block;
  width: 12px;
  height: 12px;
}
.dfp-pop-body::-webkit-scrollbar-track, .dfp-view::-webkit-scrollbar-track, .dfp-list::-webkit-scrollbar-track {
  background: transparent;
}
.dfp-pop-body::-webkit-scrollbar-thumb, .dfp-view::-webkit-scrollbar-thumb, .dfp-list::-webkit-scrollbar-thumb {
  background: var(--db-scroll-thumb);
  border-radius: 999px;
  /* Transparent border + content-box keeps a slim bar with a wide hit area. */
  border: 3px solid transparent;
  background-clip: content-box;
}
.dfp-pop-body::-webkit-scrollbar-thumb:hover, .dfp-view::-webkit-scrollbar-thumb:hover, .dfp-list::-webkit-scrollbar-thumb:hover {
  background: var(--db-scroll-thumb-hover);
  background-clip: content-box;
}

.dfp-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--db-border); font-size: 12px; color: var(--db-fg-3); line-height: 1.6; }
`

    // ── plugin entry ───────────────────────────────────────────────────────

    function apply(ctx) {
      // The slot's session scope gives each entry its sessionId; the service is captured
      // once here so the picker can perform a real switch.
      modelDirectories = ctx.modelDirectories === undefined ? null : ctx.modelDirectories

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.setAttribute('data-plugin', NS)
        tag.textContent = STYLES
        document.head.appendChild(tag)
        return () => {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
        }
      }, NS + ': styles')

      ctx.slots.inject('conversation.input.left', () => {
        return ctx.slots.register(
          { name: 'conversation.input.left', id: 'free-api-pool', order: 80, label: () => '免费 API 池' },
          (props) => React.createElement(LeftButton, props))
      })

      // conversation.input.right is a *list* slot that renders inside the composer's
      // .standardControls row, directly before the model seat — so this appends next to the
      // model button instead of replacing it. conversation.input.model must NOT be used:
      // it is declared kind:"single", so registering there removes the host's own control.
      ctx.slots.inject('conversation.input.right', () => {
        return ctx.slots.register(
          { name: 'conversation.input.right', id: 'free-api-pool-picker', order: 20, label: () => '白嫖池' },
          (props) => React.createElement(PoolPicker, props))
      })

      ctx.slots.inject('conversation.input.overlay', () => {
        return ctx.slots.register(
          { name: 'conversation.input.overlay', id: 'free-api-pool-panel', order: 26, label: () => '免费 API 池' },
          (props) => React.createElement(Panel, props))
      })
    }

    // 'modelDirectories' is the host's model-selection service; declaring it here is what
    // makes ctx.modelDirectories available inside apply().
    module.exports = { name: NS, inject: ['slots', 'modelDirectories'], apply }
    return module.exports
  },
})
