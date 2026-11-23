/**
 * LWM 业务核心 —— 与存储后端解耦。
 *
 * 这一层的设计原则：**接收一个最小的存储接口，不依赖 DSH**。
 * 这样它可以在 node --test 里完整跑通，而 Host 插件只是把
 * storageDomain 适配成这个接口。
 *
 * 适配器接口（见 inMemoryAdapter / 插件里的 storageDomain 适配器）：
 *   get(table, key)        → record | undefined   （同步，内存）
 *   put(table, key, value) → Promise<void>
 *   delete(table, key)     → Promise<void>
 *   list(table)            → Record<key, record>  （同步，内存）
 *   getGlobal()            → global | undefined   （同步）
 *   setGlobal(value)       → Promise<void>
 *
 * @module lwm/store
 */

import { embed, cosine, encodeForStorage, decodeFromStorage, cosineQuantized, SIMILARITY_THRESHOLD } from './vector.mjs'
import { detectConflict, detectSlotOverwrite, loadPolarityPairs } from './polarity.mjs'

/** 写入闸门允许的四种触发（设计文档 4.1）。 */
export const WRITE_TRIGGERS = ['decision', 'rejected', 'gotcha', 'constraint']

/**
 * 相关性绝对下限（噪音闸门）。
 *
 * 只用来挡住明显无关的条目，**不是相关性裁决线**。
 * 实测证明不存在能同时满足所有查询的绝对阈值（bench/repro-recall.mjs）：
 *
 *   「表面处理失败怎么办」⟷「表面处理设备需每日点检」= 0.480（不同主题）
 *   「表面处理」        ⟷「表面处理失败必须锁批次」  = 0.385（真匹配）
 *   「时区」            ⟷「所有时间统一…时区」      = 0.260（真匹配）
 *
 * 真匹配的分数可能低于假匹配，所以绝对阈值无法成为裁决依据。
 * 真正的裁决靠下面的相对截断（RELATIVE_CUTOFF）。
 */
const RELEVANCE_FLOOR = 0.15

/**
 * 相对截断：只保留与本次最高分相差不超过该比例的条目。
 *
 * 这是解决"短查询 vs 长查询"阈值不可调和的关键：
 *   - 短查询（"时区"）最高分 0.260，则保留 ≥0.260×0.6 = 0.156
 *   - 长查询（"SNAPSHOT 依赖"）最高分 0.758，则保留 ≥0.455
 * 阈值随查询自适应，无需为每种查询长度调参。
 */
const RELATIVE_CUTOFF = 0.6

/**
 * 记忆库。
 *
 * 全部读取走同步内存路径（依赖适配器保证），写入返回 Promise。
 * 这与 storageDomain 的语义一致，因此适配是零成本的。
 */
export class MemoryStore {
  /**
   * @param {object} adapter
   * @param {object} [options]
   * @param {number} [options.recentWindowMs] S2「可判定」的时间窗口，默认 30 分钟
   * @param {number} [options.staleDays] R1 过期天数，默认 180
   * @param {number} [options.retireMisses] R2 失效 miss 阈值，默认 3
   * @param {string[]} [options.polarityPairs] 自定义极性词表
   */
  constructor(adapter, options = {}) {
    this.adapter = adapter
    this.recentWindowMs = options.recentWindowMs ?? 30 * 60 * 1000
    this.staleDays = options.staleDays ?? 180
    this.retireMisses = options.retireMisses ?? 3
    this.polarityPairs = loadPolarityPairs(options.polarityPairs?.join('\n'))
    /** @type {Map<string, Uint8Array>} 反量化缓存的量化向量，避免每次检索重新 base64 解码 */
    this._vecCache = new Map()
  }

  // ------------------------------------------------------------------
  // 低层访问
  // ------------------------------------------------------------------

  /** @returns {Record<string, any>} */
  _all() {
    return this.adapter.list('memories') ?? {}
  }

