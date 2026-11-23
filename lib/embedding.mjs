/**
 * 嵌入向量提供者（embedding provider）。
 *
 * ## 为什么要有这一层
 *
 * 向量来源有两种，质量差一个数量级：
 *
 *   hash   —— 本地的字符 n-gram 哈希向量。零依赖、永远可用，
 *             但只认字面：同义改写识别率约 20%，跨语言为 0。
 *   remote —— 第三方 REST API。语义能力强，但要联网、要配置、可能失败。
 *
 * 二者必须能互相替代，且**同一时刻只用一个**。所以这里定义统一接口，
 * 上层（store）不需要知道向量从哪来。
 *
 * ## 分桶：跨模型比较是无声的错误
 *
 * 不同模型的向量空间不兼容。把 hash 向量和 remote 向量放在一起算余弦
 * 相似度，得到的是一个**看起来正常、实际毫无意义**的数字，而且不会报错。
 *
 * 因此每条向量都带 `model` 标签，检索时只与同标签的向量比较。
 * 这是本模块最重要的约束，比向量质量本身更重要。
 *
 * @module memory-anchor/embedding
 */

import {
  embed,
  encodeForStorage,
  decodeFromStorage,
  cosineQuantizedAny,
  quantizeAny,
} from './vector.mjs'
import { getProvider } from './providers/registry.mjs'

export const HASH_MODEL = 'hash-512'

/**
 * 生成 remote 模型的标识。
 *
 * 维度必须写进标识里：同一个 API 传不同 dimensions 得到的是
 * 不同维度的向量，同样不可互相比较。
 *
 * @param {number} dimensions
 * @returns {string}
 */
export function remoteModelId(dimensions) {
  return `remote-${dimensions}`
}

/**
 * 本地哈希提供者：零依赖兜底，永远成功。
 */
export const hashProvider = {
  id: HASH_MODEL,
  /**
   * @param {string} text
   * @returns {Promise<{vector: string, model: string}>}
   */
  async embed(text) {
    return { vector: encodeForStorage(text), model: HASH_MODEL }
  },
  async ready() {
    return true
  },
}

/**
 * 把浮点向量压成可存的字符串。
 *
 * 复用 vector.mjs 的 int8 量化：2048 维 float32 是 8 KB，
 * 量化后 2 KB，base64 后约 2.7 KB。检索精度损失很小。
 *
 * @param {number[]} floats
 * @returns {string}
 */
function packFloats(floats) {
  const q = quantizeAny(Float32Array.from(floats))
  let s = ''
  // 逐字节转 base64，避免依赖 Buffer（浏览器侧也可能调用）
  const CHUNK = 0x8000
  for (let i = 0; i < q.length; i += CHUNK) {
    s += btoa(String.fromCharCode.apply(null, q.subarray(i, i + CHUNK)))
  }
  return `i8:${s}`
}

/**
 * 从存储字符串还原成可比较的用量化向量。
 *
 * 兼容两种前缀：
 *   `i8:`  —— remote 向量（本模块写入）
 *   其它   —— 旧版哈希向量（vector.mjs 的编码）
 *
 * @param {string} stored
 * @returns {Uint8Array|null}
 */
