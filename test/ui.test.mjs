import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'

/**
 * 精确长度读取。
 *
 * 本机 Electron 运行时对 >4 KB 的文件会返回虚高的 stat 大小，
 * readFileSync 因此读到尾部垃圾字节。这里先按真实长度读取：
 * 用二分法找出"再多一个字节就报错"的长度，即为真实长度。
 *
 * 已验证 readSync 指定正确长度时返回正确数据。
 */
function safeRead(file) {
  const fd = fs.openSync(file, 'r')
  try {
    // 直接尝试从一个足够大的缓冲区读取，看实际返回多少字节
    const probe = Buffer.alloc(8 * 1024 * 1024)
    const n = fs.readSync(fd, probe, 0, probe.length, 0)
    return probe.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}


/**
 * 设置页路由的集成测试。
 *
 * 用 mock 的 ctx 跑通 /lwm/state、/lwm/list、/lwm/toggle，
 * 验证分页边界、开关联动、以及关闭后工具被拒绝的行为。
 */

const here = new URL('.', import.meta.url)

function pathToFileUrl(p) {
  let s = p.replace(/\\/g, '/')
  if (!s.startsWith('/')) s = '/' + s
  return 'file://' + encodeURI(s)
}

/** 进程内唯一的临时文件后缀（同毫秒内多次调用也不能撞车）。 */
let __tmpSeq = 0
function tmpSuffix() {
  __tmpSeq += 1
  return `${process.pid}-${__tmpSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/** 可写的临时目录：检出可能只读，系统临时目录通常可写。 */
function tempDir() {
  const dir = os.tmpdir() + '/dsh-memory-anchor-test'
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 探针实测可写性——Windows 上 ACL 与 mode 位不对应。 */
function canWrite(dir) {
  const probe = `${dir}/.probe-${tmpSuffix()}`
  try {
    fs.writeFileSync(probe, 'x')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 把 `from './x.mjs'` 改写成真实 lib/ 的绝对 file:// URL。 */
function rewriteRelativeImports(src, libDir) {
  return src.replace(/(from\s+)(['"])(\.\/[^'"]+)\2/g, (_m, pre, q, rel) => {
    const target = libDir.replace(/\\/g, '/') + '/' + rel.slice(2)
    return `${pre}${q}${pathToFileUrl(target)}${q}`
  })
}

async function resolveZodUrl() {
  const fs = await import('node:fs')
  const dir =
    'C:/Users/AK-FMSB-0186/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/zod'
  const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'))
  const dot = pkg.exports?.['.']
  const rel = typeof dot === 'string' ? dot : (dot?.import ?? dot?.default ?? 'index.js')
  return pathToFileUrl(`${dir}/${String(rel).replace(/^\.\//, '')}`)
}

async function loadPlugin() {
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const libDir = path.join(dir, '..', 'lib')

  let src = safeRead(path.join(dir, '..', 'lib', 'index.mjs'))
  src = src.replace(
    "import z from '@deepseek-ai/schemastery'",
    `const mkField = (type, def) => { const node = { type, default: def }; node.default = (v) => { node.default = v; return node }; return node }
     const z = { object: (s) => ({ __schema: s }), number: () => mkField('number'), string: () => mkField('string'), boolean: () => mkField('boolean'), array: (i) => { const n = mkField('array'); n.inner = i; return n } }`,
  )
  src = src.replace(
    "import { defineTool } from '@deepseek-ai/dsh-tools'",
    `const defineTool = (o) => ({ ...o, async run(a, e) { return o.execute(a, e) } })`,
  )

  const zodUrl = await resolveZodUrl()
  let schemaSrc = safeRead(path.join(dir, '..', 'lib', 'schema.mjs'))
  schemaSrc = schemaSrc.replace("import { z } from 'zod'", `import { z } from ${JSON.stringify(zodUrl)}`)
  const schemaTmp = path.join(tempDir(), `.tmp-schema-ui-${tmpSuffix()}.mjs`)
  fs.writeFileSync(schemaTmp, schemaSrc)
  src = src.replace("from './schema.mjs'", `from ${JSON.stringify(pathToFileUrl(schemaTmp))}`)
  // 临时副本若已把相对导入改写成绝对 URL，上面的精确匹配就不生效；
  // 兜底把任何指向真实 schema.mjs 的 URL 换掉。
  const schemaUrl = pathToFileUrl(libDir.replace(/\\/g, '/') + '/schema.mjs')
  if (!src.includes(JSON.stringify(pathToFileUrl(schemaTmp)))) {
    src = src.split(schemaUrl).join(pathToFileUrl(schemaTmp))
  }

  // 临时模块优先就地放在 lib/：这样 './store.mjs'、'./eval.mjs' 这些
  // 相对导入天然解析到真实文件。lib/ 不可写（只读检出、沙箱）时退到
  // 系统临时目录，并把相对导入改写成真实 lib/ 的绝对 URL —— 仍然测同一份源码。
  const suffix = tmpSuffix()
  const writable = canWrite(libDir)
  const tmp = writable ? path.join(libDir, `.tmp-ui-${suffix}.mjs`) : path.join(tempDir(), `.tmp-ui-${suffix}.mjs`)
  if (!writable) src = rewriteRelativeImports(src, libDir.replace(/\\/g, '/'))
  fs.writeFileSync(tmp, src)
  const mod = await import(pathToFileUrl(tmp))
  fs.unlinkSync(tmp)
  fs.unlinkSync(schemaTmp)
  return mod
}

function mockDomain() {
  const tables = new Map()
  const tableHandle = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    const recs = tables.get(name)
    return {
      get: (k) => recs.get(k),
      put: async (k, v) => {
        recs.set(k, structuredClone(v))
      },
      delete: async (k) => {
        recs.delete(k)
        return true
      },
      entries: () => [...recs.entries()][Symbol.iterator](),
      keys: () => [...recs.keys()][Symbol.iterator](),
      get size() {
        return recs.size
      },
    }
  }
  return {
    table: tableHandle,
    global: { get: () => undefined, set: async () => {} },
    close: () => {},
    _tables: tables,
  }
}

/** 假的 HTTP 请求/响应，够 handler 用即可。 */
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = JSON.parse(text)
    },
  }
}

