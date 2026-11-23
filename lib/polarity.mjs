/**
 * LWM 极性判定 —— 纯规则，零依赖。
 *
 * 关键设计（来自实测）：
 *   向量给的是「相关」，不是「矛盾」。
 *   "允许使用 SNAPSHOT" vs "禁止使用 SNAPSHOT" 余弦高达 0.842，
 *   是所有测试用例里最高的 —— 向量越准，越会把冲突判成高度相关。
 *
 * 因此两个问题必须分开问：
 *   Q1 这两条在讲同一件事吗？  → 向量回答（召回）
 *   Q2 它们矛盾吗？            → 本模块回答（规则）
 *
 * @module lwm/polarity
 */

/**
 * 正负极性词对。左列为肯定、右列为否定。
 * 匹配前先做归一化（见 normalize），因此只需覆盖归一后的形态。
 */
const POLARITY_PAIRS = [
  ['允许', '禁止'],
  ['可以', '不允许'],
  ['必须', '禁止'],
  ['统一', '单独'],
  ['统一', '按'],
  ['使用', '别用'],
  ['支持', '不支持'],
  ['要求', '不建议'],
  ['固定', '随'],
]

/** 常见的否定前缀 / 否定词，命中即视为否定极性。 */
const NEGATION_MARKERS = ['不', '禁', '别', '勿', '无', '非', '没']

/**
 * 归一化文本：去空白、统一标点、把常见同义表述折叠。
 * 目的是让 "不允许用 Dto 结尾" 与 "不要用 Dto 结尾" 落到同一形态。
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  let t = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、！？,.!:;"']/g, '')

  // 顺序至关重要：长短语必须先于其前缀替换，否则「不允许」会被
  // 「不」先吃掉，留下孤立的「允许」，把否定语义反转成肯定。
  // 统一把所有否定表述折叠成一个记号 '¬'，便于后续剥离。
  const NEG = '¬'
  const folds = [
    ['不允许', NEG],
    ['不可以', NEG],
    ['不应该', NEG],
    ['不建议', NEG],
    ['不支持', NEG],
    ['不需要', NEG],
    ['不能', NEG],
    ['不可', NEG],
    ['不要', NEG],
    ['不得', NEG],
    ['不用', NEG],
    ['别用', NEG],
    ['禁止', NEG],
  ]
  for (const [phrase, to] of folds) t = t.split(phrase).join(to)

  // 残留的单字否定（如「不删日志」「勿动」）
  t = t.replace(/[不非没无勿别禁]/g, NEG)

  // 同义肯定表述折叠
  t = t.replace(/一律/g, '统一')
  return t
}

/**
 * 判定文本的极性。
 * @param {string} text
 * @returns {{polarity: 'positive'|'negative'|'neutral', marker: string|null}}
 */
export function polarityOf(text) {
  const t = normalize(text)
  return t.includes('¬')
    ? { polarity: 'negative', marker: '¬' }
    : { polarity: 'positive', marker: null }
}

/**
 * 判断两条陈述是否构成极性冲突。
 *
 * 判定分两步，缺一不可：
 *   1. 极性相反（一个肯定一个否定）
 *   2. 去掉极性词后，两条的「内容骨架」高度重合
 *
 * 第 2 步是必须的：仅凭「一个有一个没有否定词」会把
 * "必须锁 lot" 和 "不要删日志" 误判为冲突。
 *
 * @param {string} a
 * @param {string} b
 * @param {(s1: string, s2: string) => number} similarity 相似度函数（由调用方注入）
 * @param {number} [contentThreshold=0.55] 内容骨架相似度门槛
 * @returns {{conflict: boolean, reason: string, polarityA: string, polarityB: string, contentSim: number}}
 */
export function detectConflict(a, b, similarity, contentThreshold = 0.55) {
  const pa = polarityOf(a)
  const pb = polarityOf(b)

  if (pa.polarity === pb.polarity) {
    return {
      conflict: false,
      reason: 'same-polarity',
      polarityA: pa.polarity,
      polarityB: pb.polarity,
      contentSim: similarity(a, b),
    }
  }

  // 去掉极性词，比较剩余内容是否在说同一件事
  const stripA = stripPolarity(a)
  const stripB = stripPolarity(b)
  const contentSim = similarity(stripA, stripB)

  if (contentSim < contentThreshold) {
    return {
      conflict: false,
      reason: 'different-subject',
      polarityA: pa.polarity,
      polarityB: pb.polarity,
      contentSim,
    }
  }

  return {
    conflict: true,
    reason: 'opposite-polarity-same-subject',
    polarityA: pa.polarity,
    polarityB: pb.polarity,
    contentSim,
  }
}

/**
 * 去掉极性词后的内容骨架。
 * @param {string} text
 * @returns {string}
 */
export function stripPolarity(text) {
  // normalize 已把所有否定折叠成 ¬，这里只需剥掉它与少量语气词，
  // 保留真正的内容骨架用于相似度比较。
  return normalize(text)
    .replace(/¬/g, '')
    .replace(/应该|需要|可以/g, '')
}

/**
 * 判断两条是否可能「同槽覆盖」（同一属性的不同取值）。
 * 这处理 "昨天/前天"、"v1/v2"、"8080/9090" 这类更正，
 * 与极性冲突不同：可以自动取代，但必须留 correction 事件。
 * @param {string} a
 * @param {string} b
 * @returns {{overlap: boolean, evidence: string[]}}
 */
export function detectSlotOverwrite(a, b) {
  const evidence = []

  // 时间词
  const timeWords = ['昨天', '前天', '今天', '明天', '上周', '本周', '下周', '上月', '本月']
  const ta = timeWords.filter((w) => a.includes(w))
  const tb = timeWords.filter((w) => b.includes(w))
  if (ta.length && tb.length && ta.some((w) => !tb.includes(w))) {
    evidence.push(`time:${ta.join('/')}→${tb.join('/')}`)
  }

  // 版本号
  const va = new Set((a.match(/v?\d+(?:\.\d+)+/g) || []))
  const vb = new Set((b.match(/v?\d+(?:\.\d+)+/g) || []))
  if (va.size && vb.size && [...va].some((x) => !vb.has(x))) {
    evidence.push(`version:${[...va].join(',')}→${[...vb].join(',')}`)
  }

  // 端口/数值槽位（只认 ≥1000 的数字，避免误伤普通数量词）
  const na = new Set((a.match(/\b\d{4,}\b/g) || []))
  const nb = new Set((b.match(/\b\d{4,}\b/g) || []))
  if (na.size && nb.size && [...na].some((x) => !nb.has(x))) {
    evidence.push(`number:${[...na].join(',')}→${[...nb].join(',')}`)
  }

  return { overlap: evidence.length > 0, evidence }
}

/**
 * 可配置的极性词表加载。默认走内置，允许用户覆盖。
 * @param {string} [raw] 词表文本，每行 `肯定词=否定词`
 * @returns {Array<[string,string]>}
 */
export function loadPolarityPairs(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return POLARITY_PAIRS
  const pairs = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const [pos, neg] = s.split('=')
    if (pos && neg) pairs.push([pos.trim(), neg.trim()])
  }
  return pairs.length ? pairs : POLARITY_PAIRS
}

export { POLARITY_PAIRS }