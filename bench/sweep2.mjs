// 正确的方法：用 Top-K 排名指标，而非绝对阈值
// 真实场景是「在一个语料库里找 top-5」，不是二分类。
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h }

function makeEmbed({ dim = 512, uniW = 0.5, biW = 1.0, triW = 0.6, maxN = 3 }) {
  const W = [uniW, biW, triW]
  return (text) => {
    const v = new Float32Array(dim)
    const cs = [...String(text).toLowerCase().replace(/\s+/g, ' ').trim()]
    for (let n = 1; n <= maxN; n++) {
      const w = W[n - 1]
      for (let i = 0; i + n <= cs.length; i++) {
        let g = ''
        for (let k = 0; k < n; k++) g += cs[i + k]
        v[fnv(g) % dim] += w
      }
    }
    let s = 0
    for (let i = 0; i < v.length; i++) s += v[i] * v[i]
    s = Math.sqrt(s) || 1
    for (let i = 0; i < v.length; i++) v[i] /= s
    return v
  }
}
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d }

// ---- 真实语料库（30 条），查询指向其中一条 ----
const corpus = [
  ['lock-lot', '表面处理失败后必须锁 3 个后续 lot，不能只重跑当前 lot'],
  ['dto-suffix', 'DTO 统一用 xxx 后缀，不允许用 Dto'],
  ['vo-suffix', 'VO 命名必须带 Vo 后缀，禁止裸名词'],
  ['timeout-15s', '接口超时统一 15 秒，不允许按接口单独设置'],
  ['no-http-tx', '禁止在事务里调用外部 HTTP 接口'],
  ['no-nplus1', '不要在循环里做数据库查询，容易 N+1'],
  ['page-order', '分页排序必须显式指定字段，不能依赖默认排序'],
  ['test-before', '提交前必须跑单测，不允许只跑 lint'],
  ['no-dist-git', '打包产物不能直接提交到 git'],
  ['batch-review', '多晶硅批次号需要人工复核后再入库'],
  ['log-mask', '客户要求所有日志必须脱敏手机号'],
  ['no-snapshot', '生产环境禁止使用 SNAPSHOT 依赖'],
  ['starter-review', '新增 starter 需要评审互斥组配置'],
  ['rejected-kafka', '否决用 Kafka 做内部缓存失效，运维成本过高'],
  ['rejected-graphql', '放弃 GraphQL 网关方案，团队学习成本与收益不匹配'],
  ['gotcha-utf8', 'Windows 下重定向输出会变成 GBK，必须显式设 UTF-8'],
  ['gotcha-rebase', 'rebase 时 .lock 文件残留会导致后续操作全部失败'],
  ['surf-misc', '表面处理设备需每日点检并记录温度'],
  ['dto-field', 'DTO 字段不允许使用基本类型，必须用包装类'],
  ['vo-copy', 'VO 与 DO 之间禁止共享引用，必须深拷贝'],
  ['timeout-retry', '接口超时后最多重试 2 次，退避间隔 1 秒'],
  ['tx-nested', '事务嵌套深度不得超过 2 层'],
  ['nplus1-batch', '批量查询单次不超过 500 条'],
  ['page-size', '分页默认每页 20 条，最大 200 条'],
  ['test-coverage', '核心模块单测覆盖率不低于 80%'],
  ['dist-ignore', 'dist 和 build 目录必须加入 gitignore'],
  ['batch-trace', '批次号必须支持全链路追溯'],
  ['log-level', '生产环境日志级别固定为 INFO'],
  ['snapshot-dev', '开发环境可以使用 SNAPSHOT 依赖'],
  ['starter-mutex', '同一互斥组内只能启用一个 starter'],
]

