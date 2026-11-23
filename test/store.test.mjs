import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, matchesScope, globToRegExp, WRITE_TRIGGERS } from '../lib/store.mjs'

/** 最小内存适配器，模拟 storageDomain 的同步读 + 异步写语义 */
function memoryAdapter() {
  // 表名与 schema.mjs 保持一致（DSH 要求小写+下划线）
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

function newStore(opts) {
  return new MemoryStore(memoryAdapter(), opts)
}

const base = {
  kind: 'gotcha',
  why: '客户 2026-03 定的',
  scope: ['src/surface/**'],
  verify: "rg -n 'latch' src/surface/",
  source: 'test',
}

// ---------------- 写入闸门 ----------------

test('add: 基本写入成功', async () => {
  const s = newStore()
  const r = await s.add({ ...base, id: 'lock-lot', claim: '表面处理失败后必须锁 3 个后续 lot' })
  assert.equal(r.ok, true)
  assert.equal(r.verdict, 'insert')
  assert.equal(s.get('lock-lot').status, 'active')
  assert.equal(s.get('lock-lot').revision, 1)
})

test('add: 非法 kind 被拒绝', async () => {
  const s = newStore()
  const r = await s.add({ ...base, id: 'x', kind: 'note', claim: '随便记一条' })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'invalid')
  assert.match(r.message, /kind 必须是/)
})

test('add: 空 claim 被拒绝', async () => {
  const s = newStore()
  assert.equal((await s.add({ ...base, id: 'x', claim: '   ' })).ok, false)
})

test('add: 多句断言被拒绝（可证伪性要求单句）', async () => {
  const s = newStore()
  const r = await s.add({ ...base, id: 'x', claim: '第一件事。第二件事。第三件事。' })
  assert.equal(r.ok, false)
  assert.match(r.message, /单句/)
})

test('add: 相似内容触发 merge 提示而非重复插入', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', claim: '表面处理失败后必须锁 3 个后续 lot' })
  const check = s.inspectWrite({ kind: 'gotcha', claim: '表面处理失败后必须锁 3 个后续 lots' })
  assert.equal(check.verdict, 'merge')
  assert.ok(check.duplicates.length > 0)
})

// ---------------- 冲突：什么时候问人 ----------------

test('conflict: 极性相反的决策被拦截，必须人工裁决', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'snapshot-ban', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  const r = await s.add({ ...base, id: 'snapshot-ok', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖' })
  assert.equal(r.ok, false, '冲突时不得自动写入')
  assert.equal(r.verdict, 'conflict')
  assert.match(r.message, /必须人工确认/)
})

test('conflict: force + onConflict=both → 新条目为 provisional', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  const r = await s.add({
    ...base, id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖',
    force: true, onConflict: 'both',
  })
  assert.equal(r.ok, true)
  assert.equal(s.get('b').stability, 'provisional', '未确认的结论必须显式标为 provisional')
  assert.equal(s.get('a').status, 'active', '两条并列时旧条目仍在')
})

test('conflict: force + onConflict=newer → 显式取代，旧条目 superseded', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  const r = await s.add({
    ...base, id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖',
    force: true, onConflict: 'newer',
  })
  assert.equal(r.ok, true)
  assert.equal(s.get('a').status, 'superseded')
  assert.equal(s.get('b').supersedes, 'a')
  assert.equal(s.get('b').revision, 2, '取代应产生版本号递增')
})

test('conflict: 同极性不互相拦截', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  const r = await s.add({ ...base, id: 'b', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 与 beta 依赖' })
  assert.equal(r.ok, true)
})

test('overwrite: 同槽覆盖自动取代（昨天→前天），无需人工', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'eat-1', kind: 'gotcha', claim: '我昨天吃了一个苹果' })
  const r = await s.add({ ...base, id: 'eat-2', kind: 'gotcha', claim: '我前天吃了一个苹果' })
  assert.equal(r.ok, true)
  assert.equal(r.verdict, 'overwrite')
  assert.equal(s.get('eat-1').status, 'superseded', '同槽覆盖视为更正，自动作废旧值')
})

// ---------------- 检索 ----------------

test('find: 命中相关记忆', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'lock-lot', claim: '表面处理失败后必须锁 3 个后续 lot' })
  await s.add({ ...base, id: 'dto', kind: 'constraint', claim: 'DTO 统一用 xxx 后缀，不允许用 Dto' })
  const r = s.find('表面处理失败怎么办')
  assert.ok(r.length > 0)
  assert.equal(r[0].id, 'lock-lot')
})

