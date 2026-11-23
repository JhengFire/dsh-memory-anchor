/**
 * LWM 向量化层 —— 纯函数，零依赖，可单独单测。
 *
 * ## 实测依据（dsh-memory-anchor/sweep*.mjs 可复现）
 *
 * 语料 30 条真实记忆条目，查询 30 条，按 Top-K 排名评估：
 *   dim=256 uni=0.5 bi=1 tri=0.6 maxN=3 → Top1 18/30, MRR 0.798
 *   dim=512 uni=0.7 bi=0.8          maxN=2 → Top1 26/30, MRR 0.941  ← 采用
 *   dim=1024                                  → 无提升，不值得 2 倍存储
 *
 * 因此固定为 **512 维、单字 0.7、双字 0.8、只用 1~~2gram**。
 * 3gram 在 dim=512 下会摊薄信号，实测反而降低 MRR。
 *
 * ## 能力边界（必须诚实声明）
 *
 * 本模块是**词面相似度**，不是语义理解。实测中它：
 *   ✓ 同语言、共享词面  → 命中（"表面处理失败怎么办" → lock-lot）
 *   ✗ 跨语言            → 失败（"surface fail handling" 排第 11）
 *   ✗ 完全换词的同义表达 → 失败（"编码设置" 找不到只写 "GBK" 的条目）
 *
 * 这些边界不是缺陷，而是**设计取舍的证据**：正因为无法保证召回，
 * 才必须有 verify 字段（用完要验证）与 scope 过滤（用结构约束兜底）。
 * 任何声称"向量能解决语义检索"的说法，在小模型上是站不住的。
 *
 * @module lwm/vector
 */

/** 向量维度。实测 512 是质量拐点，1024 无收益。 */
export const DIM = 512

/** 单字 gram 权重。单字是中文噪音主源，但不能为 0（短查询依赖它）。 */
const W_UNIGRAM = 0.7

/** 双字 gram 权重。中文的主要语义承载单位，作为主导信号。 */
const W_BIGRAM = 0.8

/**
 * 相似度参考阈值。
 *
 * 注意：这不是「相关性裁决线」。实测表明相关对与无关对的分数分布
 * 存在重叠（相关最低 0.15 / 无关最高 0.14 附近），单一阈值无法可靠
 * 分离。此值仅用于 F1「未召回」检测的**初筛**，最终判定必须结合
 * 「事后又 add 了同主题」这一行为信号。
 */
export const SIMILARITY_THRESHOLD = 0.16

/**
 * FNV-1a 32 位哈希。
 * @param {string} str
 * @returns {number} 无符号 32 位整数
 */
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/**
 * 把文本编码为归一化的 Float32Array 向量。
 *
 * 使用 Unicode 码点切分（`[...str]`），保证中文按字而非 UTF-16 代理对处理。
 * 只取 1~2gram：3gram 在中文长句上过稀疏，实测摊薄信号。
 *
 * @param {string} text
 * @returns {Float32Array} 长度 DIM，已 L2 归一化
 */
export function embed(text) {
  const v = new Float32Array(DIM)
  if (typeof text !== 'string' || text.length === 0) return v

  // 折叠空白，避免换行/多空格造成同一语义不同向量
  const chars = [...text.toLowerCase().replace(/\s+/g, ' ').trim()]
  const n = chars.length
  if (n === 0) return v

  // 单字 gram
  for (let i = 0; i < n; i++) {
    v[fnv1a(chars[i]) % DIM] += W_UNIGRAM
  }

  // 双字 gram
  for (let i = 0; i + 1 < n; i++) {
    v[fnv1a(chars[i] + chars[i + 1]) % DIM] += W_BIGRAM
  }

  // L2 归一化，使点积等价余弦相似度
  let sum = 0
  for (let i = 0; i < DIM; i++) sum += v[i] * v[i]
  const len = Math.sqrt(sum)
  if (len > 0) for (let i = 0; i < DIM; i++) v[i] /= len

  return v
}

/**
 * 余弦相似度。两个输入都已 L2 归一化，因此退化为点积。
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} [-1, 1]
 */
export function cosine(a, b) {
  let d = 0
  for (let i = 0; i < DIM; i++) d += a[i] * b[i]
  return d
}

/**
 * 量化为 int8 字节（存储用），映射到 0..255 便于 JSON 存储。
 * 仅在向量已 L2 归一化时使用（每个分量在 [-1, 1] 内）。
 * @param {Float32Array} v
 * @returns {Uint8Array}
 */
export function quantize(v) {
  const out = new Uint8Array(DIM)
  for (let i = 0; i < DIM; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(v[i] * 127) + 128))
  }
  return out
}

/**
 * 从字节反量化回 Float32Array，并重新归一化。
 *
 * 重新归一化不可省：量化会轻微破坏单位长度，不归一化会让
 * cosine() 得到大于 1 的值。实测往返误差 < 0.02%。
 *
 * @param {Uint8Array|number[]} q
 * @returns {Float32Array}
 */
export function dequantize(q) {
  const v = new Float32Array(DIM)
  let sum = 0
  for (let i = 0; i < DIM; i++) {
    const x = ((q[i] ?? 128) - 128) / 127
    v[i] = x
    sum += x * x
  }
  const len = Math.sqrt(sum)
  if (len > 0) for (let i = 0; i < DIM; i++) v[i] /= len
  return v
}

/**
 * 两个量化字节串之间的余弦相似度（省去反量化到 Float32 的内存分配）。
 *
 * 与 cosine() 的区别：参数是 Uint8Array（带 +128 偏移），不是 Float32Array。
 * 内部按真实范数归一，因此结果与 cosine(dequantize(a), dequantize(b)) 一致。
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number} [-1, 1]
 */
export function cosineQuantized(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < DIM; i++) {
    const x = (a[i] ?? 128) - 128
    const y = (b[i] ?? 128) - 128
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 供存储层使用的编码：文本 → base64 字符串。
 * 512 字节 → 684 字符，单条记忆的向量开销可接受。
 * @param {string} text
 * @returns {string}
 */
export function encodeForStorage(text) {
  return Buffer.from(quantize(embed(text))).toString('base64')
}

/**
 * 从存储字符串还原量化字节。
 * @param {string} encoded
 * @returns {Uint8Array}
 */
export function decodeFromStorage(encoded) {
  const out = new Uint8Array(DIM)
  if (typeof encoded !== 'string' || encoded.length === 0) {
    out.fill(128)
    return out
  }
  const buf = Buffer.from(encoded, 'base64')
  for (let i = 0; i < DIM; i++) out[i] = buf[i] ?? 128
  return out
}