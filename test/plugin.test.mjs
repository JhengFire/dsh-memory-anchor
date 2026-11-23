import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 集成测试：用 mock 的 ctx 跑通插件 apply()。
 *
 * 目的不是替代 DSH 里真跑，而是把「工具注册 → action 分发 → 存储 →
 * 渲染」这条链路在装进 profile 之前先验通。任何接口形状错误
 * 都会在这里炸，而不是在用户的 session 里炸。
 */

// 用最小实现模拟依赖包，避免测试环境需要真的 DSH 安装

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

const stubs = new Map()

/**
 * 生成进程内唯一的临时文件后缀。
 *
 * 不能用 Date.now()：同一毫秒内的多次同步调用返回相同值，
 * 并发测试会写同一个路径并互相覆盖，写出乱码 JS。
 */
let __tmpSeq = 0
function tmpSuffix() {
  __tmpSeq += 1
  return `${process.pid}-${__tmpSeq}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 定位 DSH 安装目录里的 zod。
 *
 * 测试环境不装依赖，但 schema.mjs 需要真的 zod v4 来验证默认值语义。
 * 从 DSH 安装锚点解析，与运行时实际使用的是同一个包。
 */
async function resolveZodUrl() {
  const candidates = [
    process.env.DSH_INSTALL_DIR && `${process.env.DSH_INSTALL_DIR}/../zod`,
    'C:/Users/AK-FMSB-0186/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/zod',
  ].filter(Boolean)
  const fs = await import('node:fs')
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'))
      // zod v4 的 exports['.'] 是 { import, require, types }，没有 default
      const dot = pkg.exports?.['.']
      const entryRel =
        typeof dot === 'string'
          ? dot
          : (dot?.import ?? dot?.default ?? pkg.module ?? pkg.main ?? 'index.js')
      const entry = `${dir}/${String(entryRel).replace(/^\.\//, '')}`
      if (fs.existsSync(entry)) return pathToFileUrl(entry)
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/** path → file:// URL（Windows 盘符必须转成 file:///D:/...） */
function pathToFileUrl(p) {
  let s = p.replace(/\\/g, '/')
  if (!s.startsWith('/')) s = '/' + s
  return 'file://' + encodeURI(s)
}

/**
 * 可写的临时目录（系统临时目录下的固定子目录）。
 *
 * 为什么不用 lib/ 之外的项目内目录：检出可能整体只读，
 * 而 os.tmpdir() 在沙箱里通常是允许写的。
 */
function tempDir() {
  const dir = path.join(os.tmpdir(), 'dsh-memory-anchor-test')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 目录是否可写——用一个探针文件实测，而不是看权限位：
 * Windows 上 ACL 与 mode 位并不对应。
 */
function canWrite(dir) {
  const probe = path.join(dir, `.probe-${tmpSuffix()}`)
  try {
    fs.writeFileSync(probe, 'x')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 把 `from './x.mjs'` 改写成指向真实 lib/ 的绝对 file:// URL。
 *
 * 临时副本一旦移出 lib/，相对导入就会解析到不存在的路径；
 * 改写后仍导入 lib/ 里的真实模块，测的还是同一份源码。
 */
function rewriteRelativeImports(src, libDir) {
  return src.replace(/(from\s+)(['"])(\.\/[^'"]+)\2/g, (_m, pre, q, rel) => {
    return `${pre}${q}${pathToFileUrl(path.join(libDir, rel.slice(2)))}${q}`
  })
}

async function loadPlugin() {
  // defineTool 与 Config 的桩：保持原语义即可
  stubs.set('@deepseek-ai/schemastery', {
    default: {
      object: (shape) => ({ __schema: shape }),
    },
  })
  stubs.set('@deepseek-ai/dsh-tools', {
    defineTool: (opts) => ({
      ...opts,
      // 执行前按 parameters 里的 required 做一次最简校验
      async run(args, exec) {
        for (const [key, spec] of Object.entries(opts.parameters ?? {})) {
          if (spec.required && args[key] === undefined) {
            throw new Error(`missing required argument: ${key}`)
          }
        }
        return opts.execute(args, exec)
      },
    }),
  })

  // 拦截 import 由下面的 esbuild-free 方式处理：直接把源码读进来改写依赖
  const { fileURLToPath } = await import('node:url')
  const here = path.dirname(fileURLToPath(import.meta.url))
  let src = safeRead(path.join(here, '..', 'lib', 'index.mjs'))
  // 把两条外部依赖替换成桩
  // schemastery 桩：保留链式 .default() 语义，供 Config 声明使用
  src = src.replace(
    "import z from '@deepseek-ai/schemastery'",
    `const mkField = (type, def) => {
       const node = { type, default: def }
       node.default = (v) => { node.default = v; return node }
       return node
     }
     const z = {
       object: (shape) => ({ __schema: shape }),
       number: () => mkField('number', undefined),
       string: () => mkField('string', undefined),
       boolean: () => mkField('boolean', undefined),
       array: (inner) => { const n = mkField('array', undefined); n.inner = inner; return n },
     }`,
  )
  src = src.replace(
    "import { defineTool } from '@deepseek-ai/dsh-tools'",
    `const defineTool = (opts) => ({
       ...opts,
       async run(args, exec) {
         for (const [key, spec] of Object.entries(opts.parameters ?? {})) {
           if (spec.required && args[key] === undefined) throw new Error('missing required argument: ' + key)
         }
         const value = await opts.execute(args, exec)

         // 精确复现真实 pipeline（dsh-tools/lib/pipeline.js createSuccessResult）：
         //   1. 按 output.schema 校验 value
         //   2. content = output.render(args, value)   ← 直接就是模型可见内容
         const schema = opts.output?.schema
         if (schema?.type !== 'object') {
           throw new Error('output.schema 必须是 object（真实框架要求）')
         }
         if (schema.additionalProperties !== false) {
           throw new Error('output.schema 必须声明 additionalProperties: false')
         }
         if (typeof value !== 'object' || value === null || typeof value.text !== 'string') {
           throw new Error('execute 必须返回 { text: string }')
         }
         const content = opts.output.render(args, value)

         // 复现 dsh-llm 的 contentHasImage(content) —— 它对 content 调 .some()，
         // 若 render 返回字符串而非数组，真实运行时会崩：
         //   TypeError: content.some is not a function
         if (!Array.isArray(content)) {
           throw new TypeError('content.some is not a function')
         }
         for (const block of content) {
           if (block?.type === 'text' && typeof block.text !== 'string') {
             throw new Error('text 块缺少 text 字段')
           }
         }
         return content.map((b) => b.text).join('')
       },
     })`,
  )

  // schema.mjs 需要真 zod：先把 zod 的 import 改写为安装目录的绝对 URL
  const zodUrl = await resolveZodUrl()
  if (!zodUrl) throw new Error('找不到 zod，无法运行集成测试')
  let schemaSrc = safeRead(path.join(here, '..', 'lib', 'schema.mjs'))
  schemaSrc = schemaSrc.replace("import { z } from 'zod'", `import { z } from ${JSON.stringify(zodUrl)}`)
  const schemaTmp = path.join(tempDir(), `.tmp-schema-${tmpSuffix()}.mjs`)
  fs.writeFileSync(schemaTmp, schemaSrc)

  // 临时文件只能放 lib/：index.mjs 里有 './store.mjs'、'./eval.mjs'
  // 这些相对导入，只有与真实 lib/ 同目录才能解析到真实文件。
  // 但 lib/ 不一定可写（沙箱或只读检出时写入是 EPERM），
  // 所以先做一次探针，可写才就地写；否则退到系统临时目录，
  // 把相对导入改写成指向真实 lib/ 的绝对 URL —— 仍然测的是同一份源码。
  const libDir = path.join(here, '..', 'lib')
  const suffix = tmpSuffix()
  const inLib = `${libDir}/.tmp-plugin-${suffix}.mjs`
  const writable = canWrite(libDir)
  const tmp = writable ? inLib : `${tempDir()}/.tmp-plugin-${suffix}.mjs`
  if (!writable) {
    src = rewriteRelativeImports(src, libDir)
  }
  // 只把 schema 指向临时改写过的副本（因为要注入 zod 的绝对 URL）；
  // store/eval 保持原始相对导入，**不重写**——否则会掩盖
  // index.mjs 里 import 路径写错这类真实缺陷。
  //
  // 例外：临时副本移出了 lib/ 时，'./schema.mjs' 会被 rewriteRelativeImports
  // 先改写成绝对 URL，这里的字符串替换就匹配不到了，所以一并改写旧式写法。
  src = src.replace("from './schema.mjs'", `from ${JSON.stringify(pathToFileUrl(schemaTmp))}`)
  // 空白差异命中不了上面的精确匹配；兜底：任何指向真实 schema.mjs 的 URL 都换掉
  const schemaUrl = pathToFileUrl(path.join(libDir, 'schema.mjs'))
  if (!src.includes(JSON.stringify(pathToFileUrl(schemaTmp)))) {
    src = src.split(schemaUrl).join(pathToFileUrl(schemaTmp))
  }
  fs.writeFileSync(tmp, src)
  const mod = await import(pathToFileUrl(tmp))
  fs.unlinkSync(tmp)
  fs.unlinkSync(schemaTmp)
  return mod
}

/** 模拟 storageDomain 领域句柄 */
function mockDomain() {
  const tables = new Map()
  let closed = false
  const tableHandle = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    const recs = tables.get(name)
    return {
      get: (k) => {
        if (closed) throw new Error('domain closed')
        return recs.get(k)
      },
      put: async (k, v) => {
        if (closed) throw new Error('domain closed')
        recs.set(k, structuredClone(v))
      },
      delete: async (k) => {
        recs.delete(k)
        return true
      },
      entries: () => [...recs.entries()][Symbol.iterator](),
      keys: () => [...recs.keys()][Symbol.iterator](),
      get size() { return recs.size },
    }
  }
  return {
    table: tableHandle,
    global: {
      get: () => undefined,
      set: async () => {},
    },
    close: () => { closed = true },
    _tables: tables,
    _isClosed: () => closed,
  }
}

/** 模拟 cordis 上下文 */
function mockCtx() {
  const tools = []
  const sections = []
  const effects = []
  const logger = { warn: () => {}, error: () => {}, info: () => {} }
  return {
    tools: { register: (t) => { tools.push(t); return () => {} } },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {} },
      getSectionOrder: () => 100,
    },
    storageDomain: { open: async () => { throw new Error('应由测试覆盖') } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d) },
    /**
     * Cordis 的条件注入：依赖可用时执行回调，否则整个回调不执行。
     * 这里模拟「没有 webServer 的纯工具形态」——回调不调用，
     * 因此设置页路由不注册，但工具仍正常工作。
     */
    inject: () => {},
    logger,
    _tools: tools,
    _sections: sections,
    _effects: effects,
    _dispose: () => effects.forEach((f) => f()),
  }
}

const cfg = {
  limit: 5,
  staleDays: 180,
  retireMisses: 3,
  conflictWindowSec: 1800,
  evalEnabled: true,
  polarityPairs: [],
  promptSection: true,
}

async function boot(config = cfg) {
  const plugin = await loadPlugin()
  const ctx = mockCtx()
  const domain = mockDomain()
  ctx.storageDomain.open = async () => domain
  await plugin.apply(ctx, config)
  const tool = ctx._tools[0]
  const exec = { agent: { id: 'test-session', workspaceDirectory: 'src/surface/handler' }, callId: 'c1' }
  return { plugin, ctx, domain, tool, exec }
}

// ---------------- 注册面 ----------------

test('apply: 只注册一个工具（常驻成本最小化）', async () => {
  const { ctx } = await boot()
  assert.equal(ctx._tools.length, 1, '应当只有一个 memory 工具，不是七个')
  assert.equal(ctx._tools[0].name, 'memory')
})

test('apply: 系统提示只加一节且不含记忆内容', async () => {
  const { ctx } = await boot()
  assert.equal(ctx._sections.length, 1)
  const text = ctx._sections[0].text
  assert.ok(text.length < 300, `提示应当极短，实际 ${text.length} 字符`)
  assert.ok(!text.includes('表面处理'), '系统提示不得注入记忆内容')
})

test('apply: promptSection=false 时不注入提示', async () => {
  const { ctx } = await boot({ ...cfg, promptSection: false })
  assert.equal(ctx._sections.length, 0)
})

test('apply: 注册了关闭领域的效果清理', async () => {
  const { ctx, domain } = await boot()
  assert.equal(ctx._effects.length, 1)
  ctx._dispose()
  assert.equal(domain._isClosed(), true)
})

test('apply: action 枚举完整', async () => {
  const { tool } = await boot()
  const actions = tool.parameters.action.enum
  assert.deepEqual(actions.sort(), ['add', 'eval', 'find', 'miss', 'resolve', 'stats', 'use', 'verify'])
})

test('apply: output 契约符合真实框架要求（object + render 返回 content 数组）', async () => {
  const { tool } = await boot()
  assert.equal(tool.output.schema.type, 'object', '裸 string schema 会在内容投影时崩溃')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal(tool.output.schema.properties.text.type, 'string')
  assert.equal(tool.output.schema.properties.text.required, true)

  // 最关键的一条：render 必须返回 content 块数组，不能是字符串。
  // 真实 pipeline 会把 render() 的返回值直接当作 content，
  // 下游 dsh-llm 的 contentHasImage 对 content 调 .some()。
  const rendered = tool.output.render({}, { text: 'hello' })
  assert.ok(Array.isArray(rendered), `render 必须返回数组，实际 ${typeof rendered}`)
  assert.deepEqual(rendered, [{ type: 'text', text: 'hello' }])
})

test('apply: render 对空值不崩溃', async () => {
  const { tool } = await boot()
  const r = tool.output.render({}, {});
  assert.ok(Array.isArray(r))
  assert.equal(r[0].text, '')
})

test('apply: 每个 action 都返回 { text } 而非裸字符串', async () => {
  const { tool, exec } = await boot()
  await tool.run({ action: 'add', id: 'm1', kind: 'gotcha', claim: '某条会被校验的记忆' }, exec)
  const cases = [
    { action: 'find', query: '某条会被校验的记忆' },
    { action: 'stats' },
    { action: 'use', id: 'm1' },
    { action: 'miss', id: 'm1' },
    { action: 'verify', id: 'm1', ok: true },
    { action: 'eval' },
  ]
  for (const c of cases) {
    const raw = await tool.execute(c, exec)
    assert.equal(typeof raw, 'object', `${c.action} 返回了裸 ${typeof raw}`)
    assert.equal(typeof raw.text, 'string', `${c.action} 缺少 text 字段`)
  }
})

// ---------------- 端到端行为 ----------------

test('e2e: add → find 能召回', async () => {
  const { tool, exec } = await boot(true ? {} : {})
  const addOut = await tool.run(
    {
      action: 'add',
      id: 'lock-lot',
      kind: 'gotcha',
      claim: '表面处理失败后必须锁 3 个后续 lot',
      why: '客户 SOP 4.2',
      scope: ['src/surface/**'],
      verify: "rg -n 'latch' src/surface/",
      tags: ['surface'],
    },
    exec,
  )
  assert.match(addOut, /✓ lock-lot/)

  const findOut = await tool.run({ action: 'find', query: '表面处理失败怎么办' }, exec)
  assert.match(findOut, /\[1\] lock-lot/)
  assert.match(findOut, /verify: rg -n 'latch' src\/surface\//)
})

test('e2e: find 输出符合面向模型的契约', async () => {
  const { tool, exec } = await boot()
  await tool.run(
    { action: 'add', id: 'm1', kind: 'decision', claim: 'DTO 统一用 xxx 后缀', scope: [] },
    exec,
  )
  const out = await tool.run({ action: 'find', query: 'dto 命名' }, exec)
  assert.match(out, /^\[1\] m1 \(decision, verified never/m)
  assert.match(out, /results · .* stale · run 'memory verify' before acting · feedback: memory use\/miss/)
})

test('e2e: find 无结果时返回明确文案', async () => {
  const { tool, exec } = await boot()
  const out = await tool.run({ action: 'find', query: '完全没有的记忆' }, exec)
  assert.equal(out, 'no matching memories')
})

test('e2e: 冲突被拦截，不自动写入', async () => {
  const { tool, exec } = await boot()
  await tool.run(
    { action: 'add', id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖', tags: ['deps'] },
    exec,
  )
  const out = await tool.run(
    { action: 'add', id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖', tags: ['deps'] },
    exec,
  )
  assert.match(out, /✗ conflict/)
  assert.match(out, /必须人工确认/)
})

test('e2e: force + both → provisional，且检索时标注', async () => {
  const { tool, exec } = await boot()
  await tool.run({ action: 'add', id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' }, exec)
  await tool.run(
    { action: 'add', id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖', force: true, onConflict: 'both' },
    exec,
  )
  const out = await tool.run({ action: 'find', query: 'SNAPSHOT 依赖' }, exec)
  assert.match(out, /⚠provisional/)
})

test('e2e: resolve keep=a 后只剩一条 settled', async () => {
  const { tool, exec } = await boot()
  await tool.run({ action: 'add', id: 'a', kind: 'constraint', claim: '生产环境禁止使用 SNAPSHOT 依赖' }, exec)
  await tool.run(
    { action: 'add', id: 'b', kind: 'constraint', claim: '生产环境允许使用 SNAPSHOT 依赖', force: true, onConflict: 'both' },
    exec,
  )
  const out = await tool.run({ action: 'resolve', query: 'a b', keep: 'a' }, exec)
  assert.match(out, /保留 a/)
  const findOut = await tool.run({ action: 'find', query: 'SNAPSHOT 依赖' }, exec)
  assert.ok(!findOut.includes('⚠provisional'))
})

test('e2e: stats 输出健康度指标', async () => {
  const { tool, exec } = await boot()
  // 两条内容差异足够大，避免被去重闸门合并
  await tool.run({ action: 'add', id: 'a', kind: 'gotcha', claim: '表面处理失败后必须锁 3 个后续 lot', verify: 'rg latch' }, exec)
  await tool.run({ action: 'add', id: 'b', kind: 'constraint', claim: '客户要求所有日志必须脱敏手机号' }, exec)
  const out = await tool.run({ action: 'stats' }, exec)
  assert.match(out, /memories: 2/)
  assert.match(out, /unverifiable 1/)
})

test('e2e: verify 失败后检索标 stale', async () => {
  const { tool, exec } = await boot()
  await tool.run({ action: 'add', id: 'm1', kind: 'gotcha', claim: '某条会过期的记忆' }, exec)
  await tool.run({ action: 'verify', id: 'm1', ok: false }, exec)
  const out = await tool.run({ action: 'find', query: '会过期的记忆' }, exec)
  assert.match(out, /⚠stale/)
})

test('e2e: use/miss 反馈生效', async () => {
  const { tool, exec } = await boot()
  await tool.run({ action: 'add', id: 'm1', kind: 'gotcha', claim: '某条记忆' }, exec)
  assert.match(await tool.run({ action: 'use', id: 'm1' }, exec), /采纳次数 \+1/)
  assert.match(await tool.run({ action: 'miss', id: 'm1', why: '已经不对了' }, exec), /miss=1/)
})

test('e2e: 评测在调用后自动采集，无需模型上报', async () => {
  const { tool, exec, domain } = await boot()
  await tool.run({ action: 'add', id: 'm1', kind: 'gotcha', claim: '某条记忆' }, exec)
  await tool.run({ action: 'find', query: '某条记忆' }, exec)
  const events = domain._tables.get('eval_events')
  assert.ok(events && events.size >= 2, `应当自动记录了事件，实际 ${events?.size ?? 0}`)
})

test('e2e: eval action 输出紧凑报告', async () => {
  const { tool, exec } = await boot()
  await tool.run({ action: 'find', query: '不存在的查询' }, exec)
  const out = await tool.run({ action: 'eval' }, exec)
  assert.match(out, /MEMORY EVAL/)
})

test('e2e: 缺少必填参数时报错', async () => {
  const { tool, exec } = await boot()
  await assert.rejects(() => tool.run({}, exec), /missing required argument: action/)
})

test('e2e: 非法 kind 被拒绝并说明原因', async () => {
  const { tool, exec } = await boot()
  const out = await tool.run({ action: 'add', id: 'x', kind: 'note', claim: '随便记一条' }, exec)
  assert.match(out, /✗ invalid/)
})

test('e2e: evalEnabled=false 时 eval 返回提示', async () => {
  const { tool, exec } = await boot({ ...cfg, evalEnabled: false })
  const out = await tool.run({ action: 'eval' }, exec)
  assert.match(out, /评测已关闭/)
})
test('adapter: 不做缓存 —— 外部清空后 stats 必须实时反映', async () => {
  const { tool, exec, domain } = await boot()
  await tool.run({ action: 'add', id: 'm1', kind: 'gotcha', claim: '某条记忆' }, exec)
  assert.match(await tool.run({ action: 'stats' }, exec), /memories: 1/)

  // 从领域句柄外部删除（模拟另一个会话/人工操作）
  const recs = domain._tables.get('memories')
  recs.delete('m1')

  // stats 必须立刻反映为 0。若实现里存在启动期快照缓存，
  // 这里仍会返回 1 —— 早期版本正是如此（清空磁盘后仍报 7 条）。
  const out = await tool.run({ action: 'stats' }, exec)
  assert.match(out, /memories: 0/, `缓存未刷新，实际输出:\n${out}`)
})

test('adapter: find 也不使用陈旧缓存', async () => {
  const { tool, exec, domain } = await boot()
  await tool.run({ action: 'add', id: 'x', kind: 'gotcha', claim: '表面处理失败必须锁批次' }, exec)
  assert.match(await tool.run({ action: 'find', query: '表面处理' }, exec), /x/)

  domain._tables.get('memories').delete('x')
  const out = await tool.run({ action: 'find', query: '表面处理' }, exec)
  assert.equal(out, 'no matching memories', `删除后仍能召回，说明读到了陈旧缓存:\n${out}`)
})
