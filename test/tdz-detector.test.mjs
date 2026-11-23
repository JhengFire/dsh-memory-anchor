/**
 * 验证 TDZ 检查器确实能抓到 bug。
 *
 * 不复现到真实文件（容易搞坏），而是把检查逻辑抽出来
 * 对一段人造的有 bug 代码运行，确认报出问题。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 与 client-sanity.test.mjs 中相同的检测逻辑，作用于传入源码。 */
function detectTdz(src) {
  const all = src.split(/\r?\n/)
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

    const refs = []
    body.forEach((l, i) => {
      const m = l.match(/const\s+(\w+)\s*=\s*useRef\(/)
      if (m) refs.push({ name: m[1], at: i })
    })

    body.forEach((l, i) => {
      if (!l.includes('useCallback(')) return
      let cbEnd = i
      while (cbEnd < body.length && !body[cbEnd].includes('), [')) cbEnd++
      const cbBody = body.slice(i, cbEnd + 1).join('\n')
      for (const r of refs) {
        const re = new RegExp('\\b' + r.name + '\\b')
        if (re.test(cbBody) && r.at > i) {
          problems.push(`${fn.name}: ${r.name} 声明晚于引用的 useCallback`)
        }
      }
    })
  })
  return problems
}

test('检测器能抓到 TDZ 模式', () => {
  const buggy = [
    '    function Panel(props) {',
    '      const load = useCallback(async () => {',
    '        if (!aliveRef.current) return',
    '      }, [])',
    '      const aliveRef = useRef(true)',
    '    }',
  ].join('\n')

  const found = detectTdz(buggy)
  assert.equal(found.length, 1, `应报 1 个问题，实际: ${JSON.stringify(found)}`)
  assert.match(found[0], /aliveRef/)
})

test('检测器不误报正确顺序', () => {
  const good = [
    '    function Panel(props) {',
    '      const aliveRef = useRef(true)',
    '      const load = useCallback(async () => {',
    '        if (!aliveRef.current) return',
    '      }, [])',
    '    }',
  ].join('\n')

  assert.deepEqual(detectTdz(good), [])
})

test('检测器不在不同函数间误判同名变量', () => {
  const twoFns = [
    '    function A(props) {',
    '      const aliveRef = useRef(true)',
    '      const load = useCallback(async () => { aliveRef.current = true }, [])',
    '    }',
    '    function B(props) {',
    '      const load = useCallback(async () => { aliveRef.current = true }, [])',
    '      const aliveRef = useRef(true)',
    '    }',
  ].join('\n')

  const found = detectTdz(twoFns)
  // 只有 B 是错的
  assert.equal(found.length, 1, `应只报 B，实际: ${JSON.stringify(found)}`)
  assert.match(found[0], /^B:/)
})