export function unpackStored(stored) {
  if (typeof stored !== 'string' || stored.length === 0) return null
  if (stored.startsWith('i8:')) {
    const bin = atob(stored.slice(3))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return decodeFromStorage(stored)
}

/**
 * 远程 REST 提供者。
 *
 * 约定 OpenAI 风格的 `POST {url}` 请求体：
 *   { input: string | string[], model?: string, dimensions?: number }
 * 响应兼容两种常见形状：
 *   { data: [{ embedding: number[] }] }
 *   { embeddings: number[][] }
 *
 * 之所以做成宽松解析：第三方服务众多，紧贴一家会让换服务变成重写。
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.apiKey]
 * @param {number} [options.dimensions]
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {object}
 */
export function createRemoteProvider(options) {
  // 供应商定义决定协议细节：请求体形状、响应解析、地址归一。
  // 传 null 时回落到默认供应商，保证老配置仍能用。
  const def = options.provider ?? getProvider(options.providerId)

  const url = def.normalizeUrl(options.url)
  const apiKey = String(options.apiKey ?? '').trim()
  const dimensions = Number(options.dimensions) || 1024
  const modelName = String(options.model ?? '').trim()
  const timeoutMs = Number(options.timeoutMs) || 8000
  const id = remoteModelId(dimensions)

  return {
    id,

    async ready() {
      return url.length > 0
    },

    /**
     * 单条嵌入。
     * @param {string} text
     * @returns {Promise<{vector: string, model: string}>}
     */
    async embed(text) {
      const { vectors } = await this.embedBatch([text])
      if (!vectors[0]) throw new Error('embedding API returned no vector')
      return { vector: vectors[0], model: id }
    },

    /**
     * 批量嵌入。重嵌历史数据时用它，显著减少往返次数。
     *
     * @param {string[]} texts
     * @returns {Promise<{vectors: string[]}>}
     */
    async embedBatch(texts) {
      if (texts.length === 0) return { vectors: [] }
      if (url.length === 0) throw new Error('embedding API url is not configured')

      // 输入形状随端点而变：多模态要有 type 包裹，纯文本直接给字符串。
      const body = { input: def.buildInput(texts, url) }
      if (modelName) body.model = modelName
      // dimensions 只在显式配置时发送：部分模型不接受该参数，
      // 传了反而报错，且维度由模型自身决定。
      if (options.dimensions) body.dimensions = dimensions

      // 超时用 AbortSignal：没有它，断网时 fetch 可能挂很久，
      // 而写入路径不该被第三方服务拖住。
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let payload
      try {
        const headers = { 'content-type': 'application/json' }
        if (apiKey) headers.authorization = `Bearer ${apiKey}`
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          throw new Error(`embedding API ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
        }
        payload = await res.json()
      } finally {
        clearTimeout(timer)
      }

      const rows = def.extractVectors(payload)
      if (!rows) throw new Error('embedding API response has no data/embeddings array')
      if (rows.length !== texts.length) {
        throw new Error(`embedding API returned ${rows.length} vectors for ${texts.length} inputs`)
      }

      return {
        vectors: rows.map((row) => {
          if (!Array.isArray(row) || row.length === 0) {
            throw new Error('embedding API returned an empty or non-array vector')
          }
          return packFloats(row)
        }),
      }
    },
  }
}

/**
 * 构造当前生效的提供者。
 *
 * 未配置 API 时返回 hash 提供者——默认就是零配置可用，
 * 这符合“装了就有用”的原则，而不是装了还得先去申请一个 key。
 *
 * @param {object} config
 * @returns {object}
 */
export function createProvider(config = {}) {
  const url = String(config.embeddingApiUrl ?? '').trim()
  if (url.length === 0) return hashProvider
  return createRemoteProvider({
    providerId: config.embeddingProvider,
    url,
    apiKey: config.embeddingApiKey,
    dimensions: config.embeddingDimensions ?? 1024,
    model: config.embeddingModelName,
    timeoutMs: config.embeddingTimeoutMs,
  })
}

/**
 * 写入路径的统一入口：先试远程，失败降级本地。
 *
 * 为什么失败也要写入：记忆的价值高于向量质量。
 * 一条“暂时用低质量向量存着”的决策记录，远好过因为它而丢失。
 * 降级写入的条目带 needsEmbedding 标记，恢复后由 reindex 补上。
 *
 * @param {object} provider
 * @param {string} text
 * @returns {Promise<{vector: string, model: string, degraded: boolean, error?: string}>}
 */
export async function embedWithFallback(provider, text) {
  const fallback = async (err) => {
    const v = await hashProvider.embed(text)
    return { ...v, degraded: true, error: err instanceof Error ? err.message : String(err) }
  }

  if (!provider || provider.id === HASH_MODEL) {
    const v = await hashProvider.embed(text)
    return { ...v, degraded: false }
  }

  try {
    const v = await provider.embed(text)
    return { ...v, degraded: false }
  } catch (err) {
    return fallback(err)
  }
}

/**
 * 两条存储向量是否可比——只有同模型才能算相似度。
 *
 * @param {string} aModel
 * @param {string} bModel
 * @returns {boolean}
 */
export function comparable(aModel, bModel) {
  return String(aModel || HASH_MODEL) === String(bModel || HASH_MODEL)
}

/**
 * 计算两条存储向量之间的相似度；不可比时返回 null。
 *
 * 返回 null 而不是 0：0 表示“算过，不相关”，
 * null 表示“不该比”——把二者混同会污染排序。
 *
 * @param {string} aVec
 * @param {string} bVec
 * @param {string} aModel
 * @param {string} bModel
 * @returns {number|null}
 */
export function similarity(aVec, bVec, aModel, bModel) {
  if (!comparable(aModel, bModel)) return null
  const a = unpackStored(aVec)
  const b = unpackStored(bVec)
  if (!a || !b) return null
  if (a.length !== b.length) return null
  return cosineQuantizedAny(a, b)
}

export { embed }