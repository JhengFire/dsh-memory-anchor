import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')

/**
 * 跨模型检索的行为约束。
 *
 * 这三条断言防的是同一类回归：换了向量模型之后，
 * 老条目不应该**静默消失**。第一版实现里给的 relevance=0
 * 会被 floor 直接 continue 掉，而设计文档写的是「降权而非丢弃」。
 */
test('store.find: 跨模型条目打上 unsure 标记而不是丢弃', () => {
  assert.match(src, /let unsure = false/, '应有 unsure 状态')
  assert.match(src, /unsure = true/, '跨模型分支应置位')
  assert.doesNotMatch(
    src,
    /relevance = 0\s*\n\s*\}/,
    '不能把跨模型相关性赋 0：会被 floor 过滤掉，等于静默丢弃',
  )
})

test('store.find: 返回值带上 unsureAt 供渲染层提示 reindex', () => {
  assert.match(src, /out\.unsureAt = recModel/, '结果里应带 unsureAt')
})

test('render: 跨模型条目渲染出明确标记', () => {
  const render = readFileSync(new URL('../lib/render.mjs', import.meta.url), 'utf8')
  assert.match(render, /h\.unsureAt/, '渲染层应识别 unsureAt')
  assert.match(render, /reindex needed/, '标记里应指路 reindex')
})

test('thresholds: 每个已登记模型的阈值都是正数且随维度分开', () => {
  const th = readFileSync(new URL('../lib/thresholds.mjs', import.meta.url), 'utf8')
  const nums = [...th.matchAll(/'([\w-]+)':\s*([\d.]+)/g)].map((m) => ({ model: m[1], floor: Number(m[2]) }))
  assert.ok(nums.length >= 3, '应至少登记 hash 与两种远程维度')
  for (const { model, floor } of nums) {
    assert.ok(floor > 0 && floor < 1, `${model} 的阈值 ${floor} 不在 (0,1) 内`)
  }
  // 哈希与远程的分数分布差一个量级，共用一个阈值必然错一边
  const hash = nums.find((n) => n.model === 'hash-512')
  const remote = nums.find((n) => n.model === 'remote-1024')
  assert.ok(hash && remote, '应同时登记 hash-512 与 remote-1024')
  assert.ok(hash.floor < remote.floor, '哈希阈值应低于远程阈值')
})