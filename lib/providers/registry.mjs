/**
 * 模型供应商注册表。
 *
 * ## 为什么做成注册表而不是 if/else
 *
 * 需求是「供应商下拉框，目前只有火山，后续还能对接其他」。
 * 如果写成 `if (provider === 'volcengine')`，每加一家都要改
 * 配置解析、设置页、文档三处，很容易漏。
 *
 * 注册表把每家的差异收敛到一个对象里：
 *   - 显示名（下拉框文案）
 *   - 默认地址、默认模型、默认维度
 *   - 请求组装与响应解析
 *
 * 加一家新的 = 新增一个 provider 模块 + 在这里注册一行。
 *
 * @module memory-anchor/providers/registry
 */

import * as volcengine from './volcengine.mjs'

/**
 * 供应商定义。
 *
 * @typedef {object} ProviderDef
 * @property {string} id            内部标识，存进配置
 * @property {string} label         下拉框显示名
 * @property {string} baseUrl       默认服务地址
 * @property {string} model         默认模型
 * @property {number} dimensions    默认维度
 * @property {string} docsUrl       帮助链接
 * @property {string} apiKeyHint    如何获取 key 的说明
 * @property {(texts: string[], url: string) => any} buildInput   请求体 input
 * @property {(payload: any) => number[][]|null} extractVectors  响应解析
 * @property {(input: string) => string} normalizeUrl            地址归一
 */

/** @type {Record<string, ProviderDef>} */
export const PROVIDERS = {
  volcengine: {
    id: 'volcengine',
    label: '火山方舟',
    baseUrl: volcengine.DEFAULT_BASE_URL,
    model: volcengine.DEFAULT_MODEL,
    dimensions: volcengine.DEFAULT_DIMENSIONS,
    docsUrl: 'https://console.volcengine.com/ark',
    apiKeyHint: '火山控制台 → API Key 管理',
    buildInput: volcengine.buildInput,
    extractVectors: volcengine.extractVectors,
    normalizeUrl: volcengine.normalizeUrl,
  },
}

/** 默认供应商。 */
export const DEFAULT_PROVIDER = 'volcengine'

/** 下拉框用的选项列表。 */
export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    model: p.model,
    dimensions: p.dimensions,
    docsUrl: p.docsUrl,
    apiKeyHint: p.apiKeyHint,
  }))
}

/**
 * 取供应商定义，未知的 id 回落到默认。
 *
 * 回落而不是抛错：配置可能来自旧版本或手工编辑，
 * 让插件直接不可用比用默认值更糟。
 *
 * @param {string} id
 * @returns {ProviderDef}
 */
export function getProvider(id) {
  const key = String(id ?? '').trim()
  return PROVIDERS[key] ?? PROVIDERS[DEFAULT_PROVIDER]
}