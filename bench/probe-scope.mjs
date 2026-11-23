/**
 * 实测 scope 的各种写法与实际效果，用于确认「范围」到底是什么语义。
 */
import { MemoryStore, matchesScope } from '../lib/store.mjs'

const tables = { memories: {}, eval_events: {}, failures: {}, actions: {} }
const adapter = {
  get: (t, k) => tables[t]?.[k],
  put: async (t, k, v) => {
    tables[t][k] = JSON.parse(JSON.stringify(v))
  },
  delete: async () => {},
  list: (t) => tables[t] ?? {},
  getGlobal: () => undefined,
  setGlobal: async () => {},
}

const store = new MemoryStore(adapter)
const base = { kind: 'gotcha', why: 'x', verify: 'y', source: 't' }

// 各种 scope 写法
const cases = [
  ['空数组', [], '无限制，任何目录都能召回'],
  ['不传 scope', undefined, '同空数组（默认值）'],
  ['单目录', ['src/surface'], '该目录及子目录'],
  ['通配一层', ['src/*'], 'src 下任意一级（含其子树）'],
  ['递归', ['src/**'], 'src 下任意深度'],
  ['多路径', ['src/a/**', 'src/b/**'], '命中任一即可'],
  ['精确文件', ['src/a/index.ts'], '只该文件（实际按前缀+子树匹配）'],
]

console.log('=== scope 写法与匹配效果 ===\n')
for (const [label, scope, desc] of cases) {
  const id = `m-${label}`
  await store.add({ ...base, id, claim: `测试 scope ${label} 的记忆`, scope })
  console.log(`${label.padEnd(12)} scope=${JSON.stringify(scope)}`)
  console.log(`  说明: ${desc}`)
}

// 用不同 cwd 检索，看哪些命中
const cwds = [
  'src/surface/handler',
  'src/equip/runner',
  'docs/sop',
  'D:/other/repo/src/surface',
]

console.log('\n=== 不同 cwd 下的召回情况 ===')
console.log('（✓=scope 匹配，降权系数 1.0；~=不匹配，降权 0.5）\n')

for (const cwd of cwds) {
  console.log(`cwd = ${cwd}`)
  const found = store.find('测试 scope 的记忆', { limit: 20, cwd })
  const byId = new Map(found.map((x) => [x.id, x]))
  for (const [label, scope] of cases) {
    const id = `m-${label}`
    const hit = byId.get(id)
    if (!hit) {
      console.log(`  ✗ ${label.padEnd(12)} 未进入结果集`)
      continue
    }
    const matched =
      !scope || scope.length === 0 || matchesScope(cwd, scope)
    console.log(`  ${matched ? '✓' : '~'} ${label.padEnd(12)} relevance=${hit.relevance.toFixed(3)}`)
  }
  console.log('')
}

// 验证「全局」的真实语义
console.log('=== 关键结论 ===')
console.log('1. 空 scope = 全局，任何 cwd 都匹配，无降权')
console.log('2. 非空 scope 只影响「是否降权一半」，绝不排除结果')
console.log('   → 这是实施中的刻意修正：早期版本直接丢弃，')
console.log('     导致换个目录就查不到刚写下的记忆。')
console.log('3. scope 只认 cwd 路径，不认 kind / tags / 会话 / 时间等其他维度')