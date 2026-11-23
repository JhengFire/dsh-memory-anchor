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
    title: '记忆锚点',
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
    // ---- 向量模型（可选）----
    embeddingTitle: '向量模型（可选）',
    embeddingOff: '未启用 · 使用本地向量',
    embeddingOn: '已启用',
    embeddingDesc:
      '启用后，写入记忆时会调用所选服务的接口生成语义向量，检索能理解同义表达和跨语言。' +
      '不启用则使用本地哈希向量：零依赖、可离线，但只认字面。',
    embeddingNone: '不启用（本地向量）',
    embeddingProvider: '服务商',
    embeddingApiUrl: 'API 地址',
    embeddingModel: '模型',
    embeddingDimensions: '向量维度',
    embeddingDimensionsHint: '1024 与 2048 的检索效果实测接近，1024 占用更小。',
    embeddingApiKey: 'API Key',
    embeddingKeyPlaceholder: '粘贴你的 API Key',
    embeddingKeySet: (tail) => `已保存（末四位 ${tail}），留空则不修改`,
    embeddingReindexNote:
      '切换向量模型后，已有记忆仍是旧模型生成的向量。运行 memory 工具的 reindex 可批量重算；' +
      '在此之前，跨模型的条目会被降权而不是消失。',
    embeddingTestOk: (ms, dim) => `连接成功 · ${ms}ms · ${dim} 维`,
    embeddingTestFail: (msg) => `连接失败：${msg}`,
    embeddingSaved: '已保存',
    embeddingSavedMemoryOnly: '已应用，但未能写入配置文件（重启后会恢复）',
    testConnection: '测试连接',
    testing: '测试中…',
    save: '保存',
    show: '显示',
    hide: '隐藏',
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
    // ---- embedding model (optional) ----
    embeddingTitle: 'Embedding model (optional)',
    embeddingOff: 'Off — using local vectors',
    embeddingOn: 'Enabled',
    embeddingDesc:
      'When enabled, writing a memory calls the selected service to produce a semantic vector, ' +
      'so retrieval understands paraphrases and other languages. When off, a local character-hash ' +
      'vector is used: no dependencies and works offline, but it matches surface form only.',
    embeddingNone: 'Off (local vectors)',
    embeddingProvider: 'Provider',
    embeddingApiUrl: 'API URL',
    embeddingModel: 'Model',
    embeddingDimensions: 'Dimensions',
    embeddingDimensionsHint: '1024 and 2048 retrieve about equally well in testing; 1024 stores less.',
    embeddingApiKey: 'API key',
    embeddingKeyPlaceholder: 'Paste your API key',
    embeddingKeySet: (tail) => `Saved (ends ${tail}); leave blank to keep it`,
    embeddingReindexNote:
      'After switching models, existing memories still hold vectors from the old one. Run the ' +
      'memory tool with action=reindex to recompute them; until then, cross-model entries are ' +
      'down-weighted rather than dropped.',
    embeddingTestOk: (ms, dim) => `Connected · ${ms}ms · ${dim} dims`,
    embeddingTestFail: (msg) => `Connection failed: ${msg}`,
    embeddingSaved: 'Saved',
    embeddingSavedMemoryOnly: 'Applied, but the config file was not written (reverts on restart)',
    testConnection: 'Test connection',
    testing: 'Testing…',
    save: 'Save',
    show: 'Show',
    hide: 'Hide',
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
    '.dsh-memory-anchor-embed{margin:12px 0 4px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:8px;overflow:hidden}',
    '.dsh-memory-anchor-embedToggle{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#fff);border:0;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#1d2129);text-align:left}',
    '.dsh-memory-anchor-embedToggle:hover{background:var(--dsw-alias-bg-layer-2,#f7f8fa)}',
    '.dsh-memory-anchor-embedTitle{font-weight:500}',
    '.dsh-memory-anchor-embedHint{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-embedBody{padding:0 12px 12px;border-top:1px solid var(--dsw-alias-border-l2,#e5e6eb)}',
    '.dsh-memory-anchor-embedDesc{margin:10px 0 12px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-embedNote{margin:12px 0 0;padding:8px 10px;font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-radius:6px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-embedFields{display:flex;flex-direction:column;gap:10px;margin-top:10px}',
    '.dsh-memory-anchor-field{display:flex;flex-direction:column;gap:4px}',
    '.dsh-memory-anchor-fieldLabel{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}',
    '.dsh-memory-anchor-fieldHint{font-size:11px;color:var(--dsw-alias-label-secondary,#646a73);opacity:.8}',
    '.dsh-memory-anchor-input{padding:6px 8px;font-size:13px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1d2129);font-family:inherit}',
    '.dsh-memory-anchor-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#3370ff);outline-offset:-1px}',
    '.dsh-memory-anchor-keyRow{display:flex;gap:6px}',
    '.dsh-memory-anchor-keyRow .dsh-memory-anchor-input{flex:1;min-width:0}',
    '.dsh-memory-anchor-keyToggle{padding:6px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-link,#3370ff);cursor:pointer;white-space:nowrap}',
    '.dsh-memory-anchor-embedActions{display:flex;gap:8px;margin-top:12px}',
    '.dsh-memory-anchor-btn{padding:6px 14px;font-size:13px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1d2129);cursor:pointer}',
    '.dsh-memory-anchor-btn:disabled{opacity:.6;cursor:default}',
    '.dsh-memory-anchor-btnPrimary{background:var(--dsw-alias-brand-primary,#3370ff);border-color:var(--dsw-alias-brand-primary,#3370ff);color:#fff}',
    '.dsh-memory-anchor-ok{margin-top:10px;padding:8px 10px;font-size:12px;line-height:1.6;border-radius:6px;background:rgba(52,199,89,.12);color:var(--dsw-alias-label-primary,#1d2129)}',
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
        h(EmbeddingPanel, { t }),
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


    /**
     * 向量模型配置面板。
     *
     * 设计取舍：默认折叠。绝大多数用户不需要配置——不配就用本地哈希向量，
     * 插件照常可用。把可选配置摊开会让首次进入的人以为「必须填」。
     */
    function EmbeddingPanel(props) {
      const t = props.t ?? ((k) => k)

      // 必须声明在其它 hook 之前：useCallback 的函数体会引用它，
      // 若在其后声明会触发 TDZ，整个设置页会白屏。
      const aliveRef = useRef(true)
      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      const [open, setOpen] = useState(false)
      const [loaded, setLoaded] = useState(false)
      const [providers, setProviders] = useState([])
      const [provider, setProvider] = useState('')
      const [apiUrl, setApiUrl] = useState('')
      const [modelName, setModelName] = useState('')
      const [dimensions, setDimensions] = useState(1024)
      const [apiKey, setApiKey] = useState('')
      const [showKey, setShowKey] = useState(false)
      const [hasKey, setHasKey] = useState(false)
      const [keyTail, setKeyTail] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)

      const load = useCallback(async () => {
        try {
          const d = await api('/lwm/embedding')
          if (!aliveRef.current) return
          setProviders(d.providers ?? [])
          setProvider(d.provider ?? '')
          setApiUrl(d.apiUrl ?? '')
          setModelName(d.modelName ?? '')
          setDimensions(d.dimensions ?? 1024)
          setHasKey(Boolean(d.hasApiKey))
          setKeyTail(d.apiKeyTail ?? '')
          setLoaded(true)
        } catch (e) {
          if (aliveRef.current) setResult({ ok: false, error: String(e.message ?? e) })
        }
      }, [])


      useEffect(() => {
        if (open && !loaded) load()
      }, [open, loaded, load])

      const current = providers.find((p) => p.id === provider) ?? null

      async function onTest() {
        setBusy(true)
        setResult(null)
        try {
          const r = await api('/lwm/embedding/test', {
            method: 'POST',
            body: { provider, apiUrl, modelName, dimensions, apiKey },
          })
          setResult(r)
        } catch (e) {
          setResult({ ok: false, error: String(e.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      async function onSave() {
        setBusy(true)
        setResult(null)
        try {
          const r = await api('/lwm/embedding', {
            method: 'POST',
            body: { provider, apiUrl, modelName, dimensions, apiKey },
          })
          setResult({ ok: true, saved: true, persisted: r.persisted })
          if (apiKey) {
            setHasKey(true)
            setKeyTail(apiKey.slice(-4))
            setApiKey('')
          }
        } catch (e) {
          setResult({ ok: false, error: String(e.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      const providerOptions = [
        h('option', { key: '', value: '' }, t('embeddingNone')),
        ...providers.map((p) => h('option', { key: p.id, value: p.id }, p.label)),
      ]

      const keyPlaceholder = hasKey ? t('embeddingKeySet')(keyTail) : t('embeddingKeyPlaceholder')

      const fields =
        provider === ''
          ? null
          : h(
              'div',
              { className: 'dsh-memory-anchor-embedFields' },
              h(
                'label',
                { className: 'dsh-memory-anchor-field' },
                h('span', { className: 'dsh-memory-anchor-fieldLabel' }, t('embeddingApiUrl')),
                h('input', {
                  type: 'text',
                  className: 'dsh-memory-anchor-input',
                  value: apiUrl,
                  placeholder: current?.baseUrl ?? '',
                  onChange: (e) => setApiUrl(e.target.value),
                }),
              ),
              h(
                'label',
                { className: 'dsh-memory-anchor-field' },
                h('span', { className: 'dsh-memory-anchor-fieldLabel' }, t('embeddingModel')),
                h('input', {
                  type: 'text',
                  className: 'dsh-memory-anchor-input',
                  value: modelName,
                  placeholder: current?.model ?? '',
                  onChange: (e) => setModelName(e.target.value),
                }),
              ),
              h(
                'label',
                { className: 'dsh-memory-anchor-field' },
                h('span', { className: 'dsh-memory-anchor-fieldLabel' }, t('embeddingDimensions')),
                h('select', {
                  className: 'dsh-memory-anchor-input',
                  value: String(dimensions),
                  onChange: (e) => setDimensions(Number(e.target.value)),
                }, [
                  h('option', { key: '1024', value: '1024' }, '1024'),
                  h('option', { key: '2048', value: '2048' }, '2048'),
                ]),
                h('span', { className: 'dsh-memory-anchor-fieldHint' }, t('embeddingDimensionsHint')),
              ),
              h(
                'label',
                { className: 'dsh-memory-anchor-field' },
                h('span', { className: 'dsh-memory-anchor-fieldLabel' }, t('embeddingApiKey')),
                h(
                  'div',
                  { className: 'dsh-memory-anchor-keyRow' },
                  h('input', {
                    type: showKey ? 'text' : 'password',
                    className: 'dsh-memory-anchor-input',
                    value: apiKey,
                    placeholder: keyPlaceholder,
                    autoComplete: 'off',
                    onChange: (e) => setApiKey(e.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-memory-anchor-keyToggle',
                      onClick: () => setShowKey((v) => !v),
                    },
                    showKey ? t('hide') : t('show'),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dsh-memory-anchor-embedActions' },
                h(
                  'button',
                  { type: 'button', className: 'dsh-memory-anchor-btn', disabled: busy, onClick: onTest },
                  busy ? t('testing') : t('testConnection'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-memory-anchor-btn dsh-memory-anchor-btnPrimary',
                    disabled: busy,
                    onClick: onSave,
                  },
                  t('save'),
                ),
              ),
            )

      let resultNode = null
      if (result !== null) {
        if (result.ok && result.saved) {
          resultNode = h(
            'div',
            { className: 'dsh-memory-anchor-ok' },
            result.persisted ? t('embeddingSaved') : t('embeddingSavedMemoryOnly'),
          )
        } else if (result.ok) {
          resultNode = h(
            'div',
            { className: 'dsh-memory-anchor-ok' },
            t('embeddingTestOk')(result.latencyMs, result.dimensions),
          )
        } else {
          resultNode = h('div', { className: 'dsh-memory-anchor-error' }, t('embeddingTestFail')(result.error ?? ''))
        }
      }

      return h(
        'div',
        { className: 'dsh-memory-anchor-embed' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-memory-anchor-embedToggle',
            onClick: () => setOpen((v) => !v),
          },
          h('span', null, open ? '▾' : '▸'),
          h('span', { className: 'dsh-memory-anchor-embedTitle' }, t('embeddingTitle')),
          h('span', { className: 'dsh-memory-anchor-embedHint' }, provider === '' ? t('embeddingOff') : t('embeddingOn')),
        ),
        open
          ? h(
              'div',
              { className: 'dsh-memory-anchor-embedBody' },
              h('p', { className: 'dsh-memory-anchor-embedDesc' }, t('embeddingDesc')),
              h(
                'label',
                { className: 'dsh-memory-anchor-field' },
                h('span', { className: 'dsh-memory-anchor-fieldLabel' }, t('embeddingProvider')),
                h('select', {
                  className: 'dsh-memory-anchor-input',
                  value: provider,
                  onChange: (e) => setProvider(e.target.value),
                }, providerOptions),
              ),
              fields,
              resultNode,
              provider !== ''
                ? h('p', { className: 'dsh-memory-anchor-embedNote' }, t('embeddingReindexNote'))
                : null,
            )
          : null,
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

  // 注册模块。
  //
  // 这里**不能**用空 catch 包住：一旦 load() 因任何原因失败，
  // 浏览器只会报「loaded without registering」，真正的原因被吞掉，
  // 表现为「插件加载了但菜单不显示」，极难排查。
  //
  // 因此只在「确实不存在模块加载器」时才走 fallback；
  // 有加载器却调用失败，必须把错误抛出去。
  if (typeof window !== 'undefined' && window.__ModuleLoader__) {
    window.__ModuleLoader__.load({ id: ID, factory: createPlugin })
  } else if (typeof module !== 'undefined' && module && 'exports' in module) {
    module.exports = { createPlugin }
  } else {
    // 既无 loader 也无 module：非受支持的宿主环境。
    // 抛错而不是静默，避免同一个问题以「菜单消失」的形式出现。
    throw new Error(`${ID}: no module loader available to register the client plugin`)
  }
})()