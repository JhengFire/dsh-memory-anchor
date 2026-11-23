/**
 * 面向模型的输出渲染。
 *
 * 从 index.mjs 抽出来单独成模块，原因有二：
 *   1. 它是纯函数，不依赖 DSH 运行时，应该能被单独测试；
 *   2. index.mjs 依赖 @deepseek-ai/schemastery 等包，
 *      普通 node 无法加载，导致渲染逻辑无法单测。
 *
 * @module memory-anchor/render
 */

/**
 * 把 scope 数组渲染成一行可读文本。
 *
 * `workspace` 与 `global` 的区别必须显式呈现：使用者要能判断
 * 这条约束是"只在本工作区适用"还是"到处都适用"，
 * 否则换项目后就不知道该不该继续遵守。
 *
 * @param {string[]|undefined} scope
 * @returns {string}
 */
export function renderScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return 'global'
  return scope.join(', ')
}

/**
 * 渲染检索结果。
 *
 * 输出契约（面向模型，力求省 token）：
 *   [n] id (kind, verified 日期, 标记…)
 *       claim
 *       why: …
 *       verify: …
 *       scope: …
 *   结尾一行：结果数 · 过期数 · 使用提示
 *
 * @param {Array<object>} hits
 * @returns {string}
 */
export function renderHits(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return 'no matching memories'

  const lines = []
  hits.forEach((h, i) => {
    const flags = []
    if (h.status === 'stale') flags.push('⚠stale')
    if (h.status === 'superseded') flags.push('⚠superseded')
    if (h.stability === 'provisional') flags.push('⚠provisional')
    if (!h.verify) flags.push('⚠unverifiable')
    // 跨模型的条目没有可比的分数，只能确定「它不是按当前模型算的」，
    // 标出来并指路 reindex，否则用户会以为这是相关性不足的旧记忆。
    if (h.unsureAt) flags.push(`⚠unsure(reindex needed: ${h.unsureAt})`)
    const verified = h.lastVerified ? String(h.lastVerified).slice(0, 10) : 'never'
    const flagText = flags.length > 0 ? `, ${flags.join(' ')}` : ''

    lines.push(`[${i + 1}] ${h.id} (${h.kind}, verified ${verified}${flagText})`)
    lines.push(`    ${h.claim}`)
    if (h.why) lines.push(`    why: ${h.why}`)
    if (h.verify) lines.push(`    verify: ${h.verify}`)
    lines.push(`    scope: ${renderScope(h.scope)}`)
  })

  const stale = hits.filter((h) => h.status === 'stale').length
  lines.push(
    `${hits.length} results · ${stale} stale · run 'memory verify' before acting · feedback: memory use/miss`,
  )
  return lines.join('\n')
}