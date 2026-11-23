/**
 * 火山引擎方舟（Volcengine Ark）embedding 预设。
 *
 * ## 接口形态（以用户实际验证的 curl 为准）
 *
 *   POST https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal
 *   Content-Type: application/json
 *   Authorization: Bearer $ARK_API_KEY
 *
 *   {
 *     "model": "doubao-embedding-vision-251215",
 *     "input": [
 *       { "type": "text", "text": "..." },
 *       { "type": "image_url", "image_url": { "url": "..." } }
 *     ]
 *   }
 *
 * 注意与 OpenAI 的差异：`input` 不是字符串/字符串数组，而是**带 type 的对象数组**。
 * 这是多模态端点，文本只是其中一种输入类型。
 *
 * ## 为什么单独成模块
 *
 * 「默认接火山，后续还能对接别家」要求两件事同时成立：
 *   1. 不把任何一家写死到无法替换；
 *   2. 火山的默认值开箱即用，用户不必查文档。
 *
 * 所以这里只放**协议适配**与预设值，通用逻辑留在 embedding.mjs。
 * 换一家 = 加一个同形状的模块，不动别处。
 *
 * @module memory-anchor/providers/volcengine
 */

/** 火山方舟默认服务地址（baseUrl）。 */
export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** 多模态向量化端点。 */
export const MULTIMODAL_PATH = '/embeddings/multimodal'

/** 标准纯文本向量化端点（若用户用文本模型）。 */
export const TEXT_PATH = '/embeddings'

/** 默认模型：视觉多模态，也能处理纯文本。 */
export const DEFAULT_MODEL = 'doubao-embedding-vision-251215'

/** 默认维度。 */
export const DEFAULT_DIMENSIONS = 1024

/**
 * 火山的预设值。
 * @returns {{baseUrl: string, url: string, model: string, dimensions: number, multimodal: boolean}}
 */
export function preset() {
  return {
    baseUrl: DEFAULT_BASE_URL,
    url: `${DEFAULT_BASE_URL}${MULTIMODAL_PATH}`,
    model: DEFAULT_MODEL,
    dimensions: DEFAULT_DIMENSIONS,
    multimodal: true,
  }
}

/**
 * 把用户填的地址归一成完整端点。
 *
 * 用户可能填四种东西，都要能work：
 *   https://ark.cn-beijing.volces.com/api/v3                      （baseUrl）
 *   https://ark.cn-beijing.volces.com/api/v3/                     （带尾斜杠）
 *   https://ark.cn-beijing.volces.com/api/v3/embeddings           （文本端点）
 *   https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal（多模态端点）
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim().replace(/\/+$/, '')
  if (raw === '') return ''
  if (/\/embeddings(\/multimodal)?$/i.test(raw)) return raw
  if (/^https?:\/\/[^/]+$/i.test(raw)) return `${raw}/api/v3${MULTIMODAL_PATH}`
  return `${raw}${MULTIMODAL_PATH}`
}

/**
 * 判断某个 URL 走的是多模态端点。
 * @param {string} url
 * @returns {boolean}
 */
export function isMultimodalUrl(url) {
  return /\/embeddings\/multimodal\/?$/i.test(String(url ?? ''))
}

/**
 * 把若干段文本组装成火山要求的 input 数组。
 *
 * 多模态端点要 `[{type:'text', text}]`；纯文本端点要 `string[]`。
 * 两种都要支持，因为用户可能填任一端点。
 *
 * @param {string[]} texts
 * @param {string} url
 * @returns {Array<object>|string[]|string}
 */
export function buildInput(texts, url) {
  if (isMultimodalUrl(url)) {
    return texts.map((t) => ({ type: 'text', text: String(t) }))
  }
  return texts.length === 1 ? texts[0] : texts
}

/**
 * 从响应中取出向量数组。
 *
 * 火山的响应形状与 OpenAI 一致：{ data: [{ embedding: [...] }] }，
 * 但不同版本/模型偶有差异，这里做宽松解析。
 *
 * @param {any} payload
 * @returns {number[][]|null}
 */
export function extractVectors(payload) {
  if (!payload || typeof payload !== 'object') return null

  // 火山多模态端点：data 是**对象**，不是数组。
  //
  //   实测：{ data: { embedding: [...], object: "embedding" } }
  //
  // 而 OpenAI 形状是 { data: [{ embedding }] }。两种都要认，
  // 否则会出现「200 OK 但取不到向量」这种最难查的失败。
  if (payload.data && !Array.isArray(payload.data) && typeof payload.data === 'object') {
    const e = payload.data.embedding ?? payload.data.embeddings
    if (Array.isArray(e) && e.length > 0 && typeof e[0] === 'number') return [e]
  }

  // OpenAI 形状：data 是数组
  if (Array.isArray(payload.data)) {
    const rows = payload.data.map((d) => d?.embedding ?? d?.embeddings)
    if (rows.length > 0 && rows.every((r) => Array.isArray(r))) return rows
  }

  // 少数实现把 embeddings 放在顶层
  if (Array.isArray(payload.embeddings)) {
    if (payload.embeddings.every((r) => Array.isArray(r))) return payload.embeddings
    if (payload.embeddings.every((x) => typeof x === 'number')) return [payload.embeddings]
  }

  // 顶层单个 embedding
  if (Array.isArray(payload.embedding) && typeof payload.embedding[0] === 'number') {
    return [payload.embedding]
  }

  return null
}
