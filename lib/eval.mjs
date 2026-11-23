/**
 * LWM 评测模块 —— 失败检测与自改进闭环。
 *
 * ## 与 stats 的边界
 *
 *   stats 回答「库看起来还行吗」    → 状态聚合
 *   eval  回答「它在哪些时刻没起作用」→ 单次事件 + 归因
 *
 * 前者是体检报告，后者是事故黑匣子。
 *
 * ## 设计核心：失败分类学
 *
 * 七类失败，每类绑定**客观可判定信号**，不靠主观报告。
 * F7（反馈缺失）单列为元指标：它一高，F2 的数字就不可信，
 * 因为两者都以「没有 use」为信号。
 *
 * @module lwm/eval
 */

import { SIMILARITY_THRESHOLD } from './vector.mjs'

/** 失败类型的严重度映射。 */
const SEVERITY = {
  F1: 'normal',
  F2: 'normal',
  F3: 'high',
  F4: 'normal',
  F5: 'high',
  F6: 'low',
  F7: 'low',
}

/** 各失败类型的中文名与建议动作。 */
export const FAILURE_CATALOG = {
  F1: { name: '未召回', action: 'add_memory', hint: '该召回没召回，事后才补写' },
  F2: { name: '召回但无用', action: 'tune_score', hint: '召回了但模型没用' },
  F3: { name: '验证失败', action: null, hint: '记忆使用时已过期' },
  F4: { name: '决策重开', action: 'tighten_gate', hint: '同主题又出现新决策' },
  F5: { name: '冲突', action: 'tighten_gate', hint: '两条记忆互相矛盾' },
  F6: { name: '任务未完成', action: 'doc', hint: '走了记忆路径但任务失败' },
  F7: { name: '反馈缺失', action: 'doc', hint: '召回后无任何反馈（元指标）' },
}

/**
 * 评测器。
 *
 * 消费 eval_events 表，产出 failures / actions。
 * 全部是确定性规则，不调用 LLM —— 归因结论留给人或上层 Agent。
 */
export class Evaluator {
  /**
   * @param {object} adapter 与 MemoryStore 相同的存储适配器
   * @param {object} [opts]
   * @param {number} [opts.feedbackWindowEvents] F2 判定的后续事件窗口，默认 20
   * @param {number} [opts.unrecallWindowMs] F1 的事后补写窗口，默认 30 分钟
   */
  constructor(adapter, opts = {}) {
    this.adapter = adapter
    this.feedbackWindowEvents = opts.feedbackWindowEvents ?? 20
    this.unrecallWindowMs = opts.unrecallWindowMs ?? 30 * 60 * 1000
  }

  /**
   * 追加一条评测事件。这是唯一的采集入口。
   *
   * @param {object} input
   * @param {string} input.session
   * @param {string} input.action
   * @param {object} [input.payload] 只放摘要，绝不放自由文本原文
   * @param {string} [input.cwd] 相对路径
   * @param {boolean} [input.ok]
   * @param {string[]} [input.returned] 本次返回的 memory id
   * @returns {Promise<object>} 写入的事件
   */
  async record({ session, action, payload = {}, cwd = '', ok = true, returned = [] }) {
    const all = this.adapter.list('eval_events') ?? {}
    let maxSeq = 0
    for (const k of Object.keys(all)) {
      const n = Number(k)
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n
    }
    const seq = maxSeq + 1
    const event = {
      seq,
      session: String(session ?? '').slice(0, 200),
      at: new Date().toISOString(),
      action,
      // 只保留字符串化后的摘要，并截断，避免自由文本膨胀
      payload: JSON.stringify(payload).slice(0, 4000),
      cwd: normalizeRel(cwd),
      ok,
      returned: JSON.stringify(returned).slice(0, 2000),
    }
    await this.adapter.put('eval_events', String(seq), event)
    return event
  }

  /** @returns {Array<object>} 按 seq 升序的全部事件 */
  events() {
    const all = this.adapter.list('eval_events') ?? {}
    return Object.values(all).sort((a, b) => a.seq - b.seq)
  }

  /**
   * 分析事件流，派生失败事件。
   *
   * 幂等：同一份事件流重复分析得到相同结果（按 id 覆盖）。
   * 不删除已有人工结论（rootCause / fixRef 保留）。
   *
   * @returns {Promise<Array<object>>}
   */
  async analyze() {
    const events = this.events()
    /** @type {Array<object>} */
    const found = []

    // 按 session 分组，大多数判定需要会话内上下文
    const bySession = new Map()
    for (const ev of events) {
      if (!bySession.has(ev.session)) bySession.set(ev.session, [])
      bySession.get(ev.session).push(ev)
    }

    for (const [session, evs] of bySession) {
      found.push(...this._detectF1(session, evs))
      found.push(...this._detectF2(session, evs))
      found.push(...this._detectF3(session, evs))
      found.push(...this._detectF7(session, evs))
    }

    // F4/F5 是跨会话的库级判定
    found.push(...this._detectF4())

    const now = new Date().toISOString()
    const existing = this.adapter.list('failures') ?? {}

    for (const f of found) {
      const prev = existing[f.id]
      await this.adapter.put('failures', f.id, {
        ...f,
        detectedAt: now,
        // 保留人工归因结论
        rootCause: prev?.rootCause ?? '',
        fixRef: prev?.fixRef ?? '',
        status: prev?.status ?? 'open',
        severity: f.severity ?? SEVERITY[f.type] ?? 'normal',
      })
    }

    return found
  }

