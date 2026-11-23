import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 在一个仿浏览器环境里执行 client.js，返回记录到的 load 调用。 */
function runInBrowserEnv() {
  const calls = []
  const errors = []
  const g = {
    window: { __ModuleLoader__: { load: (m) => calls.push(m) } },
  }

  // 用 with 注入全局，避免污染真实 globalThis
  const fn = new Function(
    'window',
    `try { ${src} } catch (e) { __err(e) }`,
  )
  void g
  void fn
  return { calls, errors }
}

test('client.js 在浏览器环境里必定调用 __ModuleLoader__.load', () => {
  const calls = []
  const loader = { load: (m) => calls.push(m) }

  // 用 vm 风格的显式全局，避免污染
  const sandbox = {
    window: { __ModuleLoader__: loader },
    document: { getElementById: () => null },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    module: undefined,
    require: undefined,
  }

  const keys = Object.keys(sandbox)
  const values = keys.map((k) => sandbox[k])
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, src)
  fn(...values)

  assert.equal(calls.length, 1, `应恰好调用一次 load，实际 ${calls.length} 次`)
  assert.equal(calls[0].id, 'dsh-memory-anchor')
  assert.equal(typeof calls[0].factory, 'function')
})

test('client.js 不得用空 catch 吞掉注册失败', () => {
  // 空 catch（catch 后紧跟注释或空块）会让「加载了但没注册」无法排查
  const emptyCatch = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}/g
  const matches = []
  let m
  while ((m = emptyCatch.exec(src)) !== null) {
    matches.push(src.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, ' ').trim())
  }
  assert.deepEqual(matches, [], `发现空 catch，会静默吞掉错误：\n${matches.join('\n')}`)
})

test('注册失败必须抛错，而不是静默返回', () => {
  // 既无 loader 也无 module 时应抛错
  assert.match(
    src,
    /no module loader available/,
    '缺少「无宿主」时的显式报错',
  )
})

test('模块 id 与 package.json 中的包名一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const m = src.match(/const ID = '([^']+)'/)
  assert.ok(m, '应定义 ID 常量')
  assert.equal(m[1], pkg.name, 'client.js 的 ID 必须等于包名，否则 load 注册的名字对不上')
})

test('factory 返回的 inject 依赖都是字符串数组', () => {
  const calls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => calls.push(m) } },
    document: { getElementById: () => null },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }
  const keys = Object.keys(sandbox)
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => sandbox[k]))

  const mod = calls[0]
  assert.ok(mod, 'load 应被调用')

  // 造一个最小 react 让 factory 能跑完
  const reactStub = {
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
    useRef: (v) => ({ current: v }),
    createElement: () => null,
  }
  const plugin = mod.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`unexpected require: ${id}`)
  })

  assert.ok(Array.isArray(plugin.inject), 'inject 应为数组')
  for (const dep of plugin.inject) {
    assert.equal(typeof dep, 'string', `inject 项应为字符串: ${JSON.stringify(dep)}`)
  }
})