test('find: scope 匹配的条目排在前面（不匹配的降权而非丢弃）', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'lock-lot', claim: '表面处理失败后必须锁 3 个后续 lot', scope: ['src/surface/**'] })
  await s.add({ ...base, id: 'equip', claim: '表面处理设备需每日点检', scope: ['src/equip/**'] })

  const inSurface = s.find('表面处理', { cwd: 'src/surface/handler' })
  assert.ok(inSurface.some((x) => x.id === 'lock-lot'), '同 scope 的必须召回')

  // 设计变更：scope 不匹配不再完全隐藏，而是降权。
  // 早期直接丢弃导致「换目录就查不到刚写的记忆」，体验上等同丢失。
  // 若 equip 仍被召回，它必须排在 lock-lot 之后。
  const posLock = inSurface.findIndex((x) => x.id === 'lock-lot')
  const posEquip = inSurface.findIndex((x) => x.id === 'equip')
  if (posEquip >= 0) {
    assert.ok(posLock < posEquip, '同 scope 的应排在不匹配的前面')
  }
})

test('find: 无 scope 的条目视为全局，任何目录都能召回', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'global', claim: '所有时间统一使用 Asia/Shanghai 时区', scope: [] })
  const r = s.find('时区', { cwd: '任意/目录/深度' })
  assert.ok(r.some((x) => x.id === 'global'))
})

test('find: retired 默认不返回，但 includeRetired 可见', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'x', claim: '这是一条会被淘汰的记忆' })
  for (let i = 0; i < 3; i++) await s.miss('x')
  assert.equal(s.get('x').status, 'retired')
  assert.equal(s.find('淘汰的记忆').some((x) => x.id === 'x'), false)
  assert.equal(s.find('淘汰的记忆', { includeRetired: true }).some((x) => x.id === 'x'), true)
})

test('find: 空查询返回空数组', () => {
  assert.deepEqual(newStore().find('  '), [])
})

test('find: 结果带 conflictsWith 标注', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  await s.add({ ...base, id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖', force: true, onConflict: 'both' })
  const r = s.find('SNAPSHOT 依赖', { limit: 10 })
  const a = r.find((x) => x.id === 'a')
  assert.ok(a, '冲突状态下两条都应该能被召回')
  assert.ok(a.conflictsWith.includes('b') || r.find((x) => x.id === 'b')?.conflictsWith.includes('a'))
})

// ---------------- 生命周期 ----------------

test('use: 增加 hits 并复活 retired', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'x', claim: '某条记忆' })
  for (let i = 0; i < 3; i++) await s.miss('x')
  assert.equal(s.get('x').status, 'retired')
  await s.use('x')
  assert.equal(s.get('x').hits, 1)
  assert.equal(s.get('x').status, 'active', '被采纳即复活')
})

test('miss: 达阈值且零采纳 → retired', async () => {
  const s = newStore({ retireMisses: 3 })
  await s.add({ ...base, id: 'x', claim: '某条记忆' })
  await s.miss('x'); await s.miss('x')
  assert.equal(s.get('x').status, 'active')
  await s.miss('x')
  assert.equal(s.get('x').status, 'retired')
})

test('miss: 有过采纳记录的条目不因 miss 被淘汰', async () => {
  const s = newStore({ retireMisses: 3 })
  await s.add({ ...base, id: 'x', claim: '某条记忆' })
  await s.use('x')
  for (let i = 0; i < 3; i++) await s.miss('x')
  assert.notEqual(s.get('x').status, 'retired')
})

test('verify: 失败转 stale，通过恢复 active', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'x', claim: '某条记忆' })
  await s.verify('x', false)
  assert.equal(s.get('x').status, 'stale')
  await s.verify('x', true)
  assert.equal(s.get('x').status, 'active')
  assert.ok(s.get('x').lastVerified)
})

test('gc: 默认 dry-run 不写库', async () => {
  const s = newStore({ staleDays: 0 })
  await s.add({ ...base, id: 'x', claim: '某条记忆' })
  const r = await s.gc(false)
  assert.equal(r.applied, false)
  assert.ok(r.changes.length > 0)
  assert.equal(s.get('x').status, 'active')
})

test('gc: apply 幂等 —— 连跑两次结果一致', async () => {
  const s = newStore({ staleDays: 0 })
  await s.add({ ...base, id: 'x', claim: '某条记忆' })
  await s.gc(true)
  const after1 = s.get('x').status
  await s.gc(true)
  assert.equal(s.get('x').status, after1)
})

test('resolve: keepA 使 A settled、B superseded', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  await s.add({ ...base, id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖', force: true, onConflict: 'both' })
  const r = await s.resolve('a', 'b', 'keepA')
  assert.equal(r.ok, true)
  assert.equal(s.get('a').stability, 'settled')
  assert.equal(s.get('b').status, 'superseded')
  assert.equal(s.get('a').supersedes, 'b')
})

test('resolve: both 保留两条为 provisional', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  await s.add({ ...base, id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖', force: true, onConflict: 'both' })
  await s.resolve('a', 'b', 'both')
  assert.equal(s.get('a').stability, 'provisional')
  assert.equal(s.get('b').stability, 'provisional')
})

// ---------------- stats ----------------

test('stats: 暴露健康度指标', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'a', claim: '有 verify 的记忆' })
  await s.add({ ...base, id: 'b', claim: '没有验证方式的记忆', verify: '' })
  const st = s.stats()
  assert.equal(st.total, 2)
  assert.equal(st.unverifiable, 1)
  assert.equal(st.neverVerified, 2)
  assert.ok(st.unverifiablePct > 0)
})

