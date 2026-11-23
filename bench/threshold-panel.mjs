/**
 * 阈值面板：在一个真实 API 下，看每个阈值会放进去什么、挡掉什么。
 *
 * 目的不是「通过测试」，而是回答一个具体问题：
 *   当前 floor=0.55 在你的真实记忆上，是否挡掉了本该召回的查询？
 *
 * 用法：node bench/threshold-panel.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProvider, unpackStored, similarity } from '../lib/embedding.mjs'
import { floorFor } from '../lib/thresholds.mjs'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PATCH = path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')
const MEMDIR = path.join(HOME, 'storages', 'memory_anchor', 'memories')

const block = fs.readFileSync(PATCH, 'utf8').split(/- id: memory-anchor/)[1] ?? ''
const get = (k) => new RegExp(`^\\s+${k}:\\s*(.*)$`, 'm').exec(block)?.[1]?.trim() ?? ''
const provider = createProvider({
  embeddingProvider: get('embeddingProvider'),
  embeddingApiUrl: get('embeddingApiUrl'),
  embeddingApiKey: get('embeddingApiKey'),
  embeddingModelName: get('embeddingModelName'),
  embeddingDimensions: Number(get('embeddingDimensions')) || 1024,
  embeddingTimeoutMs: 15000,
})

const records = fs
  .readdirSync(MEMDIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(MEMDIR, f), 'utf8')).record ?? {})

// 正例：应该召回；负例：不应该召回
const CASES = [
  { q: '中文 Markdown 文件用什么编码', expect: 'aerok-tms-gbk-docs-utf8-scripts', pos: true },
  { q: 'PowerShell 脚本保存时编码要注意什么', expect: 'aerok-tms-gbk-docs-utf8-scripts', pos: true },
  { q: '周报统计的日期区间怎么传参数', expect: 'aerok-weekly-report-tz-boundary', pos: true },
  { q: 'git log 的 since 参数为什么漏提交', expect: 'aerok-weekly-report-tz-boundary', pos: true },
  { q: 'what encoding to use for Chinese docs', expect: 'aerok-tms-gbk-docs-utf8-scripts', pos: true },
  { q: 'git log since commit date format', expect: 'aerok-weekly-report-tz-boundary', pos: true },
  { q: '今天中午吃什么', expect: null, pos: false },
  { q: '如何配置 TypeScript 的 strict 模式', expect: null, pos: false },
]

const scored = []
for (const c of CASES) {
  const qv = await provider.embed(c.q)
  const rows = records
    .map((r) => ({ id: r.id, score: similarity(qv.vector, r.embedding, qv.model, r.embeddingModel) }))
    .filter((x) => typeof x.score === 'number')
    .sort((a, b) => b.score - a.score)
  scored.push({ ...c, top: rows[0], rows })
}

const model = 'remote-1024'
const current = floorFor(model)
const posTop = scored.filter((s) => s.pos).map((s) => s.top?.score ?? 0)
const negMax = Math.max(...scored.filter((s) => !s.pos).map((s) => s.top?.score ?? 0))

console.log(`模型 ${model}   当前阈值 ${current}`)
console.log(`正例 top 分数: min=${Math.min(...posTop).toFixed(3)}  max=${Math.max(...posTop).toFixed(3)}`)
console.log(`负例 top 分数: max=${negMax.toFixed(3)}\n`)

console.log('逐条：')
for (const s of scored) {
  const mark = s.pos ? '正例' : '负例'
  const fired = (s.top?.score ?? 0) >= current
  const want = s.pos
  const status = fired === want ? '✓' : '✗'
  console.log(
    `  ${status} ${mark} 「${s.q}」 top=${s.top?.id ?? '-'} ${(s.top?.score ?? 0).toFixed(3)}  ${fired ? '过线' : '挡掉'}`,
  )
}

console.log('\n各阈值下的表现（正例召回率 / 负例误召率）：')
for (const f of [0.40, 0.45, 0.48, 0.50, 0.52, 0.55, 0.60]) {
  let tp = 0
  let fn = 0
  let fp = 0
  for (const s of scored) {
    const fired = (s.top?.score ?? 0) >= f
    if (s.pos) fired ? tp++ : fn++
    else if (fired) fp++
  }
  const tag = f === current ? ' ← 当前' : ''
  console.log(`  floor=${f.toFixed(2)}  召回 ${tp}/${tp + fn}  误召 ${fp}${tag}`)
}