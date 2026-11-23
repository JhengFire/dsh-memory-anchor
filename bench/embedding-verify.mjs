/**
 * 端到端验证向量检索「真的有用」，而不只是「连得上」。
 *
 * 「测试连接」只能证明 HTTP 200；它证明不了两件事：
 *   1. 向量语义好不好（同义改写能不能召回，无关内容会不会误召回）；
 *   2. 远程向量和本地哈希向量的分桶没有互相污染。
 *
 * 用法（真实调用 API，会花钱，但每条记忆只花一次）：
 *   node bench/embedding-verify.mjs
 *
 * 配置从 DSH profile 的 patch 里读，避免在命令行暴露 key。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProvider, embedWithFallback, hashProvider, similarity } from '../lib/embedding.mjs'

function loadConfig() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  const text = fs.readFileSync(file, 'utf8')
  const block = text.split(/- id: memory-anchor/)[1] ?? ''
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

/** 一组记忆，每条带「该被谁召回」的期望。 */
const MEMORIES = [
  { id: 'a', text: '表面处理失败必须锁批次，不允许重跑' },
  { id: 'b', text: '日志里禁止出现手机号等隐私信息' },
  { id: 'c', text: '分页排序统一按创建时间倒序，不按 id' },
  { id: 'd', text: '线上事故复盘必须写明确认步骤，不能只写结论' },
]

/** 查询：改写表达，看能不能召回对应的那条。 */
const QUERIES = [
  { q: '镀层出问题了要不要停线重新处理', expect: 'a', why: '同义改写：表面处理→镀层，锁批次→停线' },
  { q: '用户手机号能不能打进日志里', expect: 'b', why: '同义改写：禁止→能不能，接近原句' },
  { q: '列表怎么排序比较合适', expect: 'c', why: '间接表达：分页排序→列表排序' },
  { q: 'postmortem 应该记录哪些内容', expect: 'd', why: '跨语言：事故复盘→postmortem' },
  { q: '今天中午吃什么比较好', expect: null, why: '无关查询：不应该召回任何记忆' },
]

const cfg = loadConfig()
if (!cfg.embeddingApiUrl) {
  console.log('未配置 embeddingApiUrl，退出')
  process.exit(1)
}

const remote = createProvider(cfg)
console.log(`provider=${remote.id}  model=${cfg.embeddingModelName || '(默认)'}  url=${cfg.embeddingApiUrl}\n`)

// 1) 逐条嵌入，记录耗时与降级情况
const t0 = Date.now()
const stored = []
for (const m of MEMORIES) {
  const t = Date.now()
  const r = await embedWithFallback(remote, m.text)
  stored.push({ ...m, vector: r.vector, model: r.model, degraded: r.degraded })
  console.log(
    `embed ${m.id}: ${Date.now() - t}ms  model=${r.model}  degraded=${r.degraded}${r.error ? `  err=${r.error}` : ''}`,
  )
}
console.log(`\n总嵌入耗时 ${Date.now() - t0}ms，${MEMORIES.length} 条\n`)

const bad = stored.filter((s) => s.degraded)
if (bad.length > 0) {
  console.log(`⚠ 有 ${bad.length} 条降级为本地向量：${bad.map((b) => b.id).join(',')}`)
  console.log('  下面的检索精度会明显变差，先修连通性。\n')
}

// 2) 每条查询，按同一模型向量算相似度排序
let hit = 0
let miss = 0
let falsePositive = 0
console.log('查询 → 排序（相似度）')
console.log('-'.repeat(72))
for (const item of QUERIES) {
  const qv = await embedWithFallback(remote, item.q)
  const scored = stored
    .map((s) => ({ id: s.id, score: similarity(qv.vector, s.vector, qv.model, s.model) }))
    .filter((s) => s.score !== null)
    .sort((x, y) => y.score - x.score)

  const top = scored[0]
  const ok = item.expect === null ? top === undefined || top.score < 0.35 : top?.id === item.expect
  if (item.expect === null) {
    if (ok) hit++
    else {
      falsePositive++
      miss++
    }
  } else if (ok) hit++
  else miss++

  console.log(`${ok ? '✓' : '✗'} 「${item.q}」`)
  console.log(`    期望=${item.expect ?? '无'}  实得 top=${top?.id ?? '无'} (${top ? top.score.toFixed(3) : '-'})`)
  console.log(`    排名: ${scored.map((s) => `${s.id}=${s.score.toFixed(3)}`).join('  ')}`)
  console.log(`    ${item.why}`)
}
console.log('-'.repeat(72))
console.log(`命中 ${hit}/${QUERIES.length}  未命中 ${miss}  误召回 ${falsePositive}`)

// 3) 跨模型不可比：hash 向量与 remote 向量之间必须返回 null
const half = await hashProvider.embed(MEMORIES[0].text)
const cross = similarity(half.vector, stored[0].vector, half.model, stored[0].model)
console.log(`\n分桶检查：hash↔remote 相似度 = ${cross === null ? 'null（正确）' : `${cross}（错误！会污染排序）`}`)

// 4) 同一模型内自比必须接近 1
const self = similarity(stored[0].vector, stored[0].vector, stored[0].model, stored[0].model)
console.log(`自比检查：remote↔自己 = ${self?.toFixed(4)}`)

process.exitCode = miss === 0 && cross === null ? 0 : 1