import test from 'node:test'
import assert from 'node:assert/strict'
import { Evaluator } from '../lib/eval.mjs'

function memoryAdapter() {
  const tables = { memories: {}, eval_events: {}, failures: {}, actions: {} }
  return {
    get: (t, k) => tables[t]?.[k],
    put: async (t, k, v) => { tables[t][k] = structuredClone(v) },
    delete: async (t, k) => { delete tables[t][k] },
    list: (t) => tables[t] ?? {},
    getGlobal: () => undefined,
    setGlobal: async () => {},
  }
}

test('report forAgent: F2 的多 id subject 被拆开去重', async () => {
  const e = new Evaluator(memoryAdapter())
  // 两次 find：一次返回 t2,t3（列表），一次返回 t2
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: ['t2', 't3'] })
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: ['t2'] })
  // 会话内有反馈行为，才判 F2
  await e.record({ session: 's1', action: 'use', payload: { id: 'other' } })

  await e.analyze()
  const txt = e.report({ forAgent: true })

  // t2 只应出现一次（去重后）
  const t2Count = (txt.match(/\bt2\b/g) ?? []).length
  assert.equal(t2Count, 1, `t2 应只出现一次，实际 ${t2Count} 次:\n${txt}`)
  assert.match(txt, /t2, t3/, `应展示去重后的 id 列表:\n${txt}`)
})

test('report forAgent: 单个 subject 保持原样', async () => {
  const e = new Evaluator(memoryAdapter())
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: ['only-one'] })
  await e.record({ session: 's1', action: 'use', payload: { id: 'other' } })
  await e.analyze()
  const txt = e.report({ forAgent: true })
  assert.match(txt, /only-one/)
  assert.ok(!txt.includes('only-one, only-one'), '不应重复')
})

test('report forAgent: 超过两个去重后的 id 标注 more', async () => {
  const e = new Evaluator(memoryAdapter())
  await e.record({ session: 's1', action: 'find', payload: { query: 'q' }, returned: ['a1', 'a2', 'a3'] })
  await e.record({ session: 's1', action: 'use', payload: { id: 'other' } })
  await e.analyze()
  const txt = e.report({ forAgent: true })
  assert.match(txt, /\(\+1 more\)/, `应有 more 标注:\n${txt}`)
})