  // ----------------------------------------------------------------
  // 各失败类型的检测器
  // ----------------------------------------------------------------

  /** F1 未召回：find 返回 0 条，但窗口内又 add 了同主题。 */
  _detectF1(session, evs) {
    const out = []
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i]
      if (ev.action !== 'find') continue
      const returned = safeJson(ev.returned, [])
      if (returned.length > 0) continue

      const t0 = new Date(ev.at).getTime()
      for (let j = i + 1; j < evs.length; j++) {
        const later = evs[j]
        if (new Date(later.at).getTime() - t0 > this.unrecallWindowMs) break
        if (later.action !== 'add') continue
        const p = safeJson(later.payload, {})
        out.push({
          id: `F1-${session}-${ev.seq}`,
          type: 'F1',
          session,
          subject: p.id ?? '',
          query: String(p.query ?? p.claim ?? '').slice(0, 200),
          evidence: JSON.stringify({ emptyFindSeq: ev.seq, laterAddSeq: later.seq, addedId: p.id }),
        })
        break
      }
    }
    return out
  }

  /** F2 召回但无用：find 有结果，后续无 use/miss，且该会话确实有反馈行为。 */
  _detectF2(session, evs) {
    const out = []
    // 先判断该会话是否「具备反馈能力」，否则是 F7 而非 F2
    const hasAnyFeedback = evs.some((e) => e.action === 'use' || e.action === 'miss')
    if (!hasAnyFeedback) return out

    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i]
      if (ev.action !== 'find') continue
      const returned = safeJson(ev.returned, [])
      if (returned.length === 0) continue

      const window = evs.slice(i + 1, i + 1 + this.feedbackWindowEvents)
      const used = window.some(
        (e) => (e.action === 'use' || e.action === 'miss') && returned.includes(safeJson(e.payload, {}).id),
      )
      if (used) continue

      out.push({
        id: `F2-${session}-${ev.seq}`,
        type: 'F2',
        session,
        subject: returned.slice(0, 3).join(','),
        query: String(safeJson(ev.payload, {}).query ?? '').slice(0, 200),
        evidence: JSON.stringify({ findSeq: ev.seq, returned }),
        // 返回 ≥5 条仍无采纳，说明排序或相关性有问题
        severity: returned.length >= 5 ? 'high' : 'normal',
      })
    }
    return out
  }

  /** F3 验证失败：verify 报告不成立。 */
  _detectF3(session, evs) {
    return evs
      .filter((e) => e.action === 'verify' && e.ok === false)
      .map((e) => ({
        id: `F3-${session}-${e.seq}`,
        type: 'F3',
        session,
        subject: String(safeJson(e.payload, {}).id ?? ''),
        query: '',
        evidence: JSON.stringify({ verifySeq: e.seq }),
        severity: 'high',
      }))
  }

  /** F7 反馈缺失（元指标）：find 有结果但整个会话无任何 use/miss。 */
  _detectF7(session, evs) {
    const hasAnyFeedback = evs.some((e) => e.action === 'use' || e.action === 'miss')
    if (hasAnyFeedback) return []
    const finds = evs.filter((e) => e.action === 'find' && safeJson(e.returned, []).length > 0)
    if (finds.length === 0) return []
    return [{
      id: `F7-${session}`,
      type: 'F7',
      session,
      subject: '',
      query: '',
      evidence: JSON.stringify({ findCount: finds.length, seqs: finds.map((f) => f.seq) }),
      severity: 'low',
    }]
  }

  /** F4 决策重开：同主题又出现新 decision，而旧条目仍 active。 */
  _detectF4() {
    const memories = Object.values(this.adapter.list('memories') ?? {})
    const decisions = memories.filter((m) => m.kind === 'decision')
    const out = []

    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        const a = decisions[i]
        const b = decisions[j]
        if (a.status !== 'active' || b.status !== 'active') continue
        const shared = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t))
        if (shared.length === 0) continue
        // 同一标签下两条都活着，说明旧决策没有被取代或作废
        const [older, newer] = a.createdAt <= b.createdAt ? [a, b] : [b, a]
        out.push({
          id: `F4-${older.id}-${newer.id}`,
          type: 'F4',
          session: '',
          subject: older.id,
          query: shared.join(','),
          evidence: JSON.stringify({ older: older.id, newer: newer.id, sharedTags: shared }),
        })
      }
    }
    return out
  }

  // ----------------------------------------------------------------
  // 报告
  // ----------------------------------------------------------------

  /**
   * 生成报告。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.forAgent] 输出面向 Agent 的紧凑格式（< 400 token）
   * @returns {object|string}
   */
  report(opts = {}) {
    const failures = Object.values(this.adapter.list('failures') ?? {})
    const counts = {}
    for (const t of Object.keys(FAILURE_CATALOG)) counts[t] = 0
    for (const f of failures) counts[f.type] = (counts[f.type] ?? 0) + 1

    const totalFind = this.events().filter((e) => e.action === 'find' && safeJson(e.returned, []).length > 0).length
    const sessions = new Set(this.events().map((e) => e.session)).size
    // F7 占比：多少比例的"有结果召回"处于无反馈会话中
    const f7 = failures.filter((f) => f.type === 'F7')
    const f7Rate = totalFind === 0 ? 0 : Math.min(1, f7.length / Math.max(1, sessions))

    if (!opts.forAgent) {
      return {
        sessions,
        totalCalls: this.events().length,
        counts,
        f7Rate,
        f2Reliable: f7Rate < 0.3,
        open: failures.filter((f) => f.status === 'open').length,
        failures,
      }
    }

    // 面向 Agent 的紧凑清单
    const lines = []
    lines.push(`MEMORY EVAL — ${sessions} sessions, ${this.events().length} calls`)
    if (f7Rate >= 0.3) {
      lines.push(`F7 feedback-missing  ${(f7Rate * 100).toFixed(0)}%  ⚠ F2 numbers below are unreliable`)
    }
    for (const [t, meta] of Object.entries(FAILURE_CATALOG)) {
      if (counts[t] === 0) continue
      // 示例去重：同一个记忆 id 可能在多处触发（跨 session，或同一 id
      // 出现在多次 find 的返回列表里）。F2 的 subject 本身是逗号分隔的
      // id 列表，所以必须先拆开再去重，否则会显示成 "t2,t3, t2"。
      const subjects = [
        ...new Set(
          failures
            .filter((f) => f.type === t)
            .flatMap((f) => String(f.subject || f.query || '-').split(','))
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ]
      const examples = subjects.slice(0, 2).join(', ')
      const more = subjects.length > 2 ? ` (+${subjects.length - 2} more)` : ''
      lines.push(`${t} ${meta.name.padEnd(14, ' ')} ${String(counts[t]).padStart(2)}  ${examples}${more}`)
    }
    const actions = Object.values(this.adapter.list('actions') ?? {}).filter((a) => a.appliedAt === null)
    if (actions.length) {
      lines.push('')
      lines.push(`ACTIONS (${actions.length})`)
      for (const a of actions.slice(0, 5)) {
        lines.push(` ${a.id}  ${a.kind}: ${a.detail.slice(0, 60)}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * 从失败生成改进项。
   * @returns {Promise<Array<object>>}
   */
  async triage() {
    const failures = Object.values(this.adapter.list('failures') ?? {}).filter((f) => f.status === 'open')
    const existing = this.adapter.list('actions') ?? {}
    /** @type {Array<object>} */
    const created = []

    for (const f of failures) {
      const id = `A-${f.id}`
      if (existing[id]) continue
      const meta = FAILURE_CATALOG[f.type]
      if (!meta?.action) continue

      const ev = safeJson(f.evidence, {})
      let detail = ''
      switch (meta.action) {
        case 'add_memory':
          detail = `未召回后补写了 ${ev.addedId ?? '同主题'}，建议把它固化为正式记忆`
          break
        case 'fix_scope':
          detail = `建议检查 ${f.subject} 的 scope 是否覆盖了当时的 cwd`
          break
        case 'fix_verify':
          detail = `${f.subject} 缺少 verify，无法在使用前确认是否仍成立`
          break
        case 'tune_score':
          detail = `${f.subject} 被召回但未采纳，考虑降权或补充 verify`
          break
        case 'tighten_gate':
          detail = `${f.type === 'F4' ? '同标签下存在多条 active decision' : '存在未裁决的极性冲突'}，建议写入时强制提示`
          break
        default:
          detail = `${meta.name}：${f.subject || f.query || '见证据'}`
      }

      const action = {
        id,
        failureId: f.id,
        kind: meta.action,
        detail: detail.slice(0, 2000),
        appliedAt: null,
        outcome: 'pending',
      }
      await this.adapter.put('actions', id, action)
      created.push(action)
    }
    return created
  }
}

// --------------------------------------------------------------------

function normalizeRel(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    // 去掉盘符与用户主目录，避免绝对路径入库
    .replace(/^[A-Za-z]:/, '')
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .slice(0, 500)
}

function safeJson(s, fallback) {
  try {
    const v = JSON.parse(s)
    return v ?? fallback
  } catch {
    return fallback
  }
}

export { SEVERITY, normalizeRel }