import test from 'node:test'
import assert from 'node:assert/strict'
import { Evaluator, FAILURE_CATALOG, normalizeRel } from '../lib/eval.mjs'

function memoryAdapter() {
  // 表名必须与 schema.mjs 的 lwmDomain.tables 一致：
  // DSH storage 要求 /^[a-z][a-z0-9_]*$/，因此是 eval_events 而非 evalEvents
  const tables = { memories: {}, eval_events: {}, failures: {}, actions: {} }
  let global = undefined
  return {
    get: (t, k) => tables[t]?.[k],
    put: async (t, k, v) => { tables[t][k] = structuredClone(v) },
    delete: async (t, k) => { delete tables[t][k] },
    list: (t) => tables[t] ?? {},
    getGlobal: () => global,
    setGlobal: async (v) => { global = structuredClone(v) },
    _tables: tables,
  }
}

const newEval = (opts) => new Evaluator(memoryAdapter(), opts)

// ---------------- 采集 ----------------

test('record: 事件序号自增且不与已有冲突', async () => {
  const e = newEval()
  const a = await e.record({ session: 's1', action: 'find' })
  const b = await e.record({ session: 's1', action: 'find' })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
})

test('record: cwd 归一化为相对路径（不泄露绝对路径）', async () => {
  const e = newEval()
  const ev = await e.record({ session: 's', action: 'find', cwd: 'D:\\proj\\src\\a' })
  assert.ok(!ev.cwd.includes('D:'), `不应包含盘符: ${ev.cwd}`)
  assert.ok(ev.cwd.includes('src/a'))
})

test('record: payload 只存摘要并截断', async () => {
  const e = newEval()
  const ev = await e.record({ session: 's', action: 'find', payload: { query: 'x'.repeat(10000) } })
  assert.ok(ev.payload.length <= 4000)
})

test('normalizeRel: 去掉用户主目录', () => {
  assert.ok(normalizeRel('/home/alice/x').startsWith('~'))
  assert.ok(normalizeRel('/Users/bob/y').startsWith('~'))
})

// ---------------- F1 未召回 ----------------

test('F1: 空召回后 30 分钟内补写 → 检出', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: '表面处理失败' }, returned: [] })
  await e.record({ session: 's1', action: 'add', payload: { id: 'lock-lot', query: '表面处理失败' } })
  const f = await e.analyze()
  const f1 = f.filter((x) => x.type === 'F1')
  assert.equal(f1.length, 1)
  assert.equal(f1[0].subject, 'lock-lot')
})

test('F1: 空召回但未补写 → 不误报', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: '无关查询' }, returned: [] })
  const f = await e.analyze()
  assert.equal(f.filter((x) => x.type === 'F1').length, 0)
})

// ---------------- F2 召回但无用 ----------------

test('F2: 有召回但无反馈，且会话具备反馈能力 → 检出', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'a' }, returned: ['m1', 'm2'] })
  // 会话里别处有过反馈，说明 Agent 是接线的
  await e.record({ session: 's1', action: 'use', payload: { id: 'other' } })
  const f = await e.analyze()
  assert.equal(f.filter((x) => x.type === 'F2').length, 1)
})

test('F2: 召回后有用 use → 不检出', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'a' }, returned: ['m1'] })
  await e.record({ session: 's1', action: 'use', payload: { id: 'm1' } })
  const f = await e.analyze()
  assert.equal(f.filter((x) => x.type === 'F2').length, 0)
})

test('F2: 返回 ≥5 条仍无采纳 → severity=high', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'a' }, returned: ['a', 'b', 'c', 'd', 'e'] })
  await e.record({ session: 's1', action: 'use', payload: { id: 'other' } })
  const f = await e.analyze()
  const f2 = f.filter((x) => x.type === 'F2')
  assert.equal(f2[0].severity, 'high')
})

test('F2: 整个会话零反馈时不判 F2（那是 F7 的事）', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'a' }, returned: ['m1'] })
  const f = await e.analyze()
  assert.equal(f.filter((x) => x.type === 'F2').length, 0, 'F7 场景不应同时报 F2，否则污染统计')
})

// ---------------- F7 元指标 ----------------

test('F7: 召回后全会话无反馈 → 检出', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'a' }, returned: ['m1'] })
  const f = await e.analyze()
  const f7 = f.filter((x) => x.type === 'F7')
  assert.equal(f7.length, 1)
  assert.equal(f7[0].severity, 'low')
})

test('F7: 有反馈则不检出', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'a' }, returned: ['m1'] })
  await e.record({ session: 's1', action: 'miss', payload: { id: 'm1' } })
  const f = await e.analyze()
  assert.equal(f.filter((x) => x.type === 'F7').length, 0)
})

// ---------------- F3 验证失败 ----------------

test('F3: verify 失败 → 检出且 high', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'verify', payload: { id: 'm1' }, ok: false })
  const f = await e.analyze()
  const f3 = f.filter((x) => x.type === 'F3')
  assert.equal(f3.length, 1)
  assert.equal(f3[0].severity, 'high')
  assert.equal(f3[0].subject, 'm1')
})

// ---------------- F4 决策重开 ----------------