  /** @param {string} id */
  get(id) {
    return this.adapter.get('memories', id)
  }

  /**
   * 取记录的量化向量（Uint8Array，供 cosineQuantized 使用）。
   *
   * 注意类型：这里缓存的是**量化字节**，不是 Float32 向量。
   * 需要浮点向量时用 dequantizedVector()，不要混用——
   * 混用会让 cosine() 算出大于 1 的值（实测踩过，见 git 记录）。
   *
   * @param {string} id
   * @returns {Uint8Array|null}
   */
  _vec(id) {
    let v = this._vecCache.get(id)
    if (v === undefined) {
      const rec = this.get(id)
      if (!rec) return null
      v = decodeFromStorage(rec.embedding)
      this._vecCache.set(id, v)
    }
    return v
  }

  _invalidate(id) {
    this._vecCache.delete(id)
  }

  // ------------------------------------------------------------------
  // 写入闸门与去重（设计文档 4.2）
  // ------------------------------------------------------------------

  /**
   * 写入前检查：去重、极性冲突、同槽覆盖。
   *
   * 这是「什么时候该问人」的第一道关口。返回的结构直接决定
   * Agent 下一步该做什么，而不是替它做决定。
   *
   * @param {{kind: string, claim: string, scope?: string[], tags?: string[], cwd?: string}} candidate
   * @returns {{
   *   verdict: 'insert'|'merge'|'conflict'|'overwrite',
   *   duplicates: Array<{id: string, claim: string, similarity: number}>,
   *   conflicts: Array<{id: string, claim: string, contentSim: number}>,
   *   overwrites: Array<{id: string, claim: string, evidence: string[]}>,
   *   message: string,
   * }}
   */
  inspectWrite(candidate) {
    const claim = String(candidate.claim ?? '').trim()
    const records = Object.values(this._all())
    const qv = embed(claim)
    const sim = (a, b) => cosine(embed(a), embed(b))

    /** @type {Array<{id:string, claim:string, similarity:number}>} */
    const duplicates = []
    /** @type {Array<{id:string, claim:string, contentSim:number}>} */
    const conflicts = []
    /** @type {Array<{id:string, claim:string, evidence:string[]}>} */
    const overwrites = []

    for (const rec of records) {
      if (rec.status === 'retired') continue
      const v = this._vec(rec.id)
      if (!v) continue
      const similarity = cosineQuantized(encodeToBytes(qv), v)

      // ② 极性冲突必须先于重复判定！
      // 极性相反的两条陈述字面高度重合（"禁止使用 X" vs "允许使用 X"
      // 实测相似度 0.88），若先判重复会永久漏掉所有冲突。
      if (similarity >= 0.45) {
        const r = detectConflict(claim, rec.claim, sim)
        if (r.conflict) {
          conflicts.push({ id: rec.id, claim: rec.claim, contentSim: r.contentSim })
          continue
        }
        // ③ 同槽覆盖（昨天→前天 这类更正）
        const ow = detectSlotOverwrite(claim, rec.claim)
        if (ow.overlap) {
          overwrites.push({ id: rec.id, claim: rec.claim, evidence: ow.evidence })
          continue
        }
      }

      // ① 疑似重复：同 kind 且字面高度重合（已排除冲突与覆盖）
      if (similarity >= 0.75 && rec.kind === candidate.kind) {
        duplicates.push({ id: rec.id, claim: rec.claim, similarity })
      }
    }

    if (conflicts.length > 0) {
      // 冲突优先于重复，但重复信息必须一并带出。
      //
      // 曾出现的问题：库里已有 probe-3 与 acc-a 两条完全相同的约束，
      // 再写第三条时判定被 conflict 整体劫持，duplicates 被丢弃，
      // 于是"内容完全重复"这件事被隐藏，重复条目持续累积。
      const dupNote =
        duplicates.length > 0
          ? `\n另外检测到 ${duplicates.length} 条内容重复（建议并入而非新增）：\n` +
            duplicates.map((d) => `  = [${d.id}] ${d.claim}`).join('\n')
          : ''
      return {
        verdict: 'conflict',
        duplicates,
        conflicts,
        overwrites,
        message:
          `检测到极性冲突，必须人工确认（不可自动取舍）。\n` +
          conflicts.map((c) => `  vs [${c.id}] ${c.claim}`).join('\n') +
          `\n请用 resolve 决定：保留旧的、采用新的、或两条并列。` +
          dupNote,
      }
    }

    if (overwrites.length > 0) {
      return {
        verdict: 'overwrite',
        duplicates,
        conflicts,
        overwrites,
        message:
          `检测到同槽覆盖（视为更正，可自动取代，但会留 correction 事件）。\n` +
          overwrites.map((o) => `  vs [${o.id}] ${o.claim}  (${o.evidence.join(', ')})`).join('\n'),
      }
    }

    if (duplicates.length > 0) {
      return {
        verdict: 'merge',
        duplicates,
        conflicts,
        overwrites,
        message:
          `疑似重复，建议合并而非新增：\n` +
          duplicates.map((d) => `  [${d.id}] ${d.claim}  (相似度 ${d.similarity.toFixed(3)})`).join('\n'),
      }
    }

    return { verdict: 'insert', duplicates: [], conflicts: [], overwrites: [], message: '' }
  }

