/**
 * 用真实存储数据复现评测检测器，验证 F2 的 subject 重复问题。
 */
import fs from 'node:fs'
import { Evaluator } from '../lib/eval.mjs'

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

const adapter = {
  get: (t, k) => tables[t]?.[k],
  put: async () => {},
  delete: async () => {},
  list: (t) => tables[t] ?? {},
  getGlobal: () => undefined,
  setGlobal: async () => {},
}

const e = new Evaluator(adapter)
const found = await e.analyze()

console.log('=== F2 检出 ===')
for (const f of found.filter((x) => x.type === 'F2')) {
  console.log(`id=${f.id}`)
  console.log(`  subject=${f.subject}`)
  console.log(`  session=${f.session.slice(0, 8)}  severity=${f.severity}`)
  console.log(`  evidence=${f.evidence}`)
}
console.log('\n=== F7 检出 ===')
for (const f of found.filter((x) => x.type === 'F7')) {
  console.log(`id=${f.id}  session=${f.session.slice(0, 8)}  evidence=${f.evidence}`)
}
console.log('\n=== 全部类型计数 ===')
const counts = {}
for (const f of found) counts[f.type] = (counts[f.type] ?? 0) + 1
console.log(counts)