/**
 * dsh-free-api-pool — browser half (plain JS, no build step).
 *
 * A「免费 API 池」button at `conversation.input.left` opens a dashboard in
 * `conversation.input.overlay` with four views:
 *
 *  - 概览   quota per platform: remaining / used, plus per-window rate limits where the
 *           platform publishes them (Groq, GitHub) and "需控制台" where it does not,
 *  - 免费模型 OpenRouter `:free` and OpenCode `-free` models, re-probed on demand,
 *  - 密钥   add a key (base URL + label + key → model IDs fetched automatically), remove,
 *           export the whole vault as JSON,
 *  - 平台   every vendor with its free-tier kind and a button that opens the apply page.
 *
 * Design language: Doubao dashboard tokens — #0065fd primary, 19.2px radius, 3.84px
 * spacing unit, border-led separation with no drop shadows, tabular numerals. Surfaces
 * read the harness theme so the panel stays legible in dark mode; the accent is
 * plugin-owned because the app's brand token resolves to near-black in Desktop.
 *
 * Secrets never reach this half: the host reports a masked form and only the explicit
 * export route returns raw keys.
 */
window.__ModuleLoader__.load({
  id: 'dsh-free-api-pool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const NS = 'dsh-free-api-pool'

    const R = {
      providers: '/dsh-free-pool/providers',
      quota: '/dsh-free-pool/quota',
      freeModels: '/dsh-free-pool/free-models',
      models: '/dsh-free-pool/models',
      add: '/dsh-free-pool/vault/add',
      remove: '/dsh-free-pool/vault/remove',
      exportVault: '/dsh-free-pool/vault/export',
      checkin: '/dsh-free-pool/checkin',
      checkinAll: '/dsh-free-pool/checkin-all',
    }

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

    const PlusIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M12 5v14' }),
      React.createElement('path', { d: 'M5 12h14' }))

    const TrashIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M3 6h18' }),
      React.createElement('path', { d: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2' }),
      React.createElement('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }))

    const CheckIcon = (p) => React.createElement(Icon, { className: p.className },
      React.createElement('path', { d: 'M20 6 9 17l-5-5' }))

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

    // 限免 vs 长期免费, the distinction the user asked to see on every model.
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

    function openApply(url) {
      if (!url) return
      window.open(url, '_blank', 'noopener,noreferrer')
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

    // ── small building blocks ──────────────────────────────────────────────

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

    function FreeChip(props) {
      const kind = props.kind || 'unknown'
      return React.createElement('span', { className: 'dfp-free ' + (FREE_KIND_CLASS[kind] || FREE_KIND_CLASS.unknown) },
        FREE_KIND_LABEL[kind] || FREE_KIND_LABEL.unknown)
    }

    // ── 概览: platform quota ───────────────────────────────────────────────

    function QuotaRow(props) {
      const p = props.provider
      const q = p.quota || {}
      const windows = Array.isArray(q.windows) ? q.windows : []
      return React.createElement('div', { className: 'dfp-row' },
        React.createElement('div', { className: 'dfp-row-head' },
          React.createElement('span', { className: 'dfp-name' }, p.name),
          React.createElement('span', { className: 'dfp-vendor' }, p.vendor),
          React.createElement('span', { className: 'dfp-chip dfp-chip-' + (q.state || 'console') },
            STATE_LABEL[q.state] || q.state || '未知'),
          NATURE_LABEL[q.nature]
            ? React.createElement('span', { className: 'dfp-nature' }, NATURE_LABEL[q.nature])
            : null,
          React.createElement(FreeChip, { kind: p.freeKind }),
          p.keyCount > 0
            ? React.createElement('span', { className: 'dfp-chip dfp-callable' }, p.keyCount + ' 个 Key')
            : null,
          React.createElement('span', { className: 'dfp-spacer' }),
          p.checkin
            ? React.createElement('button', {
              type: 'button',
              className: 'dfp-mini',
              disabled: props.busy === p.slug,
              onClick: () => props.onCheckin(p),
            }, props.busy === p.slug ? '签到中…' : '签到')
            : null,
          React.createElement('button', {
            type: 'button',
            className: 'dfp-mini',
            onClick: () => openApply(p.applyUrl),
            title: '在浏览器打开申请页：' + (p.applyUrl || ''),
          }, '申请 Key'),
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
          React.createElement('div', { className: 'dfp-metric' },
            React.createElement('span', { className: 'dfp-metric-k' }, '剩余总量'),
            React.createElement('span', { className: 'dfp-metric-v dfp-strong' },
              q.totalRemaining === null || q.totalRemaining === undefined ? '—' : money(q.totalRemaining, q.currency))),
          React.createElement('div', { className: 'dfp-metric' },
            React.createElement('span', { className: 'dfp-metric-k' }, '今日剩余'),
            React.createElement('span', { className: 'dfp-metric-v' },
              q.todayRemaining === null || q.todayRemaining === undefined ? '—' : money(q.todayRemaining, q.todayCurrency || q.currency))),
          React.createElement('div', { className: 'dfp-metric' },
            React.createElement('span', { className: 'dfp-metric-k' }, '已用'),
            React.createElement('span', { className: 'dfp-metric-v' },
              q.used === null || q.used === undefined ? '—' : money(q.used, q.currency))),
          React.createElement('div', { className: 'dfp-metric' },
            React.createElement('span', { className: 'dfp-metric-k' }, '今日已用'),
            React.createElement('span', { className: 'dfp-metric-v' },
              q.todayUsed === null || q.todayUsed === undefined ? '—' : money(q.todayUsed, q.todayCurrency || q.currency)))),

        windows.length > 0
          ? React.createElement('div', { className: 'dfp-windows' },
            windows.map((w, i) => React.createElement('div', { className: 'dfp-window', key: i },
              React.createElement('span', { className: 'dfp-window-k' }, w.label),
              React.createElement('span', { className: 'dfp-window-v' },
                (w.remaining === null ? '—' : Number(w.remaining).toLocaleString('zh-CN'))
                + ' / '
                + (w.limit === null ? '—' : Number(w.limit).toLocaleString('zh-CN'))),
              w.reset
                ? React.createElement('span', { className: 'dfp-window-reset' }, w.reset + ' 后重置')
                : null)))
          : null,

        q.detail ? React.createElement('div', { className: 'dfp-detail' }, q.detail) : null,
        props.note ? React.createElement('div', { className: 'dfp-note' }, props.note) : null)
    }

    function Overview(props) {
      const { providers, loading, busy, onCheckin, onAdd, notes, error } = props
      const [filter, setFilter] = React.useState('all')
      const measured = providers.filter((p) => (p.quota || {}).state === 'ok').length
      const ready = providers.filter((p) => p.keyCount > 0).length
      const checkinable = providers.filter((p) => p.checkin).length

      const shown = providers.filter((p) => {
        const st = (p.quota || {}).state
        if (filter === 'ok') return st === 'ok'
        if (filter === 'keyed') return p.keyCount > 0
        if (filter === 'issue') return st === 'error' || st === 'nokey'
        return true
      })

      const FILTERS = [
        { id: 'all', label: '全部' },
        { id: 'ok', label: '已测额度' },
        { id: 'keyed', label: '已配置' },
        { id: 'issue', label: '待处理' },
      ]

      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-summary' },
          React.createElement(Stat, { label: '平台', value: String(providers.length) }),
          React.createElement(Stat, { label: '已配置 Key', value: String(ready) }),
          React.createElement(Stat, { label: '已测到额度', value: String(measured) }),
          React.createElement(Stat, { label: '可签到', value: String(checkinable) })),

        React.createElement('div', { className: 'dfp-filters' },
          FILTERS.map((f) => React.createElement('button', {
            key: f.id,
            type: 'button',
            className: 'dfp-filter' + (filter === f.id ? ' dfp-filter-on' : ''),
            onClick: () => setFilter(f.id),
          }, f.label)),
          React.createElement('span', { className: 'dfp-spacer' }),
          React.createElement('span', { className: 'dfp-hint' }, 'Key 只存在本机，面板只显示掩码')),

        error
          ? React.createElement('div', { className: 'dfp-alert' },
            React.createElement(AlertIcon, { className: 'dfp-alert-icon' }),
            React.createElement('span', null, error))
          : null,

        React.createElement('div', { className: 'dfp-list' },
          shown.length === 0
            ? React.createElement('div', { className: 'dfp-empty' },
              loading ? '正在查询各平台额度…' : '这里没有符合条件的平台')
            : shown.map((p) => React.createElement(QuotaRow, {
              key: p.slug,
              provider: p,
              busy,
              note: notes[p.slug],
              onCheckin,
              onAdd,
            }))))
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
                React.createElement('span', { className: 'dfp-chip dfp-callable' }, models.length + ' 个免费'),
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
                        ? React.createElement('span', { className: 'dfp-model-ctx' },
                          Math.round(m.context / 1000) + 'K')
                        : null)))))
          })))
    }

    // ── 密钥 ───────────────────────────────────────────────────────────────

    function Vault(props) {
      const { providers, onChanged } = props
      const [slug, setSlug] = React.useState('')
      const [label, setLabel] = React.useState('')
      const [baseUrl, setBaseUrl] = React.useState('')
      const [key, setKey] = React.useState('')
      const [models, setModels] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [ok, setOk] = React.useState('')

      const known = providers.filter((p) => p.category !== 'relay' || p.probe === 'billing')
      const selected = providers.find((p) => p.slug === slug)

      React.useEffect(() => {
        if (selected !== undefined && baseUrl === '') setBaseUrl(selected.baseUrl || '')
      }, [slug])

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
        api(R.add, { slug, label, baseUrl, key }).then(() => {
          setOk('已保存，Key 只写在本机 vault.json')
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

      const exportAll = () => {
        setError('')
        setOk('')
        api(R.exportVault, {}).then((data) => {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'dsh-free-api-keys-' + new Date().toISOString().slice(0, 10) + '.json'
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setOk('已导出 ' + data.count + ' 条密钥（请妥善保管）')
        }).catch((err) => setError(err && err.message ? err.message : String(err)))
      }

      const withKeys = providers.filter((p) => p.keyCount > 0)

      return React.createElement('div', { className: 'dfp-view' },
        React.createElement('div', { className: 'dfp-card' },
          React.createElement('div', { className: 'dfp-card-title' },
            React.createElement(PlusIcon, { className: 'dfp-card-icon' }),
            '添加密钥'),
          React.createElement('div', { className: 'dfp-card-sub' },
            '选平台 → 填 Key → 自动读取该平台的模型 ID → 保存。大厂平台已内置 Base URL，无需手填。'),

          React.createElement('div', { className: 'dfp-form' },
            React.createElement(Field, { label: '平台' },
              React.createElement('select', {
                className: 'dfp-input',
                value: slug,
                onChange: (e) => {
                  setSlug(e.target.value)
                  setModels(null)
                  const hit = providers.find((p) => p.slug === e.target.value)
                  setBaseUrl(hit ? hit.baseUrl : '')
                },
              },
                React.createElement('option', { value: '' }, '— 选择平台 —'),
                known.map((p) => React.createElement('option', { key: p.slug, value: p.slug },
                  p.name + '（' + (FREE_KIND_LABEL[p.freeKind] || '') + '）')))),
            React.createElement(Field, {
              label: '备注名',
              hint: '用于区分多个 Key，例如「主号」「小号」',
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
              busy === 'discover' ? '读取中…' : '读取模型 ID'),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn dfp-btn-primary',
              onClick: save,
              disabled: busy !== '' || slug === '' || key === '',
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
                    const text = models.models.join('\n')
                    if (navigator.clipboard) navigator.clipboard.writeText(text)
                  },
                }, '复制全部')),
              React.createElement('div', { className: 'dfp-model-grid' },
                models.models.map((id) => React.createElement('span', { className: 'dfp-model-pill', key: id }, id))))
            : null),

        React.createElement('div', { className: 'dfp-card' },
          React.createElement('div', { className: 'dfp-card-title' },
            React.createElement(KeyIcon, { className: 'dfp-card-icon' }),
            '已保存的密钥',
            React.createElement('span', { className: 'dfp-spacer' }),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn',
              onClick: exportAll,
              disabled: withKeys.length === 0,
            },
              React.createElement(DownloadIcon, { className: 'dfp-btn-icon' }),
              '导出全部')),
          React.createElement('div', { className: 'dfp-card-sub' },
            '密钥存放在本机 data/vault.json，不会上传，也不会回传到浏览器（此处只显示掩码）。'),
          withKeys.length === 0
            ? React.createElement('div', { className: 'dfp-empty' }, '还没有添加任何密钥')
            : React.createElement('div', { className: 'dfp-key-list' },
              withKeys.map((p) => React.createElement('div', { className: 'dfp-key-group', key: p.slug },
                React.createElement('div', { className: 'dfp-key-group-head' },
                  React.createElement('span', { className: 'dfp-name' }, p.name),
                  React.createElement('span', { className: 'dfp-vendor' }, p.vendor),
                  React.createElement('span', { className: 'dfp-spacer' }),
                  React.createElement('span', { className: 'dfp-hint' }, p.keyCount + ' 条')),
                (p.keys || []).map((k) => React.createElement('div', { className: 'dfp-key', key: k.id },
                  React.createElement('span', { className: 'dfp-key-label' }, k.label),
                  React.createElement('span', { className: 'dfp-key-mask dfp-mono' }, k.masked),
                  React.createElement('span', { className: 'dfp-key-url dfp-mono' }, hostOf(k.baseUrl)),
                  React.createElement('span', { className: 'dfp-spacer' }),
                  React.createElement('button', {
                    type: 'button',
                    className: 'dfp-icon-btn',
                    title: '删除这条 Key',
                    onClick: () => remove(k.id),
                  }, React.createElement(TrashIcon, { className: 'dfp-close' })))))))))
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
      const shown = providers.filter((p) => kind === 'all' || p.freeKind === kind)
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
                React.createElement(FreeChip, { kind: p.freeKind })),
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
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notes, setNotes] = React.useState({})
      const [quotaAt, setQuotaAt] = React.useState(0)
      const [freeData, setFreeData] = React.useState(null)
      const [freeLoading, setFreeLoading] = React.useState(false)
      const [pendingSlug, setPendingSlug] = React.useState('')

      const loadProviders = React.useCallback(() => {
        return api(R.providers).then((data) => {
          setProviders(data.providers || [])
        }).catch((err) => {
          setError(err && err.message ? err.message : String(err))
        })
      }, [])

      const loadQuota = React.useCallback(() => {
        setLoading(true)
        setError('')
        return api(R.quota).then((data) => {
          setProviders(data.providers || [])
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
        setPendingSlug(provider.slug)
        setTab('vault')
      }

      const TABS = [
        { id: 'overview', label: '概览', icon: GridIcon },
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
        React.createElement('div', { className: 'dfp-panel', role: 'dialog', 'aria-label': '免费 API 池' },
          React.createElement('div', { className: 'dfp-head' },
            React.createElement('div', { className: 'dfp-brand' },
              React.createElement('span', { className: 'dfp-brand-mark' }, React.createElement(GiftIcon, { className: 'dfp-brand-icon' })),
              React.createElement('div', { className: 'dfp-head-text' },
                React.createElement('div', { className: 'dfp-title' }, '免费 API 池'),
                React.createElement('div', { className: 'dfp-sub' },
                  providers.length + ' 个平台',
                  quotaAt > 0 ? ' · 额度更新于 ' + new Date(quotaAt).toLocaleTimeString('zh-CN') : ''))),
            React.createElement('span', { className: 'dfp-spacer' }),
            React.createElement('button', {
              type: 'button',
              className: 'dfp-btn dfp-btn-primary',
              onClick: loadQuota,
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
                providers, loading, busy, notes, error,
                onCheckin, onAdd,
              })
              : null,
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
                onChanged: () => {
                  loadProviders()
                  loadQuota()
                },
                focusSlug: pendingSlug,
              })
              : null,
            tab === 'catalog'
              ? React.createElement(Catalog, { providers })
              : null),

          React.createElement('div', { className: 'dfp-foot' },
            '额度只显示平台真实提供的数字；「需控制台」表示该平台没有余额接口。密钥仅保存在本机 data/vault.json，不会上传到任何服务器。')))
    }

    // ── styles ─────────────────────────────────────────────────────────────
    //
    // Doubao dashboard tokens: #0065fd accent, 19.2px radius, 3.84px spacing unit,
    // border-led separation (shadow tokens resolve to 0 in that system).

    const STYLES = `
.dfp-trigger, .dfp-panel {
  --db-primary: #0065fd;
  --db-ring: #557fff;
  --db-radius: 19.2px;
  --db-radius-sm: 12px;
  --db-sp: 3.84px;
  --db-bg: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff));
  --db-fg: var(--dsw-alias-label-primary, #0e1115);
  --db-fg2: var(--dsw-alias-label-secondary, #5b6470);
  --db-border: var(--dsw-alias-border-l1, #e7eaef);
  --db-muted: var(--dsw-alias-bg-layer-2, #eff1f4);
  --db-accent-soft: rgba(0,101,253,.10);
  --db-green: #10b981;
  --db-amber: #d99a2b;
  --db-red: #ef4444;
}
.dfp-trigger { display: inline-flex; align-items: center; gap: calc(var(--db-sp) * 2); height: 28px; padding: 0 calc(var(--db-sp) * 2.5) 0 calc(var(--db-sp) * 2); border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3)); background: transparent; color: var(--dsw-alias-label-secondary, #888); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }
.dfp-trigger:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary, #eee); }
.dfp-trigger.dfp-open { border-color: var(--db-primary); color: var(--dsw-alias-label-primary, #eee); }
.dfp-trigger:focus-visible { outline: 2px solid var(--db-ring); outline-offset: 1px; }
.dfp-trigger-icon { width: 14px; height: 14px; flex: none; }
.dfp-trigger-label { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfp-trigger-count { flex: none; min-width: 18px; height: 16px; padding: 0 5px; border-radius: 8px; background: var(--db-muted); color: var(--dsw-alias-label-secondary, #888); font-size: 10px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.dfp-trigger.dfp-open .dfp-trigger-count { background: var(--db-primary); color: #fff; }

.dfp-backdrop { position: fixed; inset: 0; z-index: 200; background: rgba(9,12,18,.5); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; padding: calc(var(--db-sp) * 6); box-sizing: border-box; }
.dfp-panel { box-sizing: border-box; width: 860px; max-width: calc(100vw - 48px); height: min(88vh, 880px); display: flex; flex-direction: column; background: var(--db-bg); border: 1px solid var(--db-border); border-radius: var(--db-radius); padding: calc(var(--db-sp) * 4); color: var(--db-fg); font-family: inherit; font-size: 13px; line-height: 1.5; text-align: left; }

.dfp-head { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); }
.dfp-brand { display: flex; align-items: center; gap: calc(var(--db-sp) * 2.5); min-width: 0; }
.dfp-brand-mark { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 9px; background: var(--db-primary); color: #fff; flex: none; }
.dfp-brand-icon { width: 16px; height: 16px; }
.dfp-head-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dfp-title { font-weight: 600; font-size: 14px; letter-spacing: -.01em; }
.dfp-sub { color: var(--db-fg2); font-size: 11px; font-variant-numeric: tabular-nums; }
.dfp-spacer { flex: 1 1 auto; }

.dfp-btn { display: inline-flex; align-items: center; gap: calc(var(--db-sp) * 1.5); height: 30px; padding: 0 calc(var(--db-sp) * 3); border-radius: 15px; border: 1px solid var(--db-border); background: var(--db-muted); color: var(--db-fg); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; transition: border-color 120ms ease, background 120ms ease, color 120ms ease; white-space: nowrap; }
.dfp-btn:hover:not(:disabled) { border-color: var(--db-primary); color: var(--db-primary); }
.dfp-btn:disabled { opacity: .5; cursor: default; }
.dfp-btn-primary { background: var(--db-primary); border-color: var(--db-primary); color: #fff; }
.dfp-btn-primary:hover:not(:disabled) { filter: brightness(1.08); color: #fff; }
.dfp-btn-icon { width: 13px; height: 13px; flex: none; }
.dfp-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border-radius: 15px; border: 1px solid transparent; background: transparent; color: var(--db-fg2); cursor: pointer; }
.dfp-icon-btn:hover { background: var(--db-muted); color: var(--db-fg); }
.dfp-close { width: 15px; height: 15px; }

.dfp-tabs { display: flex; align-items: center; gap: calc(var(--db-sp) * 1); margin-top: calc(var(--db-sp) * 3.5); padding-bottom: calc(var(--db-sp) * 1); border-bottom: 1px solid var(--db-border); }
.dfp-tab { display: inline-flex; align-items: center; gap: calc(var(--db-sp) * 1.5); height: 30px; padding: 0 calc(var(--db-sp) * 3); border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--db-fg2); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; }
.dfp-tab:hover { background: var(--db-muted); color: var(--db-fg); }
.dfp-tab-on { background: var(--db-accent-soft); border-color: rgba(0,101,253,.28); color: var(--db-primary); font-weight: 600; }
.dfp-tab-icon { width: 14px; height: 14px; flex: none; }

.dfp-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.dfp-view { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; overflow-y: auto; padding-right: 2px; }

.dfp-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: calc(var(--db-sp) * 2); margin-top: calc(var(--db-sp) * 3.5); }
.dfp-stat { display: flex; flex-direction: column; gap: 2px; padding: calc(var(--db-sp) * 2.5); border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); background: var(--db-muted); }
.dfp-stat-v { font-size: 20px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.15; }
.dfp-stat-k { font-size: 11px; color: var(--db-fg2); }

.dfp-filters { display: flex; align-items: center; gap: calc(var(--db-sp) * 1.5); margin-top: calc(var(--db-sp) * 3); }
.dfp-filter { height: 26px; padding: 0 calc(var(--db-sp) * 2.5); border-radius: 13px; border: 1px solid var(--db-border); background: transparent; color: var(--db-fg2); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1; }
.dfp-filter:hover { color: var(--db-fg); }
.dfp-filter-on { background: var(--db-primary); border-color: var(--db-primary); color: #fff; }
.dfp-hint { font-size: 11px; color: var(--db-fg2); }

.dfp-alert, .dfp-ok { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); margin-top: calc(var(--db-sp) * 2.5); padding: calc(var(--db-sp) * 2.5); border-radius: var(--db-radius-sm); font-size: 12px; }
.dfp-alert { border: 1px solid rgba(239,68,68,.35); background: rgba(239,68,68,.08); color: var(--db-fg); }
.dfp-ok { border: 1px solid rgba(16,185,129,.35); background: rgba(16,185,129,.08); color: var(--db-fg); }
.dfp-alert-icon { width: 15px; height: 15px; flex: none; color: var(--db-primary); }
.dfp-alert .dfp-alert-icon { color: var(--db-red); }
.dfp-ok .dfp-alert-icon { color: var(--db-green); }

.dfp-list { flex: 1 1 auto; overflow-y: auto; margin-top: calc(var(--db-sp) * 2.5); display: flex; flex-direction: column; gap: calc(var(--db-sp) * 2); padding-right: 2px; min-height: 0; }
.dfp-empty { padding: calc(var(--db-sp) * 6); text-align: center; color: var(--db-fg2); font-size: 12px; border: 1px dashed var(--db-border); border-radius: var(--db-radius-sm); }

.dfp-row { padding: calc(var(--db-sp) * 3); border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); background: transparent; transition: border-color 120ms ease; }
.dfp-row:hover { border-color: rgba(0,101,253,.35); }
.dfp-row-head { display: flex; align-items: center; gap: calc(var(--db-sp) * 1.5); flex-wrap: wrap; }
.dfp-name { font-weight: 600; font-size: 13px; }
.dfp-vendor { font-size: 11px; color: var(--db-fg2); }
.dfp-chip { padding: 1px 7px; border-radius: 9px; border: 1px solid var(--db-border); font-size: 10px; line-height: 15px; color: var(--db-fg2); white-space: nowrap; }
.dfp-chip-ok { border-color: rgba(0,101,253,.45); color: var(--db-primary); background: var(--db-accent-soft); }
.dfp-chip-console { border-color: var(--db-border); }
.dfp-chip-nokey { border-color: rgba(217,154,43,.5); color: var(--db-amber); }
.dfp-chip-error { border-color: rgba(239,68,68,.5); color: var(--db-red); }
.dfp-callable { border-color: rgba(16,185,129,.45); color: var(--db-green); }
.dfp-nature { padding: 1px 6px; border-radius: 9px; background: var(--db-muted); font-size: 10px; line-height: 15px; color: var(--db-fg2); white-space: nowrap; }

.dfp-free { padding: 1px 7px; border-radius: 9px; font-size: 10px; line-height: 15px; white-space: nowrap; border: 1px solid transparent; }
.dfp-free-long { background: rgba(16,185,129,.12); color: var(--db-green); border-color: rgba(16,185,129,.35); }
.dfp-free-daily { background: var(--db-accent-soft); color: var(--db-primary); border-color: rgba(0,101,253,.35); }
.dfp-free-trial { background: rgba(217,154,43,.12); color: var(--db-amber); border-color: rgba(217,154,43,.35); }
.dfp-free-unknown { background: var(--db-muted); color: var(--db-fg2); border-color: var(--db-border); }

.dfp-mini { height: 22px; padding: 0 calc(var(--db-sp) * 2.5); border-radius: 11px; border: 1px solid var(--db-border); background: transparent; color: var(--db-fg); cursor: pointer; font-family: inherit; font-size: 11px; line-height: 1; white-space: nowrap; }
.dfp-mini:hover:not(:disabled) { border-color: var(--db-primary); color: var(--db-primary); }
.dfp-mini:disabled { opacity: .5; cursor: default; }
.dfp-mini-primary { border-color: rgba(0,101,253,.45); color: var(--db-primary); background: var(--db-accent-soft); }

.dfp-meta { display: flex; align-items: center; gap: calc(var(--db-sp) * 1.5); margin-top: calc(var(--db-sp) * 1.5); font-size: 11px; color: var(--db-fg2); flex-wrap: wrap; }
.dfp-host { font-family: var(--font-mono, ui-monospace, monospace); }
.dfp-sep { opacity: .5; }
.dfp-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: calc(var(--db-sp) * 2); margin-top: calc(var(--db-sp) * 2.5); }
.dfp-metric { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dfp-metric-k { font-size: 10px; color: var(--db-fg2); }
.dfp-metric-v { font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dfp-strong { font-weight: 600; color: var(--db-primary); }

.dfp-windows { display: flex; flex-wrap: wrap; gap: calc(var(--db-sp) * 2); margin-top: calc(var(--db-sp) * 2); }
.dfp-window { display: inline-flex; align-items: center; gap: calc(var(--db-sp) * 1.5); padding: 2px 8px; border: 1px solid var(--db-border); border-radius: 9px; background: var(--db-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.dfp-window-k { color: var(--db-fg2); }
.dfp-window-v { font-weight: 600; }
.dfp-window-reset { color: var(--db-fg2); font-size: 10px; }

.dfp-detail, .dfp-note { margin-top: calc(var(--db-sp) * 1.5); font-size: 11px; color: var(--db-fg2); }
.dfp-note { color: var(--db-primary); }

.dfp-fm-head { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); margin-top: calc(var(--db-sp) * 3); }
.dfp-fm-group { border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); padding: calc(var(--db-sp) * 2.5); }
.dfp-fm-group-head { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); flex-wrap: wrap; }
.dfp-fm-group-name { font-weight: 600; font-size: 13px; }
.dfp-model-grid { display: flex; flex-wrap: wrap; gap: calc(var(--db-sp) * 1.5); margin-top: calc(var(--db-sp) * 2); }
.dfp-model { display: inline-flex; align-items: center; gap: calc(var(--db-sp) * 1.5); padding: 3px 9px; border: 1px solid var(--db-border); border-radius: 10px; background: var(--db-muted); font-size: 11px; max-width: 100%; }
.dfp-model-id { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.dfp-model-meta { display: inline-flex; align-items: center; gap: calc(var(--db-sp) * 1); flex: none; }
.dfp-model-ctx { color: var(--db-fg2); font-size: 10px; font-variant-numeric: tabular-nums; }
.dfp-model-pill { padding: 2px 8px; border: 1px solid var(--db-border); border-radius: 9px; background: var(--db-muted); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }

.dfp-card { border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); padding: calc(var(--db-sp) * 3); margin-top: calc(var(--db-sp) * 3); }
.dfp-card:first-child { margin-top: calc(var(--db-sp) * 3); }
.dfp-card-title { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); font-weight: 600; font-size: 13px; }
.dfp-card-icon { width: 15px; height: 15px; flex: none; color: var(--db-primary); }
.dfp-card-sub { margin-top: calc(var(--db-sp) * 1); font-size: 11px; color: var(--db-fg2); }
.dfp-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(var(--db-sp) * 2.5); margin-top: calc(var(--db-sp) * 3); }
.dfp-field { display: flex; flex-direction: column; gap: calc(var(--db-sp) * 1); min-width: 0; }
.dfp-field-k { font-size: 11px; color: var(--db-fg2); }
.dfp-field-hint { font-size: 10px; color: var(--db-fg2); opacity: .8; }
.dfp-input { height: 32px; padding: 0 calc(var(--db-sp) * 2.5); border: 1px solid var(--db-border); border-radius: 10px; background: var(--db-bg); color: var(--db-fg); font-family: inherit; font-size: 12px; box-sizing: border-box; width: 100%; }
.dfp-input:focus { outline: none; border-color: var(--db-primary); box-shadow: 0 0 0 3px var(--db-accent-soft); }
.dfp-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
.dfp-form-actions { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); margin-top: calc(var(--db-sp) * 3); flex-wrap: wrap; }
.dfp-discovered { margin-top: calc(var(--db-sp) * 2.5); padding-top: calc(var(--db-sp) * 2.5); border-top: 1px solid var(--db-border); }
.dfp-discovered-head { display: flex; align-items: center; font-size: 11px; color: var(--db-fg2); }

.dfp-key-list { display: flex; flex-direction: column; gap: calc(var(--db-sp) * 2.5); margin-top: calc(var(--db-sp) * 2.5); }
.dfp-key-group { border: 1px solid var(--db-border); border-radius: 10px; padding: calc(var(--db-sp) * 2); }
.dfp-key-group-head { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); margin-bottom: calc(var(--db-sp) * 1.5); }
.dfp-key { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); padding: calc(var(--db-sp) * 1.5) 0; border-top: 1px dashed var(--db-border); font-size: 12px; }
.dfp-key-label { font-weight: 500; }
.dfp-key-mask { color: var(--db-fg2); }
.dfp-key-url { color: var(--db-fg2); font-size: 10px; }

.dfp-cat-row { display: flex; align-items: flex-start; gap: calc(var(--db-sp) * 3); padding: calc(var(--db-sp) * 3); border: 1px solid var(--db-border); border-radius: var(--db-radius-sm); }
.dfp-cat-row:hover { border-color: rgba(0,101,253,.35); }
.dfp-cat-main { flex: 1 1 auto; min-width: 0; }
.dfp-cat-title { display: flex; align-items: center; gap: calc(var(--db-sp) * 2); flex-wrap: wrap; }
.dfp-cat-note { margin-top: calc(var(--db-sp) * 1); font-size: 11px; color: var(--db-fg2); }
.dfp-cat-actions { display: flex; align-items: center; gap: calc(var(--db-sp) * 1.5); flex: none; }

.dfp-foot { margin-top: calc(var(--db-sp) * 3); padding-top: calc(var(--db-sp) * 2.5); border-top: 1px solid var(--db-border); font-size: 11px; color: var(--db-fg2); line-height: 1.6; }
`

    // ── plugin entry ───────────────────────────────────────────────────────

    function apply(ctx) {
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

      ctx.slots.inject('conversation.input.overlay', () => {
        return ctx.slots.register(
          { name: 'conversation.input.overlay', id: 'free-api-pool-panel', order: 26, label: () => '免费 API 池' },
          (props) => React.createElement(Panel, props))
      })
    }

    module.exports = { name: NS, inject: ['slots'], apply }
    return module.exports
  },
})