  /**
   * 写入一条记忆。
   *
   * @param {object} input
   * @param {string} input.id
   * @param {string} input.kind
   * @param {string} input.claim
   * @param {string} [input.why]
   * @param {string[]} [input.scope]
   * @param {string} [input.verify]
   * @param {string[]} [input.tags]
   * @param {string} [input.source]
   * @param {boolean} [input.force] 跳过去重/冲突拦截
   * @param {'newer'|'older'|'both'} [input.onConflict] force 时的取舍
   * @returns {Promise<{ok: boolean, id?: string, verdict: string, message: string, superseded?: string[]}>}
   */
  async add(input) {
    const now = new Date().toISOString()
    const claim = String(input.claim ?? '').trim()

    if (!claim) return { ok: false, verdict: 'invalid', message: 'claim 不能为空' }
    if (!WRITE_TRIGGERS.includes(input.kind)) {
      return {
        ok: false,
        verdict: 'invalid',
        message: `kind 必须是 ${WRITE_TRIGGERS.join('/')} 之一。这四类是唯一允许写入的记忆来源。`,
      }
    }

    // 单句约束：多句断言无法判断真假
    const sentences = claim.split(/[。！？!?]/).filter((s) => s.trim().length > 0)
    if (sentences.length > 2) {
      return {
        ok: false,
        verdict: 'invalid',
        message: `claim 应为单句断言，当前检测到 ${sentences.length} 句。多句无法验证真假。`,
      }
    }

    const check = this.inspectWrite(input)

    if (check.verdict === 'conflict' && input.force !== true) {
      return { ok: false, verdict: 'conflict', message: check.message }
    }

    /** @type {string[]} */
    const superseded = []

    if (check.verdict === 'overwrite') {
      // 同槽覆盖：自动取代旧值，但留 correction 记录
      for (const o of check.overwrites) {
        const old = this.get(o.id)
        if (!old) continue
        await this.adapter.put('memories', o.id, {
          ...old,
          status: 'superseded',
          updatedAt: now,
        })
        this._invalidate(o.id)
        superseded.push(o.id)
      }
    }

    if (check.verdict === 'conflict' && input.force === true) {
      const onConflict = input.onConflict ?? 'both'
      if (onConflict === 'newer') {
        for (const c of check.conflicts) {
          const old = this.get(c.id)
          if (!old) continue
          await this.adapter.put('memories', c.id, { ...old, status: 'superseded', updatedAt: now })
          this._invalidate(c.id)
          superseded.push(c.id)
        }
      }
      // onConflict === 'both'：两条都保留，本条标 provisional
    }

    const stability = check.verdict === 'conflict' && (input.onConflict ?? 'both') === 'both'
      ? 'provisional'
      : (input.stability ?? 'settled')

    const record = {
      id: input.id,
      kind: input.kind,
      claim,
      why: input.why ?? '',
      scope: input.scope ?? [],
      verify: input.verify ?? '',
      tags: input.tags ?? [],
      status: 'active',
      stability,
      supersedes: superseded[0] ?? null,
      revision: superseded.length ? (this.get(superseded[0])?.revision ?? 1) + 1 : 1,
      embedding: encodeForStorage(claim),
      createdAt: now,
      updatedAt: now,
      lastVerified: null,
      hits: 0,
      miss: 0,
      source: input.source ?? '',
    }

    await this.adapter.put('memories', record.id, record)
    this._invalidate(record.id)

    return {
      ok: true,
      id: record.id,
      verdict: check.verdict,
      message: check.verdict === 'insert' ? '已写入' : check.message,
      superseded,
    }
  }

