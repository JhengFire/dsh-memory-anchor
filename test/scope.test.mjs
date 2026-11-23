import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, matchesScope, usesWorkspaceScope, globToRegExp } from '../lib/store.mjs'
import { renderHits, renderScope } from '../lib/render.mjs'

function memoryAdapter() {
  const tables = { memories: {}, eval_events: {}, failures: {}, actions: {} }
  return {
    get: (t, k) => tables[t]?.[k],
    put: async (t, k, v) => {
      tables[t][k] = structuredClone(v)
    },
    delete: async (t, k) => {
      delete tables[t][k]
    },
    list: (t) => tables[t] ?? {},
    getGlobal: () => undefined,
    setGlobal: async () => {},
  }
}

const base = { kind: 'constraint', why: '测试', verify: 'echo ok', source: 'test' }
const empty = { memories: {}, eval_events: {}, failures: {}, actions: {} }

// ---------------- workspace scope ----------------

test('scope: workspace 匹配工作区本身', () => {
  assert.equal(matchesScope('D:/repo', ['workspace'], 'D:/repo'), true)
})

test('scope: workspace 匹配工作区子目录', () => {
  assert.equal(matchesScope('D:/repo/src/api', ['workspace'], 'D:/repo'), true)
  assert.equal(matchesScope('D:/repo/a/b/c/d', ['workspace'], 'D:/repo'), true)
})

test('scope: workspace 不匹配工作区外', () => {
  assert.equal(matchesScope('D:/other', ['workspace'], 'D:/repo'), false)
})

test('scope: workspace 不误匹配前缀相同但非子目录', () => {
  // repo-v2 不是 repo 的子目录
  assert.equal(matchesScope('D:/repo-v2', ['workspace'], 'D:/repo'), false)
})

test('scope: workspace 处理 Windows 反斜杠', () => {
  assert.equal(matchesScope('D:\\repo\\src', ['workspace'], 'D:/repo'), true)
  assert.equal(matchesScope('D:/repo/src', ['workspace'], 'D:\\repo'), true)
})

test('scope: workspace 可与其它模式并存', () => {
  assert.equal(matchesScope('D:/elsewhere', ['workspace', 'D:/elsewhere/**'], 'D:/repo'), true)
})

test('usesWorkspaceScope 正确识别', () => {
  assert.equal(usesWorkspaceScope(['workspace']), true)
  assert.equal(usesWorkspaceScope(['src/**', 'workspace']), true)
  assert.equal(usesWorkspaceScope(['src/**']), false)
  assert.equal(usesWorkspaceScope([]), false)
  assert.equal(usesWorkspaceScope(undefined), false)
})

test('find: workspace scope 的条目在工作区内被正常召回', async () => {
  const store = new MemoryStore(memoryAdapter())
  await store.add({ ...base, id: 'ws', claim: '提交前必须跑单测', scope: ['workspace'] })
  const hits = store.find('提交前必须跑单测', { cwd: 'D:/repo/src', workspace: 'D:/repo' })
  assert.ok(hits.some((h) => h.id === 'ws'), '工作区内应召回')
})

test('find: workspace scope 的条目在工作区外被降权', async () => {
  const store = new MemoryStore(memoryAdapter())
  await store.add({ ...base, id: 'ws', claim: '提交前必须跑单测', scope: ['workspace'] })
  await store.add({ ...base, id: 'gl', claim: '提交前必须跑单测', scope: [] })

  const inside = store.find('提交前必须跑单测', { cwd: 'D:/repo', workspace: 'D:/repo', limit: 10 })
  const outside = store.find('提交前必须跑单测', { cwd: 'D:/other', workspace: 'D:/repo', limit: 10 })

  const inScore = inside.find((h) => h.id === 'ws')?.relevance ?? 0
  const outScore = outside.find((h) => h.id === 'ws')?.relevance ?? 0
  assert.ok(inScore > outScore, `工作区内(${inScore}) 应高于工作区外(${outScore})`)
})

test('find: 未指定 workspace 时退化为 cwd', async () => {
  const store = new MemoryStore(memoryAdapter())
  await store.add({ ...base, id: 'ws', claim: '提交前必须跑单测', scope: ['workspace'] })
  const hits = store.find('提交前必须跑单测', { cwd: 'D:/repo', limit: 10 })
  assert.ok(hits.some((h) => h.id === 'ws'), '缺省应把 cwd 当作 workspace')
})

// ---------------- glob 边界（本次修复的 bug） ----------------

test('glob: ** 匹配零个路径段（前缀本身）', () => {
  assert.equal(matchesScope('D:/repo', ['D:/repo/**']), true)
  assert.equal(matchesScope('D:/repo/src', ['D:/repo/**']), true)
  assert.equal(matchesScope('D:/other', ['D:/repo/**']), false)
})

test('glob: 相对路径的 ** 也匹配前缀本身', () => {
  assert.equal(matchesScope('src', ['src/**']), true)
  assert.equal(matchesScope('src/a/b', ['src/**']), true)
})

test('glob: 单星号跨子树但不跨前缀', () => {
  assert.equal(matchesScope('src/a', ['src/*']), true)
  assert.equal(matchesScope('src/a/b', ['src/*']), true)
  assert.equal(matchesScope('other/a', ['src/*']), false)
})

test('glob: 精确路径匹配自身与子路径', () => {
  assert.equal(matchesScope('src/api', ['src/api']), true)
  assert.equal(matchesScope('src/api/v1', ['src/api']), true)
  assert.equal(matchesScope('src/apix', ['src/api']), false)
})

test('glob: 尾部斜杠被忽略', () => {
  assert.equal(matchesScope('src/api', ['src/api/']), true)
  assert.equal(matchesScope('D:/repo/', ['D:/repo/**']), true)
})

void empty
// ---------------- 展示：find 输出必须显示 scope ----------------

test('renderScope: 空 scope 显示 global', () => {
  assert.equal(renderScope([]), 'global')
  assert.equal(renderScope(undefined), 'global')
})

test('renderScope: 非空 scope 逗号连接', () => {
  assert.equal(renderScope(['workspace']), 'workspace')
  assert.equal(renderScope(['workspace', 'src/api/**']), 'workspace, src/api/**')
})

test('renderHits: 每条结果都带 scope 行', () => {
  const out = renderHits([
    { id: 'a', kind: 'constraint', claim: '规范A', scope: ['workspace'], status: 'active', stability: 'settled', verify: 'echo', lastVerified: null },
    { id: 'b', kind: 'constraint', claim: '规范B', scope: [], status: 'active', stability: 'settled', verify: 'echo', lastVerified: null },
  ])
  assert.match(out, /scope: workspace/)
  assert.match(out, /scope: global/)
})

test('renderHits: 空结果给明确文案', () => {
  assert.equal(renderHits([]), 'no matching memories')
})