// ---------------- scope glob ----------------

test('glob: ** 匹配任意深度', () => {
  assert.ok(matchesScope('src/surface/handler/x', ['src/surface/**']))
  assert.ok(matchesScope('src/surface/a', ['src/surface/**']))
  assert.ok(!matchesScope('src/equip/a', ['src/surface/**']))
})

test('glob: * 匹配单段及其子树（scope 是目录范围语义）', () => {
  assert.ok(matchesScope('src/a', ['src/*']))
  // scope 表达"约束哪个区域"，该区域天然包含子目录，
  // 因此 src/a/b 也应匹配 src/*。这与 .gitignore 的 * 不同，是刻意选择。
  assert.ok(matchesScope('src/a/b', ['src/*']))
  // 但不得跨出该层的一级以外的前缀
  assert.ok(!matchesScope('other/a', ['src/*']))
})

test('glob: 反斜杠路径被归一化', () => {
  assert.ok(matchesScope('src\\surface\\x', ['src/surface/**']))
})

test('glob: 精确路径匹配自身与子路径', () => {
  assert.ok(matchesScope('src/surface', ['src/surface']))
  assert.ok(matchesScope('src/surface/x', ['src/surface']))
  assert.ok(!matchesScope('src/surfaceX', ['src/surface']))
})

test('WRITE_TRIGGERS: 只允许四类写入来源', () => {
  assert.deepEqual(WRITE_TRIGGERS, ['decision', 'rejected', 'gotcha', 'constraint'])
})
// ---------------- 实施后修正：检索相关性与 scope 降权 ----------------

test('find: 无关条目被相关性下限挡住', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'tz', kind: 'constraint', claim: '所有时间统一使用 Asia/Shanghai 时区', scope: [] })
  await s.add({ ...base, id: 'snap', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖', scope: [] })
  const r = s.find('SNAPSHOT 依赖', { limit: 10 })
  const ids = r.map((x) => x.id)
  assert.ok(ids.includes('snap'), '相关条目必须在结果里')
  assert.ok(!ids.includes('tz'), `无关条目不应出现，实际返回 ${ids.join(',')}`)
})

test('find: scope 不匹配时降权而非丢弃（刚写入就能查到）', async () => {
  const s = newStore()
  await s.add({
    ...base, id: 'lock', kind: 'gotcha',
    claim: '表面处理失败后必须锁 3 个后续 lot',
    scope: ['src/surface/**'],
  })
  // 从一个不匹配的目录检索
  const r = s.find('表面处理失败怎么办', { cwd: 'docs/other', limit: 5 })
  assert.ok(r.some((x) => x.id === 'lock'), 'scope 不匹配不应导致完全查不到')
})

test('find: scope 匹配的条目排名高于不匹配的', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'in', kind: 'gotcha', claim: '表面处理失败必须锁批次', scope: ['src/surface/**'] })
  await s.add({ ...base, id: 'out', kind: 'gotcha', claim: '表面处理失败必须锁批次', scope: ['src/equip/**'] })
  const r = s.find('表面处理失败', { cwd: 'src/surface/x', limit: 5 })
  const posIn = r.findIndex((x) => x.id === 'in')
  const posOut = r.findIndex((x) => x.id === 'out')
  assert.ok(posIn >= 0, '匹配的必须在结果里')
  if (posOut >= 0) assert.ok(posIn < posOut, '匹配的应排在前面')
})

test('find: relevance 保持 [0,1] 语义（不被业务权重污染）', async () => {
  const s = newStore()
  await s.add({ ...base, id: 'x', kind: 'rejected', claim: '否决用 Kafka 做缓存失效' })
  await s.use('x')
  await s.use('x')
  const r = s.find('kafka', { limit: 5 })
  for (const item of r) {
    assert.ok(item.relevance <= 1.0, `relevance 不应超过 1，实际 ${item.relevance}`)
    assert.ok(item.relevance >= 0, 'relevance 不应为负')
  }
})

test('inspectWrite: 冲突与重复同时存在时，重复信息不得被吞掉', async () => {
  const s = newStore()
  // 两条完全相同的约束（模拟真实库里的 probe-3 / acc-a）
  await s.add({ ...base, id: 'dup1', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖', force: true })
  await s.add({ ...base, id: 'dup2', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖', force: true })
  // 一条极性相反的
  await s.add({ ...base, id: 'opp', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖', force: true, onConflict: 'both' })

  const check = s.inspectWrite({ kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' })
  assert.equal(check.verdict, 'conflict', '极性冲突应优先')
  assert.ok(check.duplicates.length >= 2, `重复信息不得被吞掉，实际 ${check.duplicates.length} 条`)
  assert.match(check.message, /内容重复/, '消息里应提示存在重复')
})