  // ------------------------------------------------------------------
  // 检索（设计文档 5，四层修正版）
  // ------------------------------------------------------------------

  /**
   * 检索记忆。
   *
   * 层级顺序由实测确定（见 vector.mjs 头注释）：
   *   L1 scope 路径过滤 —— 必须先做，结构约束
   *   L2 向量全量扫描   —— 主力召回
   *   L3 精确符号兜底   —— 处理 N+1 / SNAPSHOT 这类标识符
   *   L4 极性标注       —— 产出 ⚠conflict，不产出结论
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {string} [opts.cwd] 用于 scope 过滤
   * @param {string} [opts.kind]
   * @param {boolean} [opts.includeRetired]
   * @param {boolean} [opts.includeSuperseded]
   * @returns {Array<object>}
   */
  find(query, opts = {}) {
    const limit = opts.limit ?? 5
    const cwd = opts.cwd ?? ''
    // 工作区路径：scope 里的 `workspace` 关键字按它展开。
    // 缺省时退化为 cwd，因为检索本身就是在当前工作目录下发起。
    const workspace = opts.workspace ?? cwd
    const q = String(query ?? '').trim()
    if (!q) return []

    const qvec = encodeToBytes(embed(q))
    const results = []

    for (const rec of Object.values(this._all())) {
      if (rec.status === 'retired' && !opts.includeRetired) continue
      if (rec.status === 'superseded' && !opts.includeSuperseded) continue
      if (opts.kind && rec.kind !== opts.kind) continue

      // L1：scope 匹配。无 scope = 全局，始终通过。
      //
      // 不匹配时**降权而非丢弃**。这是实施后修正的设计：
      // 早先直接 continue 掉，导致「在 src/surface/** 下写的记忆，
      // 从仓库根目录搜不到」——用户体验上等同于"刚写入就丢了"。
      // 但 scope 的价值（结构约束）又确实存在，所以保留为降权：
      // 相关度足够高时仍会返回，只是排在同 scope 的条目之后。
      const scopeMatched =
        !cwd ||
        !Array.isArray(rec.scope) ||
        rec.scope.length === 0 ||
        matchesScope(cwd, rec.scope, workspace)

      const v = this._vec(rec.id)
      if (!v) continue

      // L2：向量相似度（原始相关性，不加业务权重）
      let relevance = cosineQuantized(qvec, v)

      // scope 不匹配 → 显著降权，但仍可能出现在结果里。
      //
      // 系数取 0.5 而非 0.7：实测发现 0.7 力度不够。例如在
      // src/surface/ 下搜「表面处理」，另一目录的「表面处理设备需每日点检」
      // 原始分 0.573，×0.7 = 0.401，反而高过本目录的「表面处理失败后必须
      // 锁 lot」(0.385)，纯字面巧合压过了结构相关性。
      // 折半后它能被挤出，同时仍保留了"换目录也能搜到"的能力。
      if (!scopeMatched) relevance *= 0.5

      // L3：精确符号兜底。标识符类查询（含大写/数字符号）额外加分。
      // 加的是相关性而非排序权重——命中标识符就是更强的相关证据。
      // 必须封顶到 1：否则 0.7584 + 0.25 = 1.0084，相关性失去 [0,1] 语义。
      if (looksLikeIdentifier(q) && rec.claim.toLowerCase().includes(q.toLowerCase())) {
        relevance = Math.min(1, relevance + 0.25)
      }

      // 相关性下限：低于此值视为无关，不进入结果集。
      //
      // 阈值依据实测（bench/repro-recall.mjs）：与查询相关的条目落在
      // 0.49~0.76，无关条目落在 0.00~0.33，0.20 落在空隙中。
      // 早先设 0.05 会把「所有时间统一 Asia/Shanghai」（0.334）这类
      // 完全无关的条目混进「SNAPSHOT 依赖」的结果，制造噪音。
      if (relevance < RELEVANCE_FLOOR) continue

      results.push({ rec, relevance })
    }

    // 排序：相关性为主序，业务权重为次序。
    //
    // 刻意把两者分开：早先把业务加分直接加到相关性上，会让 score 突破 1.0
    // （实测 0.7584 + 权重 = 1.0084），既失真又无法判断"到底有多相关"。
    // 现在 relevance 永远保持 [0,1] 语义，排序用 rank 组合值。
    results.sort((a, b) => rankOf(b) - rankOf(a))

    // 相对截断：以本次最高分为基准。
    // 必须先排序再截断，否则会用错基准。
    const top = results.length > 0 ? results[0].relevance : 0
    const cutoff = Math.max(RELEVANCE_FLOOR, top * RELATIVE_CUTOFF)
    const kept = results.filter((x) => x.relevance >= cutoff)

    /**
     * @param {{rec: any, relevance: number}} x
     */
    function rankOf({ rec, relevance }) {
      let s = relevance
      if (rec.kind === 'rejected') s += 0.05 // 否决类优先，防止重开争论
      if (rec.stability === 'provisional') s -= 0.10
      if (rec.status === 'stale') s -= 0.15
      if (rec.status === 'superseded') s -= 0.30
      s += Math.min(rec.hits, 10) * 0.005
      s -= rec.miss * 0.03
      return s
    }

    return kept.slice(0, limit).map(({ rec, relevance }) => {
      // L4：查询与本条是否构成未决冲突
      const siblings = kept
        .filter((x) => x.rec.id !== rec.id && x.relevance >= 0.45)
        .filter((x) => detectConflict(rec.claim, x.rec.claim, (a, b) => cosine(embed(a), embed(b))).conflict)
        .map((x) => x.rec.id)
      return { ...rec, relevance, conflictsWith: siblings }
    })
  }

