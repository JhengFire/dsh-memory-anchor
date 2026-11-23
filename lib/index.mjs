/**
 * `dsh-memory-anchor` —— Host 半侧。
 *
 * 轻量 Agent 记忆：只记决策、否决、踩坑与约束，其余一律不记。
 *
 * ## 设计要点
 *
 * 1. **单工具 + action 分发**。只注册一个 `memory` 工具而非七个，
 *    常驻 schema 成本从约 800 token 降到约 250。工具越多，模型越会
 *    「既然有就调一下」，那正是记忆通胀。
 * 2. **零常驻查询成本**。系统提示只加一行说明，不含记忆内容本身。
 * 3. **存储走 storageDomain**。schema 校验 + 写入即持久 + 可读 JSON。
 * 4. **评测自动采集**。每次工具调用的成败由插件自己记录，不要求
 *    模型主动上报，因此 F7（反馈缺失）在插件形态下可被观测而非假定。
 *
 * @module dsh-memory-anchor/host
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { lwmDomain } from './schema.mjs'
import { MemoryStore } from './store.mjs'
import { createProvider, unpackStored } from './embedding.mjs'
import { listProviders } from './providers/registry.mjs'
import { Evaluator } from './eval.mjs'
import { renderHits } from './render.mjs'

/** Cordis 函数式插件名。 */
export const name = 'memory-anchor'

/**
 * 依赖的服务。
 *
 * `webServer` 用于给设置页提供分页读取与开关的 HTTP 接口。它是可选依赖：
 * 在没有 Web 服务的组合里（纯 CLI），插件仍应注册工具正常工作，
 * 只是设置页不出现。因此放在下面用 ctx.inject 条件注入，而非硬依赖。
 */
export const inject = ['tools', 'systemPrompt', 'storageDomain']

/** 配置：全部可调项放这里，用户改动在 patch 里，升级不丢。 */
export const Config = z.object({
  /** 检索默认返回条数。 */
  limit: z.number().default(5),
  /** 衰减阈值：多少天未验证转 stale。 */
  staleDays: z.number().default(180),
  /** 衰减阈值：连续多少 miss 且零采纳转 retired。 */
  retireMisses: z.number().default(3),
  /** S2「可判定」时间窗口（秒），超过则降级为 S3。 */
  conflictWindowSec: z.number().default(1800),
  /** 是否启用评测采集。 */
  evalEnabled: z.boolean().default(true),
  /**
   * 记忆功能总开关。设置页的滑动按钮改的就是它。
   *
   * 关闭时：`memory` 工具的 find/add/use/miss 等仍可调用，但写入会被拒绝，
   * 检索返回空并提示已停用。之所以不直接注销工具，是因为工具的注册与注销
   * 属于本 session 的上下文，运行中动态增删会破坏已在进行的调用；
   * 用软开关更安全，且对用户可见。
   */
  enabled: z.boolean().default(true),
  /**
   * 向量模型供应商。
   *
   * 空字符串表示不启用远程向量，只使用本地哈希向量（零依赖，开箱可用）。
   * 填入供应商 id 后，写入时会调用其 API 生成语义向量。
   */
  embeddingProvider: z.string().default(''),
  /**
   * 供应商 API 地址。留空用该供应商的默认地址。
   *
   * 支持三种写法，都会归一到完整端点：
   *   https://ark.cn-beijing.volces.com/api/v3
   *   https://ark.cn-beijing.volces.com/api/v3/
   *   https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal
   */
  embeddingApiUrl: z.string().default(''),
  /** API Key。设置页以密码形式展示。 */
  embeddingApiKey: z.string().default(''),
  /**
   * 模型名或接入点 ID。
   *
   * 留空用供应商默认模型。火山若用推理接入点，此处填 ep-xxxxxxxx 形式。
   */
  embeddingModelName: z.string().default(''),
  /**
   * 向量维度。默认 1024。
   *
   * 实测 1024 与 2048 的区分度相当（1024 甚至略优），而存储减半，
   * 所以默认取 1024。改这里会改变模型标识，已有向量需要 reindex。
   */
  embeddingDimensions: z.number().default(1024),
  /** 调用超时（毫秒）。超时即降级为本地向量，不阻塞写入。 */
  embeddingTimeoutMs: z.number().default(8000),

  /** 自定义极性词表，每行 `肯定词=否定词`。留空用内置。 */
  polarityPairs: z.array(z.string()).default([]),
  /** 系统提示中是否注入一行记忆用法说明。 */
  promptSection: z.boolean().default(true),
})

