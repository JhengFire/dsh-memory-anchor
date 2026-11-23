import test from 'node:test'
import assert from 'node:assert/strict'
import {
  embed, cosine, quantize, dequantize, cosineQuantized,
  encodeForStorage, decodeFromStorage, DIM, SIMILARITY_THRESHOLD,
} from '../lib/vector.mjs'
import { detectConflict, detectSlotOverwrite, polarityOf, stripPolarity, normalize } from '../lib/polarity.mjs'

const sim = (a, b) => cosine(embed(a), embed(b))

// ---------------- vector ----------------

test('vector: 维度与归一化', () => {
  const v = embed('表面处理失败怎么办')
  assert.equal(v.length, DIM)
  let norm = 0
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5)
})

test('vector: 确定性 —— 同输入永远同输出', () => {
  assert.deepEqual(Array.from(embed('DTO 统一用 xxx 后缀')), Array.from(embed('DTO 统一用 xxx 后缀')))
})

test('vector: 空白折叠不影响结果', () => {
  assert.ok(Math.abs(cosine(embed('禁止  在事务里调用 HTTP'), embed('禁止 在事务里调用 HTTP')) - 1) < 1e-5)
})

test('vector: 空输入不崩溃', () => {
  const v = embed('')
  assert.equal(v.length, DIM)
  assert.equal(cosine(v, embed('任何文本')), 0)
})

test('vector: 量化往返误差 < 0.5%', () => {
  for (const c of ['表面处理失败后必须锁 3 个后续 lot', 'DTO 统一用 xxx 后缀', '生产环境禁止使用 SNAPSHOT 依赖']) {
    const s = cosine(embed(c), dequantize(decodeFromStorage(encodeForStorage(c))))
    assert.ok(s > 0.995, `${c} 往返相似度 ${s}`)
  }
})

test('vector: 量化后单位长度仍成立', () => {
  const back = dequantize(decodeFromStorage(encodeForStorage('任意测试文本')))
  assert.ok(Math.abs(cosine(back, back) - 1) < 1e-5, 'cos(back,back) 必须为 1')
})

test('vector: cosineQuantized 与 cosine(dequantize) 一致', () => {
  const qa = quantize(embed('分页排序必须显式指定字段'))
  const qb = quantize(embed('分页默认每页 20 条'))
  const viaBytes = cosineQuantized(qa, qb)
  const viaFloat = cosine(dequantize(qa), dequantize(qb))
  assert.ok(Math.abs(viaBytes - viaFloat) < 1e-4, `${viaBytes} vs ${viaFloat}`)
})

// ---------------- 检索质量（回归基线） ----------------

const CORPUS = [
  ['lock-lot', '表面处理失败后必须锁 3 个后续 lot，不能只重跑当前 lot'],
  ['dto-suffix', 'DTO 统一用 xxx 后缀，不允许用 Dto'],
  ['vo-suffix', 'VO 命名必须带 Vo 后缀，禁止裸名词'],
  ['timeout-15s', '接口超时统一 15 秒，不允许按接口单独设置'],
  ['no-http-tx', '禁止在事务里调用外部 HTTP 接口'],
  ['no-nplus1', '不要在循环里做数据库查询，容易 N+1'],
  ['page-order', '分页排序必须显式指定字段，不能依赖默认排序'],
  ['test-before', '提交前必须跑单测，不允许只跑 lint'],
  ['no-dist-git', '打包产物不能直接提交到 git'],
  ['log-mask', '客户要求所有日志必须脱敏手机号'],
  ['no-snapshot', '生产环境禁止使用 SNAPSHOT 依赖'],
  ['rejected-kafka', '否决用 Kafka 做内部缓存失效，运维成本过高'],
  ['gotcha-utf8', 'Windows 下重定向输出会变成 GBK，必须显式设 UTF-8'],
  ['gotcha-rebase', 'rebase 时 .lock 文件残留会导致后续操作全部失败'],
  ['surf-misc', '表面处理设备需每日点检并记录温度'],
  ['page-size', '分页默认每页 20 条，最大 200 条'],
]

