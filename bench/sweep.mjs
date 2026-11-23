// 系统性扫描：单字权重 × 维度 × ngram 上限，找出真正最优配置
const DIM_CANDIDATES = [256, 512, 1024]
const UNI_W = [0.1, 0.2, 0.3, 0.5, 0.7, 1.0]
const BI_W = [1.0, 0.8, 0.6]
const MAXN = [2, 3]

function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h }

function makeEmbed(dim, uniW, biW, maxN) {
  const W = [uniW, biW, 0.5]
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
    for (let i = 0; i < dim; i++) s += v[i] * v[i]
    s = Math.sqrt(s) || 1
    for (let i = 0; i < dim; i++) v[i] /= s
    return v
  }
}
const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d }

// 扩展测试集：含语义类（字面重合少但真的相关）
const rel = [
  ['表面处理失败怎么办', '表面处理失败后必须锁 3 个后续 lot'],
  ['dto 命名', 'DTO 统一用 xxx 后缀，不允许用 Dto'],
  ['日志脱敏', '客户要求所有日志必须脱敏手机号'],
  ['超时多久', '接口超时统一 15 秒，不允许按接口单独设置'],
  ['事务 外部调用', '禁止在事务里调用外部 HTTP 接口'],
  ['N+1', '不要在循环里做数据库查询，容易 N+1'],
  ['分页排序', '分页排序必须显式指定字段，不能依赖默认排序'],
  ['提交前做什么', '提交前必须跑单测，不允许只跑 lint'],
  ['产物进仓', '打包产物不能直接提交到 git'],
  ['批次复核', '多晶硅批次号需要人工复核后再入库'],
  ['SNAPSHOT', '生产环境禁止使用 SNAPSHOT 依赖'],
  ['starter', '新增 starter 需要评审互斥组配置'],
  ['kafka', '否决用 Kafka 做内部缓存失效，运维成本过高'],
  ['windows 乱码', 'Windows 下重定向输出会变成 GBK'],
  ['rebase', 'rebase 时 .lock 文件残留会导致后续操作全部失败'],
  ['VO 后缀', 'VO 命名必须带 Vo 后缀，禁止裸名词'],
  ['超时', '接口超时统一 15 秒'],
  ['禁止外部调用', '禁止在事务里调用外部 HTTP 接口'],
  ['循环查库', '不要在循环里做数据库查询'],
  ['脱敏', '客户要求所有日志必须脱敏手机号'],
]
const irr = [
  ['股票行情查询', '日志中禁止出现手机号'],
  ['今天天气怎么样', '生产环境禁止使用 SNAPSHOT 依赖'],
  ['如何学习钢琴', 'DTO 统一用 xxx 后缀'],
  ['明天几点开会', '提交前必须跑单测'],
  ['这个颜色好看吗', '分页排序必须显式指定字段'],
  ['帮我写个排序算法', '打包产物不能直接提交到 git'],
  ['推荐个餐厅', '多晶硅批次号需要人工复核'],
  ['周末去哪玩', '新增 starter 需要评审互斥组'],
]

const results = []
for (const dim of DIM_CANDIDATES)
  for (const uniW of UNI_W)
    for (const biW of BI_W)
      for (const maxN of MAXN) {
        const emb = makeEmbed(dim, uniW, biW, maxN)
        const rs = rel.map(([a, b]) => cos(emb(a), emb(b)))
        const is = irr.map(([a, b]) => cos(emb(a), emb(b)))
        const minRel = Math.min(...rs)
        const maxIrr = Math.max(...is)
        // 用 AUC 式指标：相关对超过阈值的比例 - 无关对超过阈值的比例
        // 取最佳阈值
        let bestGap = -Infinity, bestT = 0
        for (let t = 0.05; t <= 0.8; t += 0.01) {
          const tpr = rs.filter(x => x >= t).length / rs.length
          const fpr = is.filter(x => x >= t).length / is.length
          const gap = tpr - fpr
          if (gap > bestGap) { bestGap = gap; bestT = t }
        }
        results.push({
          dim, uniW, biW, maxN,
          minRel, maxIrr,
          separable: minRel > maxIrr,
          gap: bestGap, threshold: bestT,
          tpr: rs.filter(x => x >= bestT).length / rs.length,
          fpr: is.filter(x => x >= bestT).length / is.length,
        })
      }

// 按 gap 排序
results.sort((a, b) => b.gap - a.gap)
console.log('=== 按 TPR-FPR 间隔排序 Top 12 ===\n')
console.log('dim  uniW  biW  maxN | 阈值  TPR   FPR   gap   | minRel maxIrr')
for (const r of results.slice(0, 12)) {
  console.log(
    `${String(r.dim).padStart(4)} ${String(r.uniW).padStart(5)} ${String(r.biW).padStart(4)} ${String(r.maxN).padStart(4)} | ` +
    `${r.threshold.toFixed(2)}  ${r.tpr.toFixed(2)}  ${r.fpr.toFixed(2)}  ${r.gap.toFixed(3)} | ` +
    `${r.minRel.toFixed(3)}  ${r.maxIrr.toFixed(3)}`
  )
}

// 完全可分的组合
const sep = results.filter(r => r.separable && r.fpr === 0 && r.tpr === 1)
console.log(`\n完全可分(全中且零误报)的组合: ${sep.length} 个`)
if (sep.length) {
  console.log('最优(取最小 dim):')
  sep.sort((a, b) => a.dim - b.dim || b.gap - a.gap)
  const b = sep[0]
  console.log(`  dim=${b.dim} uniW=${b.uniW} biW=${b.biW} maxN=${b.maxN} 阈值=${b.threshold.toFixed(2)}`)
  console.log(`  相关最低=${b.minRel.toFixed(3)} 无关最高=${b.maxIrr.toFixed(3)} 间隔=${(b.minRel - b.maxIrr).toFixed(3)}`)
}

// 当前配置表现
const cur = results.find(r => r.dim === 256 && r.uniW === 0.15 || (r.dim === 256 && r.uniW === 0.2 && r.biW === 1.0 && r.maxN === 3))
console.log('\n当前实现(uniW=0.15,biW=1.0,maxN=3,dim=256)对应:')
const c2 = results.find(r => r.dim === 256 && r.uniW === 0.2 && r.biW === 1.0 && r.maxN === 3)
if (c2) console.log(`  gap=${c2.gap.toFixed(3)} TPR=${c2.tpr.toFixed(2)} FPR=${c2.fpr.toFixed(2)} minRel=${c2.minRel.toFixed(3)} maxIrr=${c2.maxIrr.toFixed(3)}`)