/**
 * 把 storageDomain 的领域句柄适配成 MemoryStore 期望的接口。
 *
 * 关键契约是**读同步、写异步**，与 storageDomain 的语义一致，
 * 因此这个适配是零拷贝的薄封装。
 *
 * @param {any} domain
 */
function adapterOf(domain) {
  /** @param {string} t */
  const table = (t) => domain.table(t)
  return {
    get: (t, k) => {
      try {
        return table(t).get(k)
      } catch {
        return undefined
      }
    },
    put: (t, k, v) => table(t).put(k, v),
    delete: (t, k) => table(t).delete(k),
    list: (t) => {
      // storageDomain 的表句柄没有 list，用全量快照投影
      try {
        const map = table(t)
        // 兼容两种可能形态：带 entries() 的实现，或直接可迭代
        if (typeof map.entries === 'function') return Object.fromEntries(map.entries())
        if (typeof map.records === 'function') return map.records()
      } catch {
        /* 落到下面的空对象 */
      }
      return {}
    },
    getGlobal: () => domain.global?.get?.(),
    setGlobal: (v) => domain.global?.set?.(v),
  }
}

/**
 * 插件入口。
 * @param {any} ctx
 * @param {ReturnType<typeof Config>} config
 */
export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(lwmDomain)
  ctx.effect(() => () => domain.close())

  const adapter = makeAdapter(domain, ctx)
  const store = new MemoryStore(adapter, {
    // 向量提供者：未配置 API 时为本地哈希（零依赖可用）
    provider: createProvider(config),
    staleDays: config.staleDays,
    retireMisses: config.retireMisses,
    polarityPairs: config.polarityPairs,
  })
  const evaluator = config.evalEnabled ? new Evaluator(adapter) : null

  /**
   * 记忆功能总开关。工具与设置页路由共享这一份状态，
   * 保证"在设置里关掉"立刻对工具生效，无需重启。
   */
  const power = { enabled: config.enabled !== false }
  const isEnabled = () => power.enabled

  /**
   * 需要开关放行的 action。stats / eval 属于纯读的诊断能力，
   * 关闭记忆后仍应可用——否则用户会失去排查"到底记了什么"的途径。
   */
  const READ_WRITE_ACTIONS = new Set([
    'find',
    'add',
    'verify',
    'resolve',
    'use',
    'miss',
  ])

  // ------------------------------------------------------------------
  // 评测埋点：包一层，所有 action 自动记录成败
  // ------------------------------------------------------------------
  /**
   * @param {string} action
   * @param {object} exec 工具执行上下文
   * @param {object} payload 摘要
   * @param {() => Promise<any>|any} fn
   */
  async function traced(action, exec, payload, fn) {
    const cwd = exec?.agent?.workspaceDirectory ?? process.cwd()
    const session = exec?.agent?.id ?? exec?.callId ?? 'local'
    let returned = []
    try {
      const out = await fn()
      returned = collectIds(out)
      if (evaluator) {
        await evaluator.record({ session, action, payload, cwd, ok: true, returned }).catch(noop)
      }
      // 统一出口：所有 action 都返回 { text }，符合 output.schema 的 object 契约
      return { text: typeof out === 'string' ? out : String(out ?? '') }
    } catch (error) {
      await writeDiagnostic(ctx, action, error)
      if (evaluator) {
        await evaluator
          .record({ session, action, payload, cwd, ok: false, returned: [] })
          .catch(noop)
      }
      throw error
    }
  }

  // ------------------------------------------------------------------
  // 唯一注册的工具
  // ------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'memory',
      description:
        'Project memory: record and retrieve decisions, rejected approaches, gotchas and constraints. ' +
        'Use `find` before assuming a settled decision, `add` only when a decision was actually made, ' +
        '`verify` before acting on a recalled memory, and `use`/`miss` to report whether it helped.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['find', 'add', 'verify', 'resolve', 'use', 'miss', 'stats', 'eval'],
          description:
            'find: retrieve memories for a query. add: record a decision/rejection/gotcha/constraint. ' +
            'verify: report whether a memory still holds. resolve: settle a conflict between two memories. ' +
            'use/miss: report whether a recalled memory helped. stats: library health. eval: failure report.',
        },
        query: {
          type: 'string',
          description: 'Search text for `find`, or the memory id for `verify`/`use`/`miss`.',
        },
        id: {
          type: 'string',
          description: 'Stable slug when adding (e.g. "surf-fail-latch"); target id for verify/use/miss.',
        },
        kind: {
          type: 'string',
          enum: ['decision', 'constraint', 'gotcha', 'rejected'],
          description:
            'Only these four are allowed to be written. rejected is often the most valuable: ' +
            'it records an approach that was tried and abandoned, preventing the debate from reopening.',
        },
        claim: {
          type: 'string',
          description: 'One single-sentence assertion that can be judged true or false. Not a paragraph.',
        },
        why: { type: 'string', description: 'Who decided it and on what basis.' },
        scope: {
          type: 'array',
          description:
            'Where this memory applies. Empty means global. ' +
            'Use ["workspace"] for the current workspace directory and everything under it — ' +
            'prefer this over an absolute path, which breaks when the repo moves. ' +
            'Path globs like ["src/surface/**"] narrow it further.',
        },
        apply: {
          type: 'boolean',
          description: 'reindex 专用：为 true 时真正写入，默认干跑只统计。',
        },
        limit: {
          type: 'number',
          description: 'reindex 专用：本次最多处理多少条，便于分批。',
        },
        verify: {
          type: 'string',
          description: 'One executable check proving it still holds, e.g. "rg latch src/surface".',
        },
        tags: { type: 'array', description: 'Topic tags used for conflict detection.' },
        ok: { type: 'boolean', description: 'Result for `verify`: true if still valid.' },
        force: { type: 'boolean', description: 'Bypass duplicate/conflict gate when adding.' },
        onConflict: {
          type: 'string',
          enum: ['newer', 'both'],
          description: 'With force: keep the new one, or keep both as provisional.',
        },
        keep: {
          type: 'string',
          enum: ['a', 'b', 'both'],
          description: 'For `resolve`: which side survives.',
        },
      },
      // 输出契约（实测确定，见设计文档 D.9 / D.10）：
      //
      //   output.schema  描述 execute() 返回值的结构 → object + additionalProperties:false
      //   output.render  返回值**直接就是模型可见的 content 块数组**
      //
      // 关键：render 的返回值被 pipeline.js 直接赋给 `content`
      //   rendered = tool.output.render(args, value)
      //   const content = snapshotProjection(name, 'render', rendered)
      // 而下游 dsh-llm 的 contentHasImage(content) 会对 content 调 .some()，
      // 若 render 返回字符串而非数组，就会抛 `content.some is not a function`。
      // 因此 render 必须返回 [{ type: 'text', text }]。
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args, exec) {
        const cwd = exec?.agent?.workspaceDirectory ?? process.cwd()

        // 总开关关闭时：读写类 action 一律拒绝，只放行只读的诊断类。
        //
        // 为什么不直接不注册工具：工具注册属于 session 上下文，运行中增删
        // 会打断正在进行中的调用。软开关更安全，也能让模型看到明确原因，
        // 而不是面对一个"工具突然消失"的困惑。
        if (!isEnabled() && READ_WRITE_ACTIONS.has(args.action)) {
          return {
            text:
              `memory 已停用（设置 → 记忆功能 中关闭）。` +
              `当前 action "${args.action}" 需要先启用。` +
              `stats / eval 仍可查看历史数据。`,
          }
        }

        switch (args.action) {
          case 'find':
            return traced('find', exec, { query: args.query }, async () => {
              const hits = await store.find(args.query ?? '', { limit: config.limit, cwd, workspace: cwd })
              return renderHits(hits)
            })

          case 'add':
            return traced('add', exec, { id: args.id, query: args.claim }, async () => {
              const r = await store.add({
                id: args.id ?? slugOf(args.claim ?? ''),
                kind: args.kind,
                claim: args.claim,
                why: args.why,
                scope: args.scope,
                verify: args.verify,
                tags: args.tags,
                force: args.force,
                onConflict: args.onConflict,
                source: exec?.agent?.id ?? '',
              })
              // 成功文案按 verdict 区分。
              // 早先所有成功都用 `✓ ${id} — ${message}`，而 conflict 场景
              // 的 message 是一大段冲突说明，容易被读成"失败"。
              // 现在成功一律以 ✓ 开头表明已写入，冲突警告另起一行并用 ⚠ 标记。
              if (!r.ok) return `✗ ${r.verdict}: ${r.message}`
              if (r.verdict === 'conflict') {
                return `✓ ${r.id} — 已写入（stability=provisional，冲突未裁决）\n⚠ ${r.message}`
              }
              if (r.verdict === 'overwrite' && r.superseded?.length) {
                return `✓ ${r.id} — 已写入，取代 ${r.superseded.join(', ')}`
              }
              return `✓ ${r.id} — ${r.message}`
            })

          case 'verify':
            return traced('verify', exec, { id: args.id ?? args.query }, async () => {
              const r = await store.verify(args.id ?? args.query, args.ok !== false)
              return r.message
            })

          case 'use':
            return traced('use', exec, { id: args.id ?? args.query }, async () => {
              return (await store.use(args.id ?? args.query)).message
            })

          case 'miss':
            return traced('miss', exec, { id: args.id ?? args.query }, async () => {
              return (await store.miss(args.id ?? args.query, args.why ?? '')).message
            })

          case 'resolve': {
            return traced('resolve', exec, { query: args.query }, async () => {
              const [a, b] = String(args.query ?? '').split(/\s+/).filter(Boolean)
              if (!a || !b) return 'resolve 需要两个 id，用空格分隔'
              const r = await store.resolve(a, b, args.keep ?? 'both')
              return r.message
            })
          }

          case 'reindex':
            return traced(
              'reindex',
              exec,
              { query: args.apply ? 'apply' : 'dry-run' },
              async () => {
                const r = await store.reindex({
                  apply: args.apply === true,
                  limit: args.limit,
                })
                const outLines = [
                  `target model: ${r.targetModel}`,
                  `total ${r.total}  ·  need reindex ${r.todo}`,
                ]
                if (!r.applied) {
                  outLines.push('')
                  if (r.todo === 0) {
                    outLines.push('所有条目已在目标模型上，无需操作。')
                  } else {
                    outLines.push('干跑模式，未写入。加 apply=true 执行。')
                    outLines.push(`预计调用 ${r.todo} 次 embedding API。`)
                  }
                  return outLines.join('\n')
                }
                outLines.push(`done ${r.done}  ·  failed ${r.failed}`)
                if (r.errors.length) {
                  outLines.push('')
                  outLines.push('errors:')
                  for (const e of r.errors.slice(0, 5)) outLines.push(`  ${e}`)
                }
                if (r.failed > 0 && r.done < r.todo) {
                  outLines.push('')
                  outLines.push('未完成的部分可再次运行 reindex 续跑：已成功的条目会被跳过。')
                }
                return outLines.join('\n')
              },
            )

          case 'stats':
            return traced('stats', exec, {}, () => {
              const s = store.stats()
              return [
                `memories: ${s.total}  ` +
                  Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(' | '),
                `kinds: ` + Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(' | '),
                `health: unverifiable ${s.unverifiable} (${(s.unverifiablePct * 100).toFixed(0)}%)  ` +
                  `never-verified ${s.neverVerified} (${(s.neverVerifiedPct * 100).toFixed(0)}%)  ` +
                  `miss/write ${s.missWriteRatio.toFixed(2)}`,
              ].join('\n')
            })

          case 'eval':
            return traced('eval', exec, {}, async () => {
              if (!evaluator) return '评测已关闭（config.evalEnabled = false）'
              await evaluator.analyze()
              return evaluator.report({ forAgent: true })
            })

          default:
            return { text: `未知 action: ${args.action}` }
        }
      },
    }),
  )

  // ------------------------------------------------------------------
  // 系统提示：只加一行，不含记忆内容
  // ------------------------------------------------------------------
  if (config.promptSection) {
    ctx.systemPrompt.section({
      name: 'tool:memory',
      order: ctx.systemPrompt.getSectionOrder?.('TOOL_BASH') ?? 100,
      text:
        'Check `memory find` before assuming how a settled decision was made; ' +
        'report `memory verify` before acting on a recalled memory, ' +
        'and `memory use`/`miss` afterwards so stale memories decay.',
    })
  }

  // ------------------------------------------------------------------
  // 设置页接口
  //
  // 用 HTTP 路由而非 Typert remote：remote 需要生成式的命名空间注册，
  // 对一个只读列表 + 一个开关来说过重。webServer 是可选依赖，
  // 没有 Web 服务的组合里这段不注册，插件仍以纯工具形态工作。
  // ------------------------------------------------------------------
  ctx.inject(['webServer'], (webCtx) => {
    const sendJson = (res, status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }

    const readBody = async (req, limit = 8192) => {
      let size = 0
      const chunks = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > limit) throw new Error('body too large')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? JSON.parse(text) : {}
    }

    // GET /lwm/state —— 开关状态 + 总量，供页面首屏使用
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/lwm/state',
          handler: (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const all = Object.values(adapter.list('memories') ?? {})
            sendJson(res, 200, {
              enabled: power.enabled,
              total: all.length,
              active: all.filter((m) => m.status === 'active').length,
            })
          },
        }),
      'memory-anchor: GET /lwm/state',
    )

    // GET /lwm/list?page=1&pageSize=10 —— 分页读取
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/lwm/list',
          handler: (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            // 页码与页大小都做上下界钳制，避免恶意参数导致全量返回或除零
            const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page') ?? 1) || 1))
            const rawSize = Number(url.searchParams.get('pageSize') ?? 10) || 10
            const pageSize = Math.max(1, Math.min(100, rawSize))

            const all = Object.values(adapter.list('memories') ?? {})
            // 新写入的排前面，便于确认刚记下的内容
            all.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))

            const total = all.length
            const pageCount = Math.max(1, Math.ceil(total / pageSize))
            const from = (page - 1) * pageSize
            const items = all.slice(from, from + pageSize).map((m) => ({
              id: m.id,
              kind: m.kind,
              claim: m.claim,
              why: m.why ?? '',
              verify: m.verify ?? '',
              status: m.status,
              stability: m.stability,
              scope: m.scope ?? [],
              tags: m.tags ?? [],
              createdAt: m.createdAt,
              hits: m.hits ?? 0,
              miss: m.miss ?? 0,
            }))

            sendJson(res, 200, { page, pageSize, total, pageCount, items })
          },
        }),
      'memory-anchor: GET /lwm/list',
    )

    // POST /lwm/toggle —— 开关
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/lwm/toggle',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            let body
            try {
              body = await readBody(req)
            } catch {
              sendJson(res, 400, { error: 'invalid body' })
              return
            }
            if (typeof body?.enabled !== 'boolean') {
              sendJson(res, 400, { error: 'enabled must be a boolean' })
              return
            }
            power.enabled = body.enabled

            // 回写到 profile patch，使重启后仍生效。
            // 编辑失败不算致命：内存里的开关已经生效，只是重启会回到默认值，
            // 因此把失败回报给页面而不是静默吞掉。
            let persisted = false
            try {
              const entry = webCtx.fiber?.entry
              const editor = webCtx.get?.('configEditor')
              if (entry !== undefined && editor !== undefined) {
                await editor.edit(entry, (current) => ({ ...current, enabled: body.enabled }))
                persisted = true
              }
            } catch (error) {
              webCtx.logger?.warn?.(`lwm: 开关未能持久化: ${String(error)}`)
            }

            sendJson(res, 200, { enabled: power.enabled, persisted })
          },
        }),
      'memory-anchor: POST /lwm/toggle',
    )
    // GET /lwm/embedding —— 读取向量配置（key 脱敏）
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/lwm/embedding',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const key = String(config.embeddingApiKey ?? '')
          sendJson(res, 200, {
            provider: config.embeddingProvider ?? '',
            apiUrl: config.embeddingApiUrl ?? '',
            modelName: config.embeddingModelName ?? '',
            dimensions: config.embeddingDimensions ?? 1024,
            // 绝不返回完整 key：只给页面足够回显的信息
            hasApiKey: key.length > 0,
            apiKeyTail: key.length >= 4 ? key.slice(-4) : '',
            providers: listProviders(),
          })
        },
      })
    })
    ctx.logger?.debug?.('memory-anchor: GET /lwm/embedding')

    // POST /lwm/embedding —— 保存向量配置
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/lwm/embedding',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch {
            sendJson(res, 400, { error: 'invalid body' })
            return
          }

          const next = {
            embeddingProvider: String(body?.provider ?? ''),
            embeddingApiUrl: String(body?.apiUrl ?? ''),
            embeddingModelName: String(body?.modelName ?? ''),
            embeddingDimensions: Number(body?.dimensions) || 1024,
          }

          // 空字符串表示不修改，避免页面回显被掩盖后误清空已存的 key
          const incomingKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
          if (incomingKey.length > 0) next.embeddingApiKey = incomingKey

          let persisted = false
          try {
            const entry = webCtx.fiber?.entry
            const editor = webCtx.get?.('configEditor')
            if (entry !== undefined && editor !== undefined) {
              await editor.edit(entry, (current) => ({ ...current, ...next }))
              persisted = true
            }
          } catch (error) {
            webCtx.logger?.warn?.(`lwm: 向量配置未能持久化: ${String(error)}`)
          }

          // 内存中的 config 同步更新，使当前会话立即生效
          Object.assign(config, next)

          sendJson(res, 200, { ok: true, persisted })
        },
      })
    })
    ctx.logger?.debug?.('memory-anchor: POST /lwm/embedding')

    // POST /lwm/embedding/test —— 用给定参数试调一次，验证连通性
    //
    // 之所以要用「传入的参数」而不是已保存的配置：用户填完想先试再存，
    // 强制先保存才能测会让「填错了但点了保存」变成既定事实。
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/lwm/embedding/test',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch {
            sendJson(res, 400, { error: 'invalid body' })
            return
          }

          const apiKey = String(body?.apiKey ?? '').trim() || String(config.embeddingApiKey ?? '')
          const provider = createProvider({
            embeddingProvider: String(body?.provider ?? config.embeddingProvider ?? ''),
            embeddingApiUrl: String(body?.apiUrl ?? config.embeddingApiUrl ?? ''),
            embeddingApiKey: apiKey,
            embeddingModelName: String(body?.modelName ?? config.embeddingModelName ?? ''),
            embeddingDimensions: Number(body?.dimensions) || config.embeddingDimensions || 1024,
            embeddingTimeoutMs: 15000,
          })

          const t0 = Date.now()
          try {
            const r = await provider.embed('测试')
            const dim = unpackStored(r.vector)?.length ?? 0
            sendJson(res, 200, {
              ok: true,
              latencyMs: Date.now() - t0,
              model: r.model,
              dimensions: dim,
            })
          } catch (error) {
            sendJson(res, 200, {
              ok: false,
              latencyMs: Date.now() - t0,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      })
    })
    ctx.logger?.debug?.('memory-anchor: POST /lwm/embedding/test')


    // POST /lwm/delete —— 删除单条记忆
    //
    // 必须通过 domain 句柄删除，不能直接删磁盘文件：
    // storageDomain 在 open() 时把全量记录载入内存并作为权威状态，
    // 直接删文件不会反映到已打开的实例，接口会继续返回已删除的记录。
    // 这一点在实施中真实踩过两次。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/lwm/delete',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            let body
            try {
              body = await readBody(req)
            } catch {
              sendJson(res, 400, { error: 'invalid body' })
              return
            }
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, 400, { error: 'id is required' })
              return
            }
            if (adapter.get('memories', id) === undefined) {
              sendJson(res, 404, { error: 'not found' })
              return
            }
            await adapter.delete('memories', id)
            sendJson(res, 200, { deleted: id })
          },
        }),
      'memory-anchor: POST /lwm/delete',
    )

    // POST /lwm/clear —— 清空全部记忆（保留开关与配置）
    //
    // 逐条删除而不是删目录：同样是为了让 domain 的内存状态与磁盘一致。
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: '/lwm/clear',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            const ids = Object.keys(adapter.list('memories') ?? {})
            for (const id of ids) {
              await adapter.delete('memories', id)
            }
            sendJson(res, 200, { deleted: ids.length })
          },
        }),
      'memory-anchor: POST /lwm/clear',
    )
  })
}