  // ------------------------------------------------------------------
  // 反馈与生命周期
  // ------------------------------------------------------------------

  /**
   * 标记采纳。
   * @param {string} id
   */
  async use(id) {
    const rec = this.get(id)
    if (!rec) return { ok: false, message: `未找到 ${id}` }
    const now = new Date().toISOString()
    await this.adapter.put('memories', id, {
      ...rec,
      hits: rec.hits + 1,
      // 复活：retired/stale 被采纳说明仍有价值
      status: rec.status === 'retired' || rec.status === 'stale' ? 'active' : rec.status,
      updatedAt: now,
    })
    this._invalidate(id)
    return { ok: true, message: `${id} 采纳次数 +1` }
  }

  /**
   * 标记未采纳 / 采纳后发现失效。
   * @param {string} id
   * @param {string} [reason]
   */
  async miss(id, reason = '') {
    const rec = this.get(id)
    if (!rec) return { ok: false, message: `未找到 ${id}` }
    const now = new Date().toISOString()
    const miss = rec.miss + 1
    let status = rec.status
    // R2：连续 miss 达阈值 → retired
    if (miss >= this.retireMisses && rec.hits === 0) status = 'retired'
    await this.adapter.put('memories', id, {
      ...rec,
      miss,
      status,
      why: reason ? `${rec.why}\n[miss] ${reason}`.trim().slice(0, 2000) : rec.why,
      updatedAt: now,
    })
    this._invalidate(id)
    return { ok: true, message: `${id} miss=${miss}${status !== rec.status ? ` → ${status}` : ''}` }
  }

