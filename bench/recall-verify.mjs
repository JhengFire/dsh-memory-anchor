/**
 * 用真实存储里的记忆 + 真实远程 API 验证检索质量。
 *
 * 与 embedding-verify.mjs 的区别：那边用构造的样本，这边读磁盘上
 * 你实际存过的记忆，并用记忆工具自身的 find 路径算分，
 * 所以测的是「这套配置在你的真实数据上好不好用」。
 *
 * 用法：node bench/recall-verify.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProvider, unpackStored, similarity } from '../lib/embedding.mjs'
import { floorFor } from '../lib/thresholds.mjs'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PATCH = path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')
const MEMDIR = path.join(HOME, 'storages', 'memory_anchor', 'memories')

function cfgFromPatch() {
  const block = fs.readFileSync(PATCH, 'utf8').split(/- id: memory-anchor/)[1] ?? ''
  const get = (k) => new RegExp(`^\\s+${k}:\\s*(.*)$`, 'm').exec(block)?.[1]?.trim() ?? ''
  return {
    embeddingProvider: get('embeddingProvider'),
    embeddingApiUrl: get('embeddingApiUrl'),
    embeddingApiKey: get('embeddingApiKey'),
    embeddingModelName: get('embeddingModelName'),
    embeddingDimensions: Number(get('embeddingDimensions')) || 1024,
    embeddingTimeoutMs: 15000,
  }
}

function loadRecords() {
  return fs
    .readdirSync(MEMDIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const j = JSON.parse(fs.readFileSync(path.join(MEMDIR, f), 'utf8'))
      return j.record ?? j
    })
}

const cfg = cfgFromPatch()
const provider = createProvider(cfg)
const records = loadRecords()

console.log(`配置：provider=${cfg.embeddingProvider} model=${cfg.embeddingModelName}`)
console.log(`存储：${records.length} 条记忆\n`)

console.log('存储向量状态：')
for (const r of records) {
  const dim = unpackStored(r.embedding)?.length ?? 0
  console.log(
    `  ${r.id}\n    模型=${r.embeddingModel}  维度=${dim}  待补嵌=${r.needsEmbedding}  阈值=${floorFor(r.embeddingModel)}`,
  )
}

/** 针对真实记忆提出的查询，覆盖跨语言与同义改写。 */
const QUERIES = [
  { q: '中文 Markdown 文件用什么编码', expect: 'aerok-tms-gbk-docs-utf8-scripts', why: '同义改写：GBK→编码' },
  { q: 'PowerShell 脚本保存时编码要注意什么', expect: 'aerok-tms-gbk-docs-utf8-scripts', why: '细节改写：.ps1→PowerShell' },
  { q: '周报统计的日期区间怎么传参数', expect: 'aerok-weekly-report-tz-boundary', why: '同义改写：git 区间参数→日期区间' },
  { q: 'what encoding to use for Chinese docs', expect: 'aerok-tms-gbk-docs-utf8-scripts', why: '跨语言：英文查询中文记忆' },
  { q: 'git log since commit date format', expect: 'aerok-weekly-report-tz-boundary', why: '跨语言 + 细节：since 参数' },
  { q: '今天中午吃什么', expect: null, why: '无关查询：应全部低于阈值' },
]

let pass = 0
console.log('\n检索结果：')
console.log('-'.repeat(76))
for (const item of QUERIES) {
  const qv = await provider.embed(item.q)
  const m = qv.model
  const floor = floorFor(m)
  const scored = records
    .map((r) => ({ id: r.id, score: similarity(qv.vector, r.embedding, m, r.embeddingModel) }))
    .filter((s) => typeof s.score === 'number')
    .sort((a, b) => b.score - a.score)

  const above = scored.filter((s) => s.score >= floor)
  const ok =
    item.expect === null ? above.length === 0 : above.length > 0 && above[0].id === item.expect
  if (ok) pass++

  console.log(`${ok ? '✓' : '✗'} 「${item.q}」  (${item.why})`)
  console.log(`    阈值 ${floor}  过线 ${above.length} 条`)
  for (const s of scored) {
    console.log(`    ${s.score >= floor ? '●' : '○'} ${s.id}  ${s.score.toFixed(3)}`)
  }
}
console.log('-'.repeat(76))
console.log(`通过 ${pass}/${QUERIES.length}`)
process.exitCode = pass === QUERIES.length ? 0 : 1