// 查询 → 期望召回的正确 id（允许 1~2 个可接受答案）
const queries = [
  ['表面处理失败怎么办', ['lock-lot'], ['surf-misc']],
  ['surface fail handling', ['lock-lot'], ['surf-misc']],
  ['晶圆表面处理异常', ['lock-lot'], ['surf-misc']],
  ['dto 命名规范', ['dto-suffix'], ['dto-field']],
  ['类名后缀要求', ['dto-suffix', 'vo-suffix'], []],
  ['超时设置多少', ['timeout-15s'], ['timeout-retry']],
  ['接口等待时间', ['timeout-15s'], ['timeout-retry']],
  ['事务能调外部接口吗', ['no-http-tx'], ['tx-nested']],
  ['循环里查数据库', ['no-nplus1'], ['nplus1-batch']],
  ['N+1 问题', ['no-nplus1'], ['nplus1-batch']],
  ['分页怎么排序', ['page-order'], ['page-size']],
  ['提交前要做什么', ['test-before'], ['test-coverage']],
  ['跑单测', ['test-before'], ['test-coverage']],
  ['产物要不要进仓', ['no-dist-git'], ['dist-ignore']],
  ['批次号复核', ['batch-review'], ['batch-trace']],
  ['日志脱敏', ['log-mask'], ['log-level']],
  ['手机号打码', ['log-mask'], ['log-level']],
  ['能用 SNAPSHOT 吗', ['no-snapshot', 'snapshot-dev'], []],
  ['starter 加不加', ['starter-review'], ['starter-mutex']],
  ['为什么不用 kafka', ['rejected-kafka'], []],
  ['graphql 方案', ['rejected-graphql'], []],
  ['windows 输出乱码', ['gotcha-utf8'], []],
  ['rebase 卡住', ['gotcha-rebase'], []],
  ['VO 怎么命名', ['vo-suffix'], ['vo-copy']],
  ['排序字段', ['page-order'], ['page-size']],
  ['重试几次', ['timeout-retry'], ['timeout-15s']],
  ['互斥组', ['starter-review', 'starter-mutex'], []],
  ['放弃了哪些方案', ['rejected-kafka', 'rejected-graphql'], []],
  ['编码设置', ['gotcha-utf8'], []],
  ['范围查询', ['page-size', 'nplus1-batch'], []],
]

const configs = [
  { dim: 256, uniW: 0.5, biW: 1.0, triW: 0.6, maxN: 3 },
  { dim: 512, uniW: 0.5, biW: 1.0, triW: 0.6, maxN: 3 },
  { dim: 512, uniW: 1.0, biW: 1.0, triW: 0.6, maxN: 3 },
  { dim: 512, uniW: 0.7, biW: 0.8, triW: 0.5, maxN: 2 },
  { dim: 1024, uniW: 0.5, biW: 1.0, triW: 0.6, maxN: 3 },
  { dim: 1024, uniW: 0.1, biW: 1.0, triW: 0.6, maxN: 3 },
  { dim: 512, uniW: 0.3, biW: 1.0, triW: 1.0, maxN: 3 },
]

console.log('=== Top-K 排名指标（真实语料库 30 条，30 条查询）===\n')
console.log('配置                                    Top1   Top3   Top5   MRR')
let best = null
for (const cfg of configs) {
  const emb = makeEmbed(cfg)
  const vecs = corpus.map(([, c]) => emb(c))
  let t1 = 0, t3 = 0, t5 = 0, mrr = 0
  for (const [q, want, also] of queries) {
    const qv = emb(q)
    const ranked = corpus.map(([id], i) => ({ id, s: cos(qv, vecs[i]) })).sort((a, b) => b.s - a.s)
    const accepted = new Set([...want, ...(also || [])])
    const rank = ranked.findIndex(x => accepted.has(x.id)) + 1
    if (want.includes(ranked[0].id)) t1++
    if (rank > 0 && rank <= 3) t3++
    if (rank > 0 && rank <= 5) t5++
    if (rank > 0) mrr += 1 / rank
  }
  const n = queries.length
  const label = `dim=${cfg.dim} uni=${cfg.uniW} bi=${cfg.biW} tri=${cfg.triW} maxN=${cfg.maxN}`
  console.log(`${label.padEnd(40)} ${String(t1).padStart(2)}/${n}  ${String(t3).padStart(2)}/${n}  ${String(t5).padStart(2)}/${n}  ${(mrr / n).toFixed(3)}`)
  const score = mrr / n
  if (!best || score > best.score) best = { cfg, score, label, t1, t3, t5, n }
}
console.log(`\n最优: ${best.label}`)
console.log(`  Top1 ${best.t1}/${best.n} (${(best.t1 / best.n * 100).toFixed(0)}%)  Top5 ${best.t5}/${best.n}  MRR ${best.score.toFixed(3)}`)