function rankOf(query) {
  const qv = embed(query)
  return CORPUS
    .map(([id, c], i) => ({ id, s: cosine(qv, embed(c)) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.id)
}

test('quality: 同语言共享词面 → Top3 内命中', () => {
  const cases = [
    ['表面处理失败怎么办', 'lock-lot'],
    ['dto 命名规范', 'dto-suffix'],
    ['循环里查数据库', 'no-nplus1'],
    ['提交前要做什么', 'test-before'],
    ['日志脱敏', 'log-mask'],
    ['rebase 卡住', 'gotcha-rebase'],
    ['为什么不用 kafka', 'rejected-kafka'],
  ]
  for (const [q, want] of cases) {
    const r = rankOf(q)
    const pos = r.indexOf(want)
    assert.ok(pos >= 0 && pos < 3, `"${q}" 期望 ${want} 在 Top3，实际排名 ${pos + 1} (${r.slice(0, 3).join(',')})`)
  }
})

test('quality: 已知边界 —— 跨语言检索不保证（记录而非修复）', () => {
  // 这是哈希向量的固有边界。测试锁定「性质」而非具体位次：
  // 语料一变位次就变，断言死数字等于测试偶然性。
  // 我们只断言：它没有进入 Top1，即不保证命中。
  const r = rankOf('surface fail handling')
  assert.notEqual(r[0], 'lock-lot', '跨语言查询本就不该命中 Top1（若命中说明实现变了，需重新评估）')
})

test('quality: 已知边界 —— 完全换词的同义表达不保证', () => {
  // "编码设置" 与 "Windows 下重定向输出会变成 GBK" 无词面重合。
  // 同样只断言性质：不在 Top1，即不保证召回。
  const r = rankOf('编码设置')
  assert.notEqual(r[0], 'gotcha-utf8', '换词同义表达本就不该命中 Top1')
})

test('quality: 无关文本分数显著低于相关文本', () => {
  const irrelevant = sim('股票行情查询', '日志中禁止出现手机号')
  const relevant = sim('日志脱敏', '客户要求所有日志必须脱敏手机号')
  assert.ok(relevant > irrelevant, `相关 ${relevant.toFixed(3)} 应高于无关 ${irrelevant.toFixed(3)}`)
})

// ---------------- polarity ----------------

test('polarity: 负向识别', () => {
  assert.equal(polarityOf('生产环境禁止使用 SNAPSHOT').polarity, 'negative')
  assert.equal(polarityOf('不允许用 Dto').polarity, 'negative')
  assert.equal(polarityOf('不要用 Dto 结尾').polarity, 'negative')
  assert.equal(polarityOf('DTO 统一用 xxx 后缀').polarity, 'positive')
})

test('polarity: 长否定短语先于短前缀替换（防语义反转）', () => {
  // 「不允许」若被「不」先吃掉，会留下「允许」，把否定翻成肯定
  assert.equal(polarityOf('不允许使用').polarity, 'negative')
  assert.equal(normalize('不允许用 Dto'), normalize('不要用 Dto'))
})

test('polarity: stripPolarity 归一后骨架一致', () => {
  assert.equal(stripPolarity('不允许用 Dto'), stripPolarity('不要用 Dto'))
})

test('polarity: 极性相反 + 同主题 → 冲突', () => {
  const cases = [
    ['本环境允许使用 SNAPSHOT 依赖', '生产环境禁止使用 SNAPSHOT 依赖'],
    ['事务里可以调外部 HTTP', '禁止在事务里调用外部 HTTP 接口'],
    ['开发环境可以使用 SNAPSHOT', '生产环境禁止使用 SNAPSHOT'],
  ]
  for (const [a, b] of cases) {
    assert.equal(detectConflict(a, b, sim).conflict, true, `应冲突: ${a} ⟷ ${b}`)
  }
})

test('polarity: 极性相反但不同主题 → 不冲突（关键反例）', () => {
  const cases = [
    ['禁止在事务里调用外部 HTTP', '不要在循环里做数据库查询'],
    ['生产环境禁止使用 SNAPSHOT', '日志中禁止出现手机号'],
  ]
  for (const [a, b] of cases) {
    const r = detectConflict(a, b, sim)
    assert.equal(r.conflict, false, `不应冲突: ${a} ⟷ ${b} (contentSim=${r.contentSim.toFixed(3)})`)
  }
})

test('polarity: 同极性不判冲突', () => {
  const r = detectConflict('表面处理失败必须锁 lot', '表面处理失败必须追溯', sim)
  assert.equal(r.conflict, false)
  assert.equal(r.reason, 'same-polarity')
})

test('polarity: 冲突判定结论稳定（不依赖偶然阈值）', () => {
  // 同一对文本重复判定 100 次，结果必须完全一致
  const a = '本环境允许使用 SNAPSHOT 依赖'
  const b = '生产环境禁止使用 SNAPSHOT 依赖'
  const first = detectConflict(a, b, sim).conflict
  for (let i = 0; i < 100; i++) {
    assert.equal(detectConflict(a, b, sim).conflict, first)
  }
})

// ---------------- slot overwrite ----------------

test('slot: 时间槽覆盖可检出', () => {
  const r = detectSlotOverwrite('我昨天吃了一个苹果', '我前天吃了一个苹果')
  assert.equal(r.overlap, true)
  assert.ok(r.evidence.some((e) => e.startsWith('time:')))
})

test('slot: 版本槽覆盖可检出', () => {
  const r = detectSlotOverwrite('框架版本用 1.2.0', '框架版本用 1.3.0')
  assert.equal(r.overlap, true)
  assert.ok(r.evidence.some((e) => e.startsWith('version:')))
})

test('slot: 无关文本不误报', () => {
  assert.equal(detectSlotOverwrite('禁止在事务里调外部接口', '日志必须脱敏手机号').overlap, false)
})