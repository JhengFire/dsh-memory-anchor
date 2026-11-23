import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const localeJson = {
  zh: JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8')),
  en: JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8')),
}

/**
 * 提取 client.js 里 zh / en 内联字典中出现的所有 t('key') 用法。
 */
function usedKeys(src) {
  const keys = new Set()
  for (const m of src.matchAll(/\bt\('([\w.]+)'\)/g)) keys.add(m[1])
  return keys
}

test('client.js 中用到的每个 t(key) 都在内联字典里有定义', () => {
  // 内联字典的 key 集合：抓 zh 字典块的缩进 key: 形式
  const zhStart = clientSrc.indexOf('const zh = {')
  const zhEnd = clientSrc.indexOf('const en = {')
  assert.ok(zhStart > 0 && zhEnd > zhStart, '应能定位 zh 与 en 字典')

  const zhBlock = clientSrc.slice(zhStart, zhEnd)
  const enBlock = clientSrc.slice(zhEnd, clientSrc.indexOf('\n    }', zhEnd))

  const definedIn = (block) => {
    const out = new Set()
    for (const m of block.matchAll(/^\s{4}(\w+):/gm)) out.add(m[1])
    // badges 这类嵌套对象单独处理
    return out
  }

  const zhKeys = definedIn(zhBlock)
  const enKeys = definedIn(enBlock)

  const missingZh = []
  const missingEn = []
  for (const k of usedKeys(clientSrc)) {
    // badges 走的是 t('badges') 再取子键，或 kindXxx 直接调用，跳过嵌套
    if (!zhKeys.has(k)) missingZh.push(k)
    if (!enKeys.has(k)) missingEn.push(k)
  }

  assert.deepEqual(missingZh, [], `中文内联字典缺少: ${missingZh.join(', ')}`)
  assert.deepEqual(enKeys.size > 0, true)
  assert.deepEqual(missingEn, [], `英文内联字典缺少: ${missingEn.join(', ')}`)
})

test('中英文内联字典的 key 集合一致', () => {
  const zhStart = clientSrc.indexOf('const zh = {')
  const zhEnd = clientSrc.indexOf('const en = {')
  const enEnd = clientSrc.indexOf('\n    }', zhEnd)

  const keysOf = (block) => {
    const out = new Set()
    for (const m of block.matchAll(/^\s{4}(\w+):/gm)) out.add(m[1])
    return out
  }
  const zhK = keysOf(clientSrc.slice(zhStart, zhEnd))
  const enK = keysOf(clientSrc.slice(zhEnd, enEnd))

  const onlyZh = [...zhK].filter((k) => !enK.has(k))
  const onlyEn = [...enK].filter((k) => !zhK.has(k))
  assert.deepEqual(onlyZh, [], `仅中文: ${onlyZh.join(', ')}`)
  assert.deepEqual(onlyEn, [], `仅英文: ${onlyEn.join(', ')}`)
})

test('函数型文案不得从 JSON 取值（JSON 存不了函数）', () => {
  // 这些键必须定义在 client.js 内联字典中（那里支持函数）
  const FUNCTIONAL = ['embeddingKeySet', 'embeddingTestOk', 'embeddingTestFail']
  for (const k of FUNCTIONAL) {
    // 若代码里以 t(k)(...) 的形式调用，则该键必须是函数型定义
    const usedAsFn = new RegExp(`t\\('${k}'\\)\\(`).test(clientSrc)
    if (!usedAsFn) continue

    const isFnInInline = new RegExp(`^\\s{4}${k}:\\s*\\(`, 'm').test(clientSrc)
    assert.ok(isFnInInline, `${k} 被当函数调用，但内联字典里不是函数定义`)

    for (const lang of ['zh', 'en']) {
      assert.equal(
        k in localeJson[lang],
        false,
        `${k} 不应出现在 locale/${lang}.json —— JSON 无法保存函数，取值后调用会抛错`,
      )
    }
  }
})

test('locale JSON 每个值都是字符串或对象（不含函数）', () => {
  for (const lang of ['zh', 'en']) {
    const walk = (obj, path) => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'function') {
          assert.fail(`locale/${lang}.json 的 ${path}${k} 是函数 —— JSON 不支持`)
        }
        if (v && typeof v === 'object') walk(v, `${path}${k}.`)
      }
    }
    walk(localeJson[lang], '')
  }
})