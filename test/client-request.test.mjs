/**
 * 前端请求构造的验证。
 *
 * 这个文件存在的理由：之前只测了后端路由（curl），没测前端实际发出的请求，
 * 结果 body 未序列化导致 400/405，而测试全绿。
 * 这里直接执行 client.js 里的 api()，断言它交给 fetch 的东西是合法的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 从源码中按括号配对抽出 api() 的源码文本。 */
function extractApi() {
  const startIdx = src.indexOf('async function api(path, init) {')
  assert.ok(startIdx >= 0, '应能在源码中定位 api()')

  const braceStart = src.indexOf('{', startIdx)
  let depth = 0
  let endIdx = -1
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        endIdx = i + 1
        break
      }
    }
  }
  assert.ok(endIdx > 0, '应能配对 api() 的大括号')
  return src.slice(startIdx, endIdx)
}

/** 装上假 fetch，返回捕获到的请求。 */
function harness() {
  const requests = []
  const state = { response: { ok: true, status: 200, body: {} } }

  const fetchStub = async (url, init) => {
    requests.push({ url, init })
    const r = state.response
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText ?? (r.ok ? 'OK' : 'Error'),
      json: async () => {
        if (r.jsonThrows) throw new Error('not json')
        return r.body
      },
    }
  }

  const apiSource = extractApi()
  // eslint-disable-next-line no-new-func
  const api = new Function('fetch', `${apiSource}\nreturn api`)(fetchStub)

  return {
    api,
    requests,
    setResponse: (r) => {
      state.response = r
    },
  }
}

test('api: body 是对象时序列化为 JSON 字符串', async () => {
  const h = harness()
  await h.api('/lwm/embedding/test', {
    method: 'POST',
    body: { provider: 'volcengine', dimensions: 1024 },
  })

  const req = h.requests[0]
  assert.equal(typeof req.init.body, 'string', 'body 必须是字符串，否则 fetch 会转成 [object Object]')
  assert.deepEqual(JSON.parse(req.init.body), { provider: 'volcengine', dimensions: 1024 })
})

test('api: 字符串 body 原样传递', async () => {
  const h = harness()
  await h.api('/x', { method: 'POST', body: '{"a":1}' })
  assert.equal(h.requests[0].init.body, '{"a":1}')
})

test('api: 无 body 时保持 undefined', async () => {
  const h = harness()
  await h.api('/lwm/state')
  assert.equal(h.requests[0].init.body, undefined)
})

test('api: 非 2xx 时抛错并带上服务端错误信息', async () => {
  const h = harness()
  h.setResponse({ ok: false, status: 405, body: { error: 'method not allowed' } })
  await assert.rejects(() => h.api('/x', { method: 'POST' }), /405.*method not allowed/)
})

test('api: 响应非 JSON 时不崩', async () => {
  const h = harness()
  h.setResponse({ ok: false, status: 500, jsonThrows: true })
  await assert.rejects(() => h.api('/x'), /500/)
})

test('api: 成功但响应非 JSON 时返回空对象', async () => {
  const h = harness()
  h.setResponse({ ok: true, status: 200, jsonThrows: true })
  const out = await h.api('/x')
  assert.deepEqual(out, {})
})

test('embedding 测试连接使用 POST', () => {
  assert.match(src, /api\('\/lwm\/embedding\/test',\s*\{\s*method:\s*'POST'/, '测试连接应为 POST')
})

test('embedding 保存使用 POST', () => {
  assert.match(src, /api\('\/lwm\/embedding',\s*\{\s*method:\s*'POST'/, '保存应为 POST')
})

test('读取配置使用 GET（不带 method）', () => {
  assert.match(src, /api\('\/lwm\/embedding'\)/, '读取配置应为 GET')
})