  /**
   * 验证结果。
   * @param {string} id
   * @param {boolean} ok
   */
  async verify(id, ok) {
    const rec = this.get(id)
    if (!rec) return { ok: false, message: `未找到 ${id}` }
    const now = new Date().toISOString()
    await this.adapter.put('memories', id, {
      ...rec,
      lastVerified: ok ? now : rec.lastVerified,
      status: ok ? 'active' : 'stale',
      updatedAt: now,
    })
    this._invalidate(id)
    return { ok: true, message: `${id} 验证${ok ? '通过' : '失败 → stale'}` }
  }

  /**
   * 裁决冲突。这是「什么时候问人」的落点。
   *
   * @param {string} idA
   * @param {string} idB
   * @param {'a'|'b'|'both'|'keepA'|'keepB'} decision
   *   'a' 保留第一条，'b' 保留第二条，'both' 两条并列为 provisional。
   *   同时兼容旧的 keepA/keepB 写法。
   */
  async resolve(idA, idB, decision = 'both') {
    const a = this.get(idA)
    const b = this.get(idB)
    if (!a || !b) return { ok: false, message: '冲突双方必须都存在' }
    const now = new Date().toISOString()

    // 归一化：外部用 a/b，内部曾用 keepA/keepB，两者都接受
    const norm =
      decision === 'a' || decision === 'keepA'
        ? 'keepA'
        : decision === 'b' || decision === 'keepB'
          ? 'keepB'
          : 'both'

    if (norm === 'both') {
      // 保守：两条都保留为 provisional，检索时都会标 ⚠
      for (const r of [a, b]) {
        await this.adapter.put('memories', r.id, { ...r, stability: 'provisional', updatedAt: now })
        this._invalidate(r.id)
      }
      return { ok: true, message: '两条均保留为 provisional，检索时将同时标注冲突' }
    }

    const [keep, drop] = norm === 'keepA' ? [a, b] : [b, a]
    await this.adapter.put('memories', keep.id, { ...keep, stability: 'settled', updatedAt: now })
    await this.adapter.put('memories', drop.id, {
      ...drop,
      status: 'superseded',
      supersedes: null,
      updatedAt: now,
    })
    await this.adapter.put('memories', keep.id, {
      ...(this.get(keep.id) ?? keep),
      supersedes: drop.id,
      revision: (drop.revision ?? 1) + 1,
      updatedAt: now,
    })
    this._invalidate(keep.id)
    this._invalidate(drop.id)
    return { ok: true, message: `保留 ${keep.id}，${drop.id} 转为 superseded` }
  }

  /**
   * 执行衰减。默认 dry-run。
   * @param {boolean} apply
   */
  async gc(apply = false) {
    const now = Date.now()
    const staleMs = this.staleDays * 24 * 60 * 60 * 1000
    /** @type {Array<{id: string, from: string, to: string, reason: string}>} */
    const changes = []

    for (const rec of Object.values(this._all())) {
      if (rec.status !== 'active') continue
      const ref = rec.lastVerified ?? rec.createdAt
      const age = now - new Date(ref).getTime()
      // 用 >= 而非 >：staleDays=0 时刚写入的记录也应判为过期，
      // 否则「立即过期」这一边界永远无法被测到。
      if (age >= staleMs) {
        changes.push({ id: rec.id, from: 'active', to: 'stale', reason: `${Math.floor(age / 86400000)} 天未验证` })
      }
    }

    if (apply) {
      const ts = new Date().toISOString()
      for (const c of changes) {
        const rec = this.get(c.id)
        if (!rec) continue
        await this.adapter.put('memories', c.id, { ...rec, status: c.to, updatedAt: ts })
        this._invalidate(c.id)
      }
    }

    return { applied: apply, changes }
  }

