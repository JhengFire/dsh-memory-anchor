/**
 * `dsh-memory-anchor` —— Client 半侧。
 *
 * 在设置页添加「记忆功能」分类：总开关 + 已存记忆分页列表。
 *
 * ## 关于组件定义位置（踩过的坑）
 *
 * 组件必须**在 apply 之前、且在 factory 内部**定义完成，
 * 让 `ctx.slots.register(options, Component)` 拿到真实函数。
 *
 * 早期版本把组件放在模块外层用 `let Section = null` 持有，
 * 在 apply 末尾才赋值 —— 但 register 在赋值之前就执行了，
 * 传进去的是 null，槽位静默不渲染，设置页看不到该分类。
 */
;(() => {
  'use strict'

  const ID = 'dsh-memory-anchor'
  const NS = 'memory-anchor'
  const SECTION_ID = 'memory-anchor'
  const SECTION_ORDER = 70
  const PAGE_SIZE = 10

  const zh = {
    title: '记忆功能',
    intro:
      '只记录代码里查不到的决策、被否决的方案和踩坑根因。关闭后不再写入新记忆，已有记录保留。',
    toggleLabel: '启用记忆功能',
    toggleHintOn: '正在记录与检索项目记忆',
    toggleHintOff: '已停止记录；检索与写入将被拒绝',
    listTitle: '已添加的记忆',
    empty: '还没有任何记忆。当一次决策被拍板、一个方案被否决、或一个坑找到根因时，可以让我记下来。',
    loading: '正在读取…',
    failed: '读取失败',
    retry: '重试',
    prev: '上一页',
    next: '下一页',
    pageInfo: (page, total) => `第 ${page} / ${total} 页`,
    totalInfo: (n) => `共 ${n} 条`,
    kindDecision: '决策',
    kindConstraint: '约束',
    kindGotcha: '踩坑',
    kindRejected: '否决',
    badges: { stale: '过期', superseded: '已取代', provisional: '待确认', unverifiable: '无验证' },
    verifyLabel: '验证',
    scopeLabel: '范围',
    globalScope: '全局',
  }

  const en = {
    title: 'Memory',
    intro:
      'Records the decisions, rejected approaches and root causes that code cannot describe. Turning it off stops new writes; existing records stay.',
    toggleLabel: 'Enable memory',
    toggleHintOn: 'Recording and recalling project memory',
    toggleHintOff: 'Stopped recording; recall and writes are refused',
    listTitle: 'Saved memories',
    empty:
      'No memories yet. When a decision is settled, an approach is rejected, or a root cause is found, I can record it.',
    loading: 'Loading…',
    failed: 'Could not load',
    retry: 'Retry',
    prev: 'Previous',
    next: 'Next',
    pageInfo: (page, total) => `Page ${page} of ${total}`,
    totalInfo: (n) => `${n} total`,
    kindDecision: 'Decision',
    kindConstraint: 'Constraint',
    kindGotcha: 'Gotcha',
    kindRejected: 'Rejected',
    badges: { stale: 'stale', superseded: 'superseded', provisional: 'unconfirmed', unverifiable: 'no verify' },
    verifyLabel: 'verify',
    scopeLabel: 'scope',
    globalScope: 'global',
  }

  const STYLE_ID = 'dsh-ma-style'

  const CSS = [
    '.dsh-memory-anchor-page{display:flex;flex-direction:column;gap:16px;max-width:680px;padding:4px 0 24px}',
    '.dsh-memory-anchor-intro{margin:0;line-height:1.6;font-size:13px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-switchRow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}',
    '.dsh-memory-anchor-switchText{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.dsh-memory-anchor-switchLabel{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
    '.dsh-memory-anchor-switchHint{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-switch{position:relative;flex:0 0 auto;width:44px;height:24px;padding:0;border:0;border-radius:12px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.2));cursor:pointer;transition:background .18s ease}',
    '.dsh-memory-anchor-switch[data-on="true"]{background:var(--dsw-alias-brand-primary,#3b6cff)}',
    '.dsh-memory-anchor-switch:disabled{opacity:.5;cursor:default}',
    '.dsh-memory-anchor-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b6cff);outline-offset:2px}',
    '.dsh-memory-anchor-knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .18s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}',
    '.dsh-memory-anchor-switch[data-on="true"] .dsh-memory-anchor-knob{transform:translateX(20px)}',
    '.dsh-memory-anchor-listHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
    '.dsh-memory-anchor-h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
    '.dsh-memory-anchor-total{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}',
    '.dsh-memory-anchor-item{display:flex;flex-direction:column;gap:5px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
    '.dsh-memory-anchor-item:last-child{border-bottom:0}',
    '.dsh-memory-anchor-itemTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.dsh-memory-anchor-kind{flex:0 0 auto;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:600;line-height:1.6;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}',
    '.dsh-memory-anchor-kind[data-k="decision"]{color:var(--dsw-alias-brand-primary,#3b6cff)}',
    '.dsh-memory-anchor-kind[data-k="constraint"]{color:var(--dsw-alias-link,#2b6cd4)}',
    '.dsh-memory-anchor-kind[data-k="gotcha"]{color:var(--dsw-alias-state-warn-primary,#b26a10)}',
    '.dsh-memory-anchor-kind[data-k="rejected"]{color:var(--dsw-alias-label-secondary,#5c6067)}',
    '.dsh-memory-anchor-id{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.dsh-memory-anchor-claim{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#1f2329);word-break:break-word}',
    '.dsh-memory-anchor-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-meta code{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.dsh-memory-anchor-badge{padding:1px 6px;border-radius:4px;font-size:11px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-state-error-primary,#c0392b)}',
    '.dsh-memory-anchor-badge[data-b="provisional"]{color:var(--dsw-alias-state-warn-primary,#a06a00)}',
    '.dsh-memory-anchor-badge[data-b="superseded"]{color:var(--dsw-alias-label-secondary,#5c6067)}',
    '.dsh-memory-anchor-pager{display:flex;align-items:center;justify-content:center;gap:12px}',
    '.dsh-memory-anchor-pagerBtn{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:12px;cursor:pointer}',
    '.dsh-memory-anchor-pagerBtn:disabled{opacity:.4;cursor:default}',
    '.dsh-memory-anchor-pageInfo{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);min-width:76px;text-align:center}',
    '.dsh-memory-anchor-state{padding:22px 14px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-error{padding:16px 14px;text-align:center;font-size:13px;color:var(--dsw-alias-state-error-primary,#d93026)}',
    '.dsh-memory-anchor-retry{margin-top:8px;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:12px;cursor:pointer}',
  ].join('')

  function installStyles() {
    if (typeof document === 'undefined') return () => {}
    if (document.getElementById(STYLE_ID) !== null) return () => {}
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = CSS
    document.head.appendChild(el)
    return () => {
      el.remove()
    }
  }

  /**
   * 模块工厂。DSH 客户端模块表提供 react。
   * @param {(id: string) => any} require
   */
  function createPlugin(require) {
    const react = require('react')
    const { useState, useEffect, useCallback, useRef, createElement: h } = react

    async function api(path, init) {
      const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return res.json()
    }

    /** 单条记忆。t 由 props 传入（框架按 register 的 locale 注入）。 */
    function MemoryRow(props) {
      const { item, t } = props
      const kindLabel =
        {
          decision: t('kindDecision'),
          constraint: t('kindConstraint'),
          gotcha: t('kindGotcha'),
          rejected: t('kindRejected'),
        }[item.kind] ?? item.kind

      const badges = []
      if (item.status === 'stale') badges.push(['stale', t('badges').stale])
      if (item.status === 'superseded') badges.push(['superseded', t('badges').superseded])
      if (item.stability === 'provisional') badges.push(['provisional', t('badges').provisional])
      if (!item.verify) badges.push(['unverifiable', t('badges').unverifiable])

      const scopeText =
        Array.isArray(item.scope) && item.scope.length > 0 ? item.scope.join(', ') : t('globalScope')

      const metas = []
      if (item.verify) {
        metas.push(h('span', { key: 'v' }, `${t('verifyLabel')}: `, h('code', null, item.verify)))
      }
      metas.push(h('span', { key: 's' }, `${t('scopeLabel')}: `, h('code', null, scopeText)))

      const top = [h('span', { key: 'k', className: 'dsh-memory-anchor-kind', 'data-k': item.kind }, kindLabel)]
      top.push(h('span', { key: 'id', className: 'dsh-memory-anchor-id' }, item.id))
      for (const [key, label] of badges) {
        top.push(h('span', { key, className: 'dsh-memory-anchor-badge', 'data-b': key }, label))
      }

      return h(
        'div',
        { className: 'dsh-memory-anchor-item' },
        h('div', { className: 'dsh-memory-anchor-itemTop' }, ...top),
        h('p', { className: 'dsh-memory-anchor-claim' }, item.claim),
        metas.length > 0 ? h('div', { className: 'dsh-memory-anchor-meta' }, ...metas) : null,
      )
    }

    /**
     * 设置页主体。
     *
     * t 来自 props —— 框架按 register 时声明的 `locale: NS` 注入，
     * 不要用 ctx.locale.bind 自己取：那个 ctx 在组件闭包里不是 apply 的上下文。
     */
    function Section(props) {
      const t = props.t ?? ((k) => k)

      const [enabled, setEnabled] = useState(false)
      const [toggling, setToggling] = useState(false)
      const [page, setPage] = useState(1)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(async (targetPage) => {
        setLoading(true)
        setError(null)
        try {
          const [state, list] = await Promise.all([
            api('/lwm/state'),
            api(`/lwm/list?page=${targetPage}&pageSize=${PAGE_SIZE}`),
          ])
          if (!alive.current) return
          setEnabled(Boolean(state.enabled))
          setData(list)
        } catch (err) {
          if (!alive.current) return
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      useEffect(() => {
        load(page)
      }, [page, load])

      const toggle = useCallback(async () => {
        if (toggling) return
        setToggling(true)
        try {
          const out = await api('/lwm/toggle', {
            method: 'POST',
            body: JSON.stringify({ enabled: !enabled }),
          })
          if (!alive.current) return
          setEnabled(Boolean(out.enabled))
        } catch (err) {
          if (!alive.current) return
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          if (alive.current) setToggling(false)
        }
      }, [enabled, toggling])

      const pageCount = data?.pageCount ?? 1
      const total = data?.total ?? 0
      const items = data?.items ?? []

      const switchNode = h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': enabled ? 'true' : 'false',
          'aria-label': t('toggleLabel'),
          className: 'dsh-memory-anchor-switch',
          'data-on': enabled ? 'true' : 'false',
          disabled: toggling || (loading && data === null),
          onClick: toggle,
        },
        h('span', { className: 'dsh-memory-anchor-knob' }),
      )

      const switchRow = h(
        'div',
        { className: 'dsh-memory-anchor-switchRow' },
        h(
          'div',
          { className: 'dsh-memory-anchor-switchText' },
          h('span', { className: 'dsh-memory-anchor-switchLabel' }, t('toggleLabel')),
          h('span', { className: 'dsh-memory-anchor-switchHint' }, enabled ? t('toggleHintOn') : t('toggleHintOff')),
        ),
        switchNode,
      )

      let body
      if (error !== null) {
        body = h(
          'div',
          { className: 'dsh-memory-anchor-error' },
          `${t('failed')}: ${error}`,
          h(
            'div',
            null,
            h(
              'button',
              { type: 'button', className: 'dsh-memory-anchor-retry', onClick: () => load(page) },
              t('retry'),
            ),
          ),
        )
      } else if (loading && data === null) {
        body = h('div', { className: 'dsh-memory-anchor-state' }, t('loading'))
      } else if (items.length === 0) {
        body = h('div', { className: 'dsh-memory-anchor-state' }, t('empty'))
      } else {
        body = items.map((m) => h(MemoryRow, { key: m.id, item: m, t }))
      }

      const pager =
        total > PAGE_SIZE
          ? h(
              'div',
              { className: 'dsh-memory-anchor-pager' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-memory-anchor-pagerBtn',
                  disabled: page <= 1 || loading,
                  onClick: () => setPage((p) => Math.max(1, p - 1)),
                },
                t('prev'),
              ),
              h('span', { className: 'dsh-memory-anchor-pageInfo' }, t('pageInfo')(page, pageCount)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-memory-anchor-pagerBtn',
                  disabled: page >= pageCount || loading,
                  onClick: () => setPage((p) => Math.min(pageCount, p + 1)),
                },
                t('next'),
              ),
            )
          : null

      return h(
        'div',
        { className: 'dsh-memory-anchor-page' },
        h('p', { className: 'dsh-memory-anchor-intro' }, t('intro')),
        switchRow,
        h(
          'div',
          { className: 'dsh-memory-anchor-listHead' },
          h('h3', { className: 'dsh-memory-anchor-h3' }, t('listTitle')),
          h('span', { className: 'dsh-memory-anchor-total' }, t('totalInfo')(total)),
        ),
        h('div', { className: 'dsh-memory-anchor-list' }, body),
        pager,
      )
    }

    /** 设置页导航图标：三条逐渐变淡的横线，象征记忆会衰减。 */
    function SectionIcon(props) {
      const size = props?.size ?? 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 2, y: 3, width: 9, height: 1.8, rx: 0.9, fill: 'currentColor' }),
        h('rect', { x: 2, y: 7, width: 12, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.62 }),
        h('rect', { x: 2, y: 11, width: 6, height: 1.8, rx: 0.9, fill: 'currentColor', opacity: 0.34 }),
      )
    }

    /**
     * apply 在 createPlugin 内定义，因此 Section / SectionIcon
     * 在 register 被调用时**已经是确定的函数**。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lwm: dictionaries')
      ctx.effect(() => installStyles(), 'lwm: stylesheet')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => ctx.locale.bind(NS)('title'),
            locale: NS,
          },
          Section,
        ),
      )

      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register(
          {
            name: 'settings.section.icon',
            id: SECTION_ID,
            order: SECTION_ORDER,
            locale: NS,
          },
          SectionIcon,
        ),
      )
    }

    return { Section, SectionIcon, apply, inject: ['slots', 'locale'] }
  }

  try {
    if (typeof window !== 'undefined' && window.__ModuleLoader__) {
      window.__ModuleLoader__.load({ id: ID, factory: createPlugin })
    } else if (typeof module !== 'undefined' && module && 'exports' in module) {
      module.exports = { createPlugin }
    }
  } catch {
    /* 无模块环境时静默 */
  }
})()