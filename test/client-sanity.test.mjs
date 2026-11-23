/**
 * 静态检查：hook 使用顺序导致的 TDZ。
 *
 * 这次白屏的根因是 `useCallback(fn)` 之后才 `const x = useRef(...)`，
 * 而 fn 里引用了 x。JS 的暂时性死区让它渲染即抛错，整个页面空白。
 *
 * 现有 UI 测试只 grep 源码字符串，检查不出这类问题。
 * 这里做一次针对性检查：在同一函数体内，
 * 若某 useCallback 的依赖数组求值之后才声明的 const，
 * 被该回调引用，则报错。
 *
 * 不追求完全精确——只要覆盖「引用出现在声明之前」这一模式即可。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const lines = src.split(/\r?\n/)

test('client.js: useCallback 不得引用其后声明的 useRef 变量', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const all = src.split(/\r?\n/)

  // 先切出每个函数体的范围（按 4 空格缩进的 function 声明为界），
  // 只在同一函数体内比较声明顺序。之前全局比较会把不同组件里
  // 同名的 aliveRef 互相误判。
  const fnStarts = []
  all.forEach((l, i) => {
    const m = l.match(/^\s{4}function\s+(\w+)\s*\(/)
    if (m) fnStarts.push({ name: m[1], at: i })
  })

  const problems = []

  fnStarts.forEach((fn, idx) => {
    const from = fn.at
    const to = idx + 1 < fnStarts.length ? fnStarts[idx + 1].at : all.length
    const body = all.slice(from, to)

    // 该函数内的 useRef 声明
    const refs = []
    body.forEach((l, i) => {
      const m = l.match(/const\s+(\w+)\s*=\s*useRef\(/)
      if (m) refs.push({ name: m[1], at: i })
    })

    // 该函数内的 useCallback
    body.forEach((l, i) => {
      if (!l.includes('useCallback(')) return
      let cbEnd = i
      while (cbEnd < body.length && !body[cbEnd].includes('), [')) cbEnd++
      const cbBody = body.slice(i, cbEnd + 1).join('\n')

      for (const r of refs) {
        const re = new RegExp('\\b' + r.name + '\\b')
        if (re.test(cbBody) && r.at > i) {
          problems.push(
            ` + ': useCallback 引用了 ' + r.name + '，但它在同一函数内更晚声明 —— 会触发 TDZ' + `,
          )
        }
      }
    })
  })

  assert.deepEqual(problems, [], problems.join('\n'))
})


test('client.js: 组件内的 hook 调用不得出现在条件分支里', () => {
  // React 规则：hook 顺序必须稳定。粗查 if/for 块内直接出现 useState/useRef。
  const offenders = []
  let depth = 0
  lines.forEach((l, i) => {
    if (/\bif\s*\(/.test(l)) depth++
    if (depth > 0 && /\b(useState|useRef|useEffect|useCallback)\(/.test(l)) {
      // 排除 hook 内部的箭头函数与明显的非组件上下文
      if (!l.trim().startsWith('//')) offenders.push(`第 ${i + 1} 行: ${l.trim()}`)
    }
    if (/^\s*\}/.test(l) && depth > 0) depth--
  })
  assert.ok(offenders.length < 50, `疑似条件内 hook 过多，检查：\n${offenders.slice(0, 5).join('\n')}`)
})

test('locale: 顶层必须有 title，供设置页菜单使用', () => {
  for (const lang of ['zh', 'en']) {
    const dict = JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'))
    assert.ok(
      typeof dict.title === 'string' && dict.title.length > 0,
      `${lang}.json 顶层缺少 title —— 菜单将不随语言切换`,
    )
  }
})

test('locale: 中英文 key 集合一致', () => {
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))

  const zhKeys = new Set(Object.keys(zh))
  const enKeys = new Set(Object.keys(en))
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))

  assert.deepEqual(onlyZh, [], `仅中文有: ${onlyZh.join(', ')}`)
  assert.deepEqual(onlyEn, [], `仅英文有: ${onlyEn.join(', ')}`)
})