test('F4: 同标签下两条 active decision → 检出', async () => {
  const e = newEval()
  await e.adapter.put('memories', 'd1', {
    id: 'd1', kind: 'decision', claim: '用 A 方案', tags: ['架构'], status: 'active',
    createdAt: '2026-01-01T00:00:00Z', stability: 'settled',
  })
  await e.adapter.put('memories', 'd2', {
    id: 'd2', kind: 'decision', claim: '用 B 方案', tags: ['架构'], status: 'active',
    createdAt: '2026-02-01T00:00:00Z', stability: 'settled',
  })
  const f = await e.analyze()
  const f4 = f.filter((x) => x.type === 'F4')
  assert.equal(f4.length, 1)
  assert.equal(f4[0].subject, 'd1', '应指出较早的那条')
})

test('F4: 旧决策已 superseded → 不检出', async () => {
  const e = newEval()
  await e.adapter.put('memories', 'd1', {
    id: 'd1', kind: 'decision', claim: '用 A', tags: ['架构'], status: 'superseded',
    createdAt: '2026-01-01T00:00:00Z', stability: 'settled',
  })
  await e.adapter.put('memories', 'd2', {
    id: 'd2', kind: 'decision', claim: '用 B', tags: ['架构'], status: 'active',
    createdAt: '2026-02-01T00:00:00Z', stability: 'settled',
  })
  const f = await e.analyze()
  assert.equal(f.filter((x) => x.type === 'F4').length, 0)
})

// ---------------- analyze 幂等 ----------------

test('analyze: 重复分析幂等', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'verify', payload: { id: 'm1' }, ok: false })
  await e.analyze()
  const n1 = Object.keys(e.adapter.list('failures')).length
  await e.analyze()
  const n2 = Object.keys(e.adapter.list('failures')).length
  assert.equal(n1, n2)
})

test('analyze: 保留人工归因结论', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'verify', payload: { id: 'm1' }, ok: false })
  await e.analyze()
  const id = Object.keys(e.adapter.list('failures'))[0]
  const f = e.adapter.get('failures', id)
  await e.adapter.put('failures', id, { ...f, rootCause: '人为填写', status: 'fixed' })
  await e.analyze()
  assert.equal(e.adapter.get('failures', id).rootCause, '人为填写')
  assert.equal(e.adapter.get('failures', id).status, 'fixed')
})

// ---------------- report / triage ----------------

test('report: 结构完整', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'verify', payload: { id: 'm1' }, ok: false })
  await e.analyze()
  const r = e.report()
  assert.equal(r.sessions, 1)
  assert.equal(r.counts.F3, 1)
  assert.ok(typeof r.f7Rate === 'number')
})

test('report forAgent: 输出紧凑且含警告', async () => {
  const e = newEval()
  // 制造 F7 高发的会话
  for (let i = 0; i < 3; i++) {
    await e.record({ session: `s${i}`, action: 'find', payload: { query: 'q' }, returned: ['m1'] })
  }
  await e.analyze()
  const txt = e.report({ forAgent: true })
  assert.ok(txt.includes('MEMORY EVAL'))
  assert.ok(txt.length < 1200, `紧凑输出应 < 1200 字符，实际 ${txt.length}`)
})

test('triage: 为可行动失败生成改进项', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: [] })
  await e.record({ session: 's1', action: 'add', payload: { id: 'new-mem' } })
  await e.analyze()
  const actions = await e.triage()
  assert.ok(actions.length > 0)
  assert.equal(actions[0].kind, 'add_memory')
  assert.equal(actions[0].outcome, 'pending')
})

test('triage: F3 不生成 action（已自动处理为 stale）', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'verify', payload: { id: 'm1' }, ok: false })
  await e.analyze()
  const actions = await e.triage()
  assert.equal(actions.filter((a) => a.failureId.startsWith('F3')).length, 0)
})

test('triage: 重复 triage 不重复生成', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'verify', payload: { id: 'm1' }, ok: false })
  await e.analyze()
  await e.triage()
  const n1 = Object.keys(e.adapter.list('actions')).length
  await e.triage()
  assert.equal(Object.keys(e.adapter.list('actions')).length, n1)
})

test('catalog: 七类失败都有定义', () => {
  assert.deepEqual(Object.keys(FAILURE_CATALOG).sort(), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'])
})
test('report forAgent: 同一 subject 跨会话触发时不重复罗列', async () => {
  const e = newEval()
  // 两个会话各自召回同一条记忆但都没用
  for (const s of ['s1', 's2']) {
    await e.record({ session: s, action: 'find', payload: { query: 'q' }, returned: ['same-mem'] })
    await e.record({ session: s, action: 'use', payload: { id: 'other' } })
  }
  await e.analyze()
  const txt = e.report({ forAgent: true })
  const occurrences = (txt.match(/same-mem/g) ?? []).length
  assert.equal(occurrences, 1, `同一 subject 应只出现一次，实际 ${occurrences} 次:\n${txt}`)
})

test('report forAgent: 超过两个 subject 时标注 more', async () => {
  const e = newEval()
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: ['m1'] })
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: ['m2'] })
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: ['m3'] })
  await e.record({ session: 's1', action: 'use', payload: { id: 'other' } })
  await e.analyze()
  const txt = e.report({ forAgent: true })
  assert.match(txt, /\+1 more/)
})
