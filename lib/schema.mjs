/**
 * LWM 数据模型 —— zod schema 定义与领域声明。
 *
 * ## 为什么用 DSH 的 storageDomain
 *
 * `practices.md` 要求「不要把插件数据塞进 session 事件流」，并指明
 * 「keep plugin-owned data in a storage service found through inspection」。
 * `dsh-storage-domain` 提供的 `defineDomain` 正好满足：
 *   - schema 校验：存储损坏会在 open 时立刻失败，而不是在检索时静默出错
 *   - 写入即持久：每次 put/update 落盘后才返回
 *   - 变更事件：`domain/changed` 可用于跨面板同步
 *   - 单文件布局：`single` layout 产生可读 JSON，可进 git review
 *
 * 代价是它用 zod（不是 schemastery）。插件 Config 仍用 schemastery，
 * 两套 schema 库并存是 DSH 的现状，不是我们的选择。
 *
 * @module lwm/schema
 */

import { z } from 'zod'

/**
 * 记忆类型。`rejected` 是性价比最高的一类：
 * 「我们试过 A、因为 B 放弃了」直接避免重开已关闭的争论。
 */
export const KIND = /** @type {const} */ (['decision', 'constraint', 'gotcha', 'rejected'])

/** 生命周期状态。`retired` 不删除、默认不检索，但可被 --all 看到。 */
export const STATUS = /** @type {const} */ (['active', 'stale', 'retired', 'superseded'])

/**
 * 稳定性。这是「决策冲突」问题的通用解：
 * 来不及确认就显式建模成一种状态，而不是让 created_at 冒充结论。
 *   - settled     ：已确认的结论，正常参与检索
 *   - provisional ：未确认（可能是笔误、可能是试探），检索时标 ⚠
 */
export const STABILITY = /** @type {const} */ (['settled', 'provisional'])

/** 单条记忆记录。 */
export const MemorySchema = z.object({
  /** 稳定 slug，如 surf-fail-latch */
  id: z.string().min(1).max(120),
  kind: z.enum(KIND),
  /** 一条断言，必须单句、可判断真假 */
  claim: z.string().min(1).max(500),
  /** 理由：谁定的、依据什么 */
  why: z.string().max(2000).default(''),
  /** 路径 glob 列表。空数组 = 全局 */
  scope: z.array(z.string()).default([]),
  /** 可执行的一句话验证方式 */
  verify: z.string().max(500).default(''),
  tags: z.array(z.string()).default([]),
  status: z.enum(STATUS).default('active'),
  stability: z.enum(STABILITY).default('settled'),
  /** 版本链：被本条取代的 id（取代语义，非时间排序） */
  supersedes: z.string().nullable().default(null),
  /** 同一条决策的版本号，用于链式演化 */
  revision: z.number().int().min(1).default(1),
  /** 向量：base64 编码的 int8，见 vector.mjs encodeForStorage */
  embedding: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 最近一次验证通过时间；null = 从未验证 */
  lastVerified: z.string().nullable().default(null),
  /** 被检索且被采纳次数 */
  hits: z.number().int().min(0).default(0),
  /** 被检索但未采纳 / 采纳后失效次数 */
  miss: z.number().int().min(0).default(0),
  /** 出处：session id / 人工 */
  source: z.string().max(200).default(''),
})

/** 评测事件（append-only，永不修改）。 */
export const EvalEventSchema = z.object({
  seq: z.number().int().min(0),
  session: z.string(),
  at: z.string(),
  /**
   * 埋点覆盖的 action。
   *
   * 这个枚举必须与 index.mjs 里所有走 traced() 的 action 完全一致。
   * 曾经漏掉 stats/eval —— 那两个 action 也写了事件，但枚举里没有，
   * 于是下次插件重载时 domain 校验失败，整个插件打不开。
   * 教训：埋点枚举与工具 action 列表是同一份契约，改一处必须改两处。
   */
  action: z.enum([
    'find',
    'add',
    'verify',
    'use',
    'miss',
    'resolve',
    'gc',
    'triage',
    'stats',
    'eval',
  ]),
  /** 参数与结果摘要。只存摘要，绝不存自由文本原文 */
  payload: z.string().max(4000).default('{}'),
  /** 相对路径，不存绝对路径 */
  cwd: z.string().max(500).default(''),
  /** 是否成功。失败事件是 F1/F2 判定的重要输入 */
  ok: z.boolean().default(true),
  /** 本次调用返回的 memory id 列表（JSON 字符串），用于事后归因 */
  returned: z.string().max(2000).default('[]'),
})

/** 失败事件（从 eval_events 派生，可重建）。 */
export const FailureSchema = z.object({
  id: z.string(),
  /** F1..F7，见设计文档 C.2 */
  type: z.enum(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']),
  detectedAt: z.string(),
  session: z.string().default(''),
  /** 涉及的 memory id（可空） */
  subject: z.string().default(''),
  /** 触发时的原始查询 */
  query: z.string().default(''),
  /** 判定依据：哪个信号触发的 */
  evidence: z.string().max(2000).default('{}'),
  severity: z.enum(['low', 'normal', 'high']).default('normal'),
  status: z.enum(['open', 'triaged', 'fixed', 'wontfix']).default('open'),
  rootCause: z.string().default(''),
  fixRef: z.string().default(''),
})

/** 改进项：失败 → 具体可执行的改动。 */
export const ActionSchema = z.object({
  id: z.string(),
  failureId: z.string(),
  kind: z.enum(['add_memory', 'fix_scope', 'fix_verify', 'tune_score', 'tighten_gate', 'doc']),
  detail: z.string().max(2000),
  appliedAt: z.string().nullable().default(null),
  /** 事后回检：建议是否真的消除了该类失败 */
  outcome: z.enum(['pending', 'effective', 'ineffective']).default('pending'),
})

/** 全局状态：库级配置与统计基线。 */
export const GlobalSchema = z.object({
  /** schema 版本，用于未来迁移 */
  formatVersion: z.number().int().default(1),
  /** 事件序号自增游标 */
  nextSeq: z.number().int().default(1),
  createdAt: z.string(),
})

/**
 * LWM 领域声明。
 *
 * `layout: 'per-record'`：每条记忆一个文件，便于 git diff 与人工 review。
 * 记忆条目数量级在数百到数千，单文件读写成本可接受，而可读性收益更大。
 *
 * ## 表名约束（踩过的坑）
 *
 * DSH storage 的单元与表名必须匹配 /^[a-z][a-z0-9_]*$/：
 * 小写字母开头，只允许小写字母、数字和下划线。驼峰（如 evalEvents）
 * 会在 storageDomain.open() 时抛 `invalid table name`，而那时插件
 * 已经加载，报错现场离原因很远。因此这里先自检。
 */
export const lwmDomain = {
  name: 'memory_anchor',
  version: 1,
  layout: /** @type {const} */ ('per-record'),
  tables: {
    memories: { valueSchema: MemorySchema },
    eval_events: { valueSchema: EvalEventSchema },
    failures: { valueSchema: FailureSchema },
    actions: { valueSchema: ActionSchema },
  },
  global: { schema: GlobalSchema },
}

// 模块加载时自检表名，把错误暴露在最靠近定义的地方
const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/
for (const tableName of Object.keys(lwmDomain.tables)) {
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error(
      `memory-anchor: 表名 '${tableName}' 不合规，必须匹配 /^[a-z][a-z0-9_]*$/ ` +
        '（小写开头，只含小写字母/数字/下划线）',
    )
  }
}