  /**
   * 库健康度。
   */
  stats() {
    const all = Object.values(this._all())
    const byStatus = {}
    const byKind = {}
    let unverifiable = 0
    let neverVerified = 0
    let missTotal = 0
    let writeTotal = all.length

    for (const r of all) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
      if (!r.verify) unverifiable++
      if (!r.lastVerified) neverVerified++
      missTotal += r.miss
    }

    const total = all.length || 1
    return {
      total: all.length,
      byStatus,
      byKind,
      unverifiable,
      unverifiablePct: unverifiable / total,
      neverVerified,
      neverVerifiedPct: neverVerified / total,
      missWriteRatio: missTotal / (writeTotal || 1),
      topHits: all
        .filter((r) => r.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 10)
        .map((r) => ({ id: r.id, hits: r.hits })),
    }
  }
}

// --------------------------------------------------------------------
// 辅助
// --------------------------------------------------------------------

/** 把 Float32Array 编码为可直接喂给 cosineQuantized 的字节 */
function encodeToBytes(v) {
  const out = new Uint8Array(v.length)
  for (let i = 0; i < v.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(v[i] * 127) + 128))
  }
  return out
}

/** 查询是否像标识符（N+1、SNAPSHOT、dto-naming） */
function looksLikeIdentifier(q) {
  return /[A-Z]{2,}|\d|[_\-]/.test(q)
}

/**
 * 路径 glob 匹配。
 *
 * ## 语义说明（重要）
 *
 * scope 表达的是**目录范围**，不是文件名模式。因此匹配采用
 * "前缀 + 子树"语义：模式 src/* 匹配 src/a、src/a/b、src/a/b/c。
 * 这与 .gitignore 的星号不同（那是不跨层），是刻意选择：
 * 记忆的 scope 关心"这个决策约束哪个区域"，该区域天然包含所有子目录。
 *
 * @param {string} cwd
 * @param {string[]} patterns
 */
export function matchesScope(cwd, patterns, workspace) {
  const norm = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  return patterns.some((p) => {
    // `workspace` 关键字：匹配当前工作区及其子目录。
    //
    // 用关键字而不要求用户填绝对路径，是因为绝对路径写死在记忆里
    // 一旦换机器或仓库搬家就失效；`workspace` 在检索时按 cwd 动态解析。
    if (p === 'workspace') {
      const ws = String(workspace || cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
      if (ws === '') return false
      return norm === ws || norm.startsWith(ws + '/')
    }
    return globToRegExp(p).test(norm)
  })
}

/**
 * scope 是否声明了 workspace 语义。
 * @param {string[]|undefined} scope
 * @returns {boolean}
 */
export function usesWorkspaceScope(scope) {
  return Array.isArray(scope) && scope.includes('workspace')
}

/**
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') {
      // `**` 表示"零个或多个路径段"，连同它前面的 `/` 一并可选。
      //
      // 不能编译成固定的 `/.*`：那要求路径后面至少还有一个字符，
      // 于是 `cwd` 恰好等于前缀时（D:/repo 对 D:/repo/**）匹配不上。
      // 正确做法是回退掉已经写入的尾随 `/`，再追加可选的 `(/.*)?`。
      i++
      if (re.endsWith('/')) re = re.slice(0, -1)
      if (p[i + 1] === '/') i++
      re += '(/.*)?'
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      continue
    }
    if (c === '?') {
      re += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  // 模式本身匹配该层及其所有子路径
  return new RegExp('^' + re + '(/.*)?$')
}
