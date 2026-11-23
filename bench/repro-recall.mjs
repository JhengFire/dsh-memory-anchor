/**
 * 复现验收中报告的问题 1：find「表面处理失败怎么办」未命中 acc-lock。
 * 用真实存储数据，逐个看相似度分数。
 */
import fs from 'node:fs'
import { embed, cosine, decodeFromStorage, cosineQuantized, quantize } from '../lib/vector.mjs'
import { MemoryStore } from '../lib/store.mjs'

const DIR = 'C:/Users/AK-FMSB-0186/.dsh/storages/memory_anchor'
const tables = { memories: {}, eval_events: {}, failures: {}, actions: {} }
for (const t of Object.keys(tables)) {
  const d = `${DIR}/${t}`
  if (!fs.existsSync(d)) continue
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
    const rec = JSON.parse(fs.readFileSync(`${d}/${f}`, 'utf8')).record
    const key = t === 'eval_events' ? String(rec.seq) : rec.id || f.replace('.json', '')
    tables[t][key] = rec
  }
}

console.log('=== 库中全部记忆 ===')
for (const m of Object.values(tables.memories)) {
  console.log(`  ${m.id.padEnd(16)} status=${m.status.padEnd(10)} scope=[${(m.scope ?? []).join(',')}]  ${m.claim.slice(0, 30)}`)
}

const adapter = {
  get: (t, k) => tables[t]?.[k],
  put: async () => {},
  delete: async () => {},
  list: (t) => tables[t] ?? {},
  getGlobal: () => undefined,
  setGlobal: async () => {},
}

// 验收时的 cwd（子代理的工作目录）
const cwd = process.cwd()
console.log(`\n当前 cwd: ${cwd}`)

const store = new MemoryStore(adapter)

const queries = ['表面处理失败怎么办', 'SNAPSHOT 依赖']
for (const q of queries) {
  console.log(`\n=== query: "${q}" ===`)
  const qv = embed(q)
  const qb = quantize(qv)
  const rows = []
  for (const m of Object.values(tables.memories)) {
    const v = decodeFromStorage(m.embedding)
    const score = cosineQuantized(qb, v)
    const floatScore = cosine(qv, decodeFromStorage(m.embedding))
    rows.push({ id: m.id, claim: m.claim.slice(0, 30), score, floatScore, status: m.status, scope: m.scope })
  }
  rows.sort((a, b) => b.score - a.score)
  for (const r of rows) {
    console.log(`  ${r.score.toFixed(4)} (float ${r.floatScore.toFixed(4)})  ${r.id.padEnd(16)} ${r.status.padEnd(10)} ${r.claim}`)
  }

  console.log('  --- store.find 实际结果 ---')
  const found = store.find(q, { limit: 5, cwd })
  console.log('  ', found.length === 0 ? '(空)' : found.map((x) => `${x.id}(${x.relevance.toFixed(3)})`).join(', '))
}