// --------------------------------------------------------------------
// 辅助
// --------------------------------------------------------------------

/**
 * 把 storageDomain 的表句柄适配成 MemoryStore 的接口。
 *
 * storageDomain 的表句柄是 Map 风格（get/set/delete），没有 list。
 * 我们通过全量快照的投影缓存来提供 list —— 在 LWM 的规模
 * （数百~数千条）下，内存投影是完全可接受的，且保证了读同步语义。
 *
 * @param {any} domain
 * @param {any} ctx
 */
function makeAdapter(domain, ctx) {
  /**
   * storageDomain 的表句柄本身就是权威的内存状态：
   * get / entries / keys / size 全部同步，且与持久化层保持一致。
   *
   * 因此这里**不做任何镜像缓存**。
   *
   * 早期版本曾用一份启动时快照的 Map 做投影缓存，结果是：
   * 外部清空磁盘后，stats 仍然报出 7 条已经不存在的记忆——
   * 缓存永不刷新，读者看到的是历史快照而非当前真实状态。
   * 一个不会刷新的缓存，比没有缓存更危险。
   */
  const handle = (t) => domain.table(t)

  return {
    get: (t, k) => {
      try {
        return handle(t).get(k)
      } catch {
        return undefined
      }
    },

    put: async (t, k, v) => {
      // 写入前先按 schema 校验。
      //
      // 为什么必须在这里校验：storageDomain 的 put() 不做校验，只在下次
      // open() 时校验全量记录。若不前置检查，一条不合规记录会安静地写进
      // 磁盘，直到插件下次重载才让整个 domain 打不开——那时报错离原因很远。
      // 这曾在实施中真实发生过：eval_events 的 action 枚举漏了 stats/eval，
      // 写入成功，重载失败，插件整体不可用。
      const schema = lwmDomain.tables[t]?.valueSchema
      if (schema) {
        const parsed = schema.safeParse(v)
        if (!parsed.success) {
          const detail = parsed.error?.issues
            ?.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`)
            .join('; ')
          throw new Error(`lwm: 拒绝写入 ${t}/${k}，记录不符合 schema — ${detail}`)
        }
        v = parsed.data
      }
      await handle(t).put(k, v)
    },

    delete: async (t, k) => {
      try {
        await handle(t).delete(k)
      } catch (error) {
        ctx?.logger?.warn?.(`lwm: 删除 ${t}/${k} 失败: ${String(error)}`)
      }
    },

    /**
     * 全量列出。每次都从句柄实时读取，不使用任何缓存 ——
     * 保证读者看到的永远是当前状态。
     */
    list: (t) => {
      try {
        const h = handle(t)
        if (typeof h.entries === 'function') {
          const out = {}
          for (const [k, v] of h.entries()) out[k] = v
          return out
        }
      } catch (error) {
        ctx?.logger?.warn?.(`lwm: 无法列出表 ${t}: ${String(error)}`)
      }
      return {}
    },

    getGlobal: () => {
      try {
        return domain.global?.get?.()
      } catch {
        return undefined
      }
    },

    setGlobal: async (v) => {
      try {
        await domain.global?.set?.(v)
      } catch (error) {
        ctx?.logger?.warn?.(`lwm: 写全局失败: ${String(error)}`)
      }
    },
  }
}

/**
 * 渲染检索结果。
 *
 * 输出契约（面向模型，非面向人）：
 *   每条 3~5 行，省 token；结尾固定一行提示。
 *
 * @param {Array<any>} hits
 */


/** 从 id 生成稳定 slug。 */
function slugOf(text) {
  const s = String(text)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || `mem-${Date.now().toString(36)}`
}

/** 从工具输出里收集被返回的 memory id，供评测归因。 */
function collectIds(out) {
  if (typeof out !== 'string') return []
  const ids = []
  for (const m of out.matchAll(/^\[\d+\]\s+([\w\u4e00-\u9fa5-]+)/gm)) ids.push(m[1])
  return ids.slice(0, 20)
}

function noop() {}

/**
 * 把工具失败堆栈写入文件，供实施期诊断。
 *
 * 为什么落盘而不是只打日志：DSH 的 logger 输出在桌面端不易抓取，
 * 而工具返回给模型的错误信息被框架截断成一行，看不到调用栈。
 * 写入 profile 的临时目录，内容只包含 action 名与堆栈，不含记忆正文。
 *
 * @param {any} ctx
 * @param {string} action
 * @param {any} error
 */
async function writeDiagnostic(ctx, action, error) {
  const line = `[${new Date().toISOString()}] action=${action}\n${error?.stack ?? String(error)}\n\n`
  ctx.logger?.error?.(`[lwm] ${action} 失败: ${error?.message ?? error}`)
  try {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const file = path.join(os.tmpdir(), 'lwm-diagnostics.log')
    fs.appendFileSync(file, line)
  } catch {
    /* 诊断失败不能影响主流程 */
  }
}