const baseCfg = {
  limit: 5,
  staleDays: 180,
  retireMisses: 3,
  conflictWindowSec: 1800,
  evalEnabled: true,
  enabled: true,
  polarityPairs: [],
  promptSection: true,
}

async function boot(config = baseCfg) {
  const plugin = await loadPlugin()
  const domain = mockDomain()
  const routes = new Map()
  const tool = { current: null }
  const sections = []

  const ctx = {
    tools: { register: (t) => { tool.current = t } },
    systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 100 },
    storageDomain: { open: async () => domain },
    effect: (fn) => { fn() },
    inject: (deps, fn) => {
      // 模拟依赖可用
      fn({
        webServer: {
          register: (r) => {
            routes.set(r.path, r.handler)
            return () => {}
          },
        },
        logger: { warn: () => {}, error: () => {} },
        get: () => undefined,
      })
    },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }

  // 模拟 ctx.inject 是方法而非属性
  ctx.inject = (deps, fn) => {
    fn({
      webServer: {
        register: (r) => {
          routes.set(r.path, r.handler)
          return () => {}
        },
      },
      logger: ctx.logger,
      get: () => undefined,
      effect: (f) => f(),
    })
  }

  await plugin.apply(ctx, config)
  return { plugin, domain, routes, tool, exec: { agent: { id: 's1', workspaceDirectory: '/repo' } } }
}

async function call(routes, path, req) {
  const res = fakeRes()
  await routes.get(path)(req, res)
  return res
}

// ---------------- 路由存在性 ----------------

test('ui: 设置页路由齐全（含向量配置的读写两条）', async () => {
  const { routes } = await boot()
  // 只看 GET 路由不够：保存按钮走的是 POST /lwm/embedding，
  // 这条曾经没注册上，而测试只覆盖了 GET，于是全绿、保存必挂。
  for (const p of ['/lwm/state', '/lwm/list', '/lwm/toggle', '/lwm/embedding', '/lwm/embedding/test', '/lwm/delete', '/lwm/clear']) {
    assert.ok(routes.has(p), `缺少 ${p}`)
  }
})

test('ui: 无 webServer 时不报错（纯工具形态仍可用）', async () => {
  const plugin = await loadPlugin()
  const domain = mockDomain()
  const registered = []
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    systemPrompt: { section: () => {}, getSectionOrder: () => 100 },
    storageDomain: { open: async () => domain },
    effect: (fn) => fn(),
    // 依赖不可用 → 回调不执行
    inject: () => {},
    logger: { warn: () => {} },
  }
  await plugin.apply(ctx, baseCfg)
  assert.equal(registered.length, 1, '工具仍应注册')
})

// ---------------- /lwm/state ----------------

test('ui/state: 返回开关与总数', async () => {
  const { routes, tool, exec } = await boot()
  await tool.current.run({ action: 'add', id: 'a', kind: 'gotcha', claim: '表面处理失败必须锁批次' }, exec)
  const res = await call(routes, '/lwm/state', fakeReq('GET', '/lwm/state'))
  assert.equal(res.status, 200)
  assert.equal(res.body.enabled, true)
  assert.equal(res.body.total, 1)
  assert.equal(res.body.active, 1)
})

test('ui/state: 非 GET 返回 405', async () => {
  const { routes } = await boot()
  const res = await call(routes, '/lwm/state', fakeReq('POST', '/lwm/state'))
  assert.equal(res.status, 405)
})

// ---------------- /lwm/list 分页 ----------------

async function seed(n) {
  const env = await boot()
  for (let i = 0; i < n; i++) {
    await env.tool.current.run(
      {
        action: 'add',
        id: `m${String(i).padStart(2, '0')}`,
        kind: 'gotcha',
        claim: `第 ${i} 条不同的记忆内容测试分页`,
      },
      env.exec,
    )
  }
  return env
}

test('ui/list: 默认每页 10 条', async () => {
  const { routes } = await seed(25)
  const res = await call(routes, '/lwm/list', fakeReq('GET', '/lwm/list?page=1'))
  assert.equal(res.status, 200)
  assert.equal(res.body.items.length, 10)
  assert.equal(res.body.total, 25)
  assert.equal(res.body.pageCount, 3)
})

test('ui/list: 末页只有剩余条数', async () => {
  const { routes } = await seed(25)
  const res = await call(routes, '/lwm/list', fakeReq('GET', '/lwm/list?page=3'))
  assert.equal(res.body.items.length, 5)
})

test('ui/list: 页码越界返回空但结构完整', async () => {
  const { routes } = await seed(5)
  const res = await call(routes, '/lwm/list', fakeReq('GET', '/lwm/list?page=99'))
  assert.equal(res.body.items.length, 0)
  assert.equal(res.body.total, 5)
  assert.equal(res.body.pageCount, 1)
})

test('ui/list: 非法参数被钳制而非崩溃', async () => {
  const { routes } = await seed(12)
  for (const q of ['?page=0', '?page=-3', '?page=abc', '?pageSize=0', '?pageSize=9999', '']) {
    const res = await call(routes, '/lwm/list', fakeReq('GET', `/lwm/list${q}`))
    assert.equal(res.status, 200, `${q} 应正常返回`)
    assert.ok(res.body.items.length <= 100, `${q} 结果不应超过 100 条`)
    assert.ok(res.body.page >= 1, `${q} 页码应 >= 1`)
  }
})

test('ui/list: 分页不重叠且覆盖全部', async () => {
  const { routes } = await seed(25)
  const ids = new Set()
  for (let p = 1; p <= 3; p++) {
    const res = await call(routes, '/lwm/list', fakeReq('GET', `/lwm/list?page=${p}`))
    for (const it of res.body.items) {
      assert.ok(!ids.has(it.id), `重复返回了 ${it.id}`)
      ids.add(it.id)
    }
  }
  assert.equal(ids.size, 25)
})

test('ui/list: 每条包含页面需要的字段', async () => {
  const { routes } = await seed(1)
  const res = await call(routes, '/lwm/list', fakeReq('GET', '/lwm/list?page=1'))
  const item = res.body.items[0]
  for (const key of ['id', 'kind', 'claim', 'status', 'stability', 'scope', 'verify', 'createdAt']) {
    assert.ok(key in item, `缺少字段 ${key}`)
  }
})

// ---------------- /lwm/toggle ----------------

test('ui/toggle: 关闭后 list 仍可读、写入被拒绝', async () => {
  const { routes, tool, exec } = await boot()
  await tool.current.run({ action: 'add', id: 'a', kind: 'gotcha', claim: '关闭前的记忆' }, exec)

  const off = await call(routes, '/lwm/toggle', fakeReq('POST', '/lwm/toggle', { enabled: false }))
  assert.equal(off.status, 200)
  assert.equal(off.body.enabled, false)

  // 列表仍可读——否则用户无法查看"到底记了什么"
  const list = await call(routes, '/lwm/list', fakeReq('GET', '/lwm/list?page=1'))
  assert.equal(list.body.total, 1)

  // 写入被拒绝
  const out = await tool.current.run({ action: 'add', id: 'b', kind: 'gotcha', claim: '关闭后不该写入' }, exec)
  assert.match(out.text, /已停用/)
})

test('ui/toggle: 关闭后 find 被拒绝，stats 仍可用', async () => {
  const { routes, tool, exec } = await boot()
  await tool.current.run({ action: 'add', id: 'a', kind: 'gotcha', claim: '某条记忆' }, exec)
  await call(routes, '/lwm/toggle', fakeReq('POST', '/lwm/toggle', { enabled: false }))

  const findOut = await tool.current.run({ action: 'find', query: '某条记忆' }, exec)
  assert.match(findOut.text, /已停用/)

  const statsOut = await tool.current.run({ action: 'stats' }, exec)
  assert.match(statsOut.text, /memories:/, 'stats 应仍可用')
})

test('ui/toggle: 重新开启后恢复写入', async () => {
  const { routes, tool, exec } = await boot()
  await call(routes, '/lwm/toggle', fakeReq('POST', '/lwm/toggle', { enabled: false }))
  await call(routes, '/lwm/toggle', fakeReq('POST', '/lwm/toggle', { enabled: true }))
  const out = await tool.current.run({ action: 'add', id: 'c', kind: 'gotcha', claim: '重新开启后写入' }, exec)
  assert.match(out.text, /✓/)
})

test('ui/toggle: 非 boolean 参数被拒绝', async () => {
  const { routes } = await boot()
  for (const body of [{ enabled: 'yes' }, {}, { enabled: 1 }]) {
    const res = await call(routes, '/lwm/toggle', fakeReq('POST', '/lwm/toggle', body))
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应被拒绝`)
  }
})

test('ui/toggle: 非 POST 返回 405', async () => {
  const { routes } = await boot()
  const res = await call(routes, '/lwm/toggle', fakeReq('GET', '/lwm/toggle'))
  assert.equal(res.status, 405)
})

test('ui: config.enabled=false 时初始即为关闭', async () => {
  const { routes } = await boot({ ...baseCfg, enabled: false })
  const res = await call(routes, '/lwm/state', fakeReq('GET', '/lwm/state'))
  assert.equal(res.body.enabled, false)
})
// ---------------- 删除与清空 ----------------
//
// 必须通过 domain 句柄删除，而不是删磁盘文件：
// storageDomain 在 open() 时把全量记录载入内存作为权威状态，
// 直接删文件不会反映到已打开的实例，接口会继续返回已删除的记录。

test('ui/delete: 删除单条后 stats 实时减少', async () => {
  const { routes, tool, exec } = await boot()
  await tool.current.run({ action: 'add', id: 'x1', kind: 'gotcha', claim: '表面处理失败必须锁批次' }, exec)
  await tool.current.run({ action: 'add', id: 'x2', kind: 'constraint', claim: '日志中禁止出现手机号等 PII' }, exec)

  let st = await call(routes, '/lwm/state', fakeReq('GET', '/lwm/state'))
  assert.equal(st.body.total, 2)

  const del = await call(routes, '/lwm/delete', fakeReq('POST', '/lwm/delete', { id: 'x1' }))
  assert.equal(del.status, 200)
  assert.equal(del.body.deleted, 'x1')

  st = await call(routes, '/lwm/state', fakeReq('GET', '/lwm/state'))
  assert.equal(st.body.total, 1, '删除后应立即反映')

  const list = await call(routes, '/lwm/list', fakeReq('GET', '/lwm/list?page=1'))
  assert.ok(!list.body.items.some((m) => m.id === 'x1'), '已删除的条目不应再出现')
})

test('ui/delete: 不存在的 id 返回 404', async () => {
  const { routes } = await boot()
  const res = await call(routes, '/lwm/delete', fakeReq('POST', '/lwm/delete', { id: 'nope' }))
  assert.equal(res.status, 404)
})

test('ui/delete: 缺少 id 返回 400', async () => {
  const { routes } = await boot()
  for (const body of [{}, { id: '' }, { id: 123 }]) {
    const res = await call(routes, '/lwm/delete', fakeReq('POST', '/lwm/delete', body))
    assert.equal(res.status, 400, `${JSON.stringify(body)} 应被拒绝`)
  }
})

test('ui/delete: 非 POST 返回 405', async () => {
  const { routes } = await boot()
  const res = await call(routes, '/lwm/delete', fakeReq('GET', '/lwm/delete'))
  assert.equal(res.status, 405)
})

test('ui/clear: 清空全部并实时反映', async () => {
  const { routes, tool, exec } = await boot()
  for (let i = 0; i < 5; i++) {
    await tool.current.run(
      { action: 'add', id: `c${i}`, kind: 'gotcha', claim: `第 ${i} 条用于清空测试的记忆内容` },
      exec,
    )
  }
  let st = await call(routes, '/lwm/state', fakeReq('GET', '/lwm/state'))
  assert.equal(st.body.total, 5)

  const cleared = await call(routes, '/lwm/clear', fakeReq('POST', '/lwm/clear', {}))
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.deleted, 5)

  st = await call(routes, '/lwm/state', fakeReq('GET', '/lwm/state'))
  assert.equal(st.body.total, 0, '清空后应立即为 0')

  const list = await call(routes, '/lwm/list', fakeReq('GET', '/lwm/list?page=1'))
  assert.equal(list.body.items.length, 0)
})

test('ui/clear: 空库调用安全', async () => {
  const { routes } = await boot()
  const res = await call(routes, '/lwm/clear', fakeReq('POST', '/lwm/clear', {}))
  assert.equal(res.status, 200)
  assert.equal(res.body.deleted, 0)
})

// ---------------- 向量配置 ----------------
//
// 页面「保存」走的 POST /lwm/embedding 曾长期返回 405：前端 bundle 修好了，
// 但 host 侧这条路由没注册上，而测试只覆盖了 GET，于是测试全绿、保存必挂。
// 这里补齐 POST 一侧的覆盖，缺的正是当时漏掉的那一半。

test('ui/embedding: GET 回显配置且不泄露完整 key', async () => {
  const { routes } = await boot({ ...baseCfg, embeddingApiKey: 'sk-abcdefg1234' })
  const res = await call(routes, '/lwm/embedding', fakeReq('GET', '/lwm/embedding'))
  assert.equal(res.status, 200)
  assert.equal(res.body.hasApiKey, true)
  assert.equal(res.body.apiKeyTail, '1234')
  assert.ok(!JSON.stringify(res.body).includes('sk-abcdefg'), '响应里不应出现完整 key')
  assert.ok(Array.isArray(res.body.providers), '应带回服务商列表供下拉框使用')
})

test('ui/embedding: POST 保存配置返回 ok 而不是 405', async () => {
  const { routes } = await boot()
  const body = {
    provider: 'volcengine',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/embeddings',
    modelName: 'doubao-embedding-vision-251215',
    dimensions: 1024,
    apiKey: 'sk-test-0001',
  }
  const res = await call(routes, '/lwm/embedding', fakeReq('POST', '/lwm/embedding', body))
  assert.notEqual(res.status, 405, '保存接口不能以 405 回应 POST')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  // mock ctx 没有 configEditor，只能改内存：这种情况必须如实告知，不能谎报已落盘
  assert.equal(res.body.persisted, false)

  const echo = await call(routes, '/lwm/embedding', fakeReq('GET', '/lwm/embedding'))
  assert.equal(echo.body.provider, 'volcengine')
  assert.equal(echo.body.apiUrl, body.apiUrl)
  assert.equal(echo.body.modelName, body.modelName)
  assert.equal(echo.body.apiKeyTail, '0001')
})

test('ui/embedding: POST 空 apiKey 不覆盖已存的 key', async () => {
  const { routes } = await boot({ ...baseCfg, embeddingApiKey: 'sk-abcdefg1234' })
  const res = await call(
    routes,
    '/lwm/embedding',
    fakeReq('POST', '/lwm/embedding', { provider: '', apiUrl: '', modelName: '', dimensions: 1024, apiKey: '' }),
  )
  assert.equal(res.status, 200)
  const echo = await call(routes, '/lwm/embedding', fakeReq('GET', '/lwm/embedding'))
  assert.equal(echo.body.hasApiKey, true, '留空表示不修改，不应清空已保存的 key')
  assert.equal(echo.body.apiKeyTail, '1234')
})

test('ui/embedding: 同路径只接受 GET/HEAD 与 POST，其它方法 405', async () => {
  const { routes } = await boot()
  const wrong1 = await call(routes, '/lwm/embedding', fakeReq('PUT', '/lwm/embedding'))
  assert.equal(wrong1.status, 405)
  const wrong2 = await call(routes, '/lwm/embedding/test', fakeReq('GET', '/lwm/embedding/test'))
  assert.equal(wrong2.status, 405)
})
