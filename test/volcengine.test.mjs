import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_DIMENSIONS,
  preset,
  normalizeUrl,
  isMultimodalUrl,
  buildInput,
  extractVectors,
} from '../lib/providers/volcengine.mjs'

test('preset 给出火山默认值', () => {
  const p = preset()
  assert.equal(p.baseUrl, DEFAULT_BASE_URL)
  assert.equal(p.model, DEFAULT_MODEL)
  assert.equal(p.dimensions, DEFAULT_DIMENSIONS)
  assert.match(p.url, /\/api\/v3\/embeddings\/multimodal$/)
})

test('默认模型是用户实际验证过的那一个', () => {
  assert.equal(DEFAULT_MODEL, 'doubao-embedding-vision-251215')
})

test('normalizeUrl: baseUrl 补全到多模态端点', () => {
  assert.equal(
    normalizeUrl('https://ark.cn-beijing.volces.com/api/v3'),
    'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
  )
})

test('normalizeUrl: 尾斜杠被忽略', () => {
  assert.equal(
    normalizeUrl('https://ark.cn-beijing.volces.com/api/v3/'),
    'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
  )
  assert.equal(
    normalizeUrl('https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal/'),
    'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
  )
})

test('normalizeUrl: 已是完整端点则不动', () => {
  const full = 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal'
  assert.equal(normalizeUrl(full), full)
  const text = 'https://ark.cn-beijing.volces.com/api/v3/embeddings'
  assert.equal(normalizeUrl(text), text)
})

test('normalizeUrl: 只有主机时补 api/v3', () => {
  assert.equal(
    normalizeUrl('https://ark.cn-beijing.volces.com'),
    'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
  )
})

test('normalizeUrl: 空值返回空串', () => {
  assert.equal(normalizeUrl(''), '')
  assert.equal(normalizeUrl(undefined), '')
  assert.equal(normalizeUrl('   '), '')
})

test('normalizeUrl: 自定义网关路径', () => {
  assert.equal(normalizeUrl('https://proxy.example.com/ark'), 'https://proxy.example.com/ark/embeddings/multimodal')
})

test('isMultimodalUrl 正确识别', () => {
  assert.equal(isMultimodalUrl('https://x/api/v3/embeddings/multimodal'), true)
  assert.equal(isMultimodalUrl('https://x/api/v3/embeddings'), false)
})

test('buildInput: 多模态端点包成 type/text 对象', () => {
  const url = 'https://x/api/v3/embeddings/multimodal'
  const out = buildInput(['天很蓝，海很深'], url)
  assert.deepEqual(out, [{ type: 'text', text: '天很蓝，海很深' }])
})

test('buildInput: 多模态端点多条文本', () => {
  const url = 'https://x/api/v3/embeddings/multimodal'
  const out = buildInput(['a', 'b'], url)
  assert.deepEqual(out, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ])
})

test('buildInput: 纯文本端点给字符串', () => {
  const url = 'https://x/api/v3/embeddings'
  assert.equal(buildInput(['abc'], url), 'abc')
  assert.deepEqual(buildInput(['a', 'b'], url), ['a', 'b'])
})

test('extractVectors: OpenAI/Ark 的 data 形状', () => {
  assert.deepEqual(extractVectors({ data: [{ embedding: [1, 2, 3] }] }), [[1, 2, 3]])
})

test('extractVectors: embeddings 数组形状', () => {
  assert.deepEqual(extractVectors({ embeddings: [[4, 5]] }), [[4, 5]])
})

test('extractVectors: 一维 embeddings 包成单条', () => {
  assert.deepEqual(extractVectors({ embeddings: [1, 2, 3] }), [[1, 2, 3]])
})

test('extractVectors: 顶层 embedding 字段', () => {
  assert.deepEqual(extractVectors({ embedding: [7, 8] }), [[7, 8]])
})

test('extractVectors: 无法识别时返回 null', () => {
  assert.equal(extractVectors({}), null)
  assert.equal(extractVectors(null), null)
  assert.equal(extractVectors({ data: 'nope' }), null)
})
test('extractVectors: 火山多模态的 data 是对象不是数组', () => {
  // 实测响应（2026-11-23）：
  // { data: { embedding: [...2048], object: 'embedding' }, model, usage }
  const payload = {
    created: 1795416247,
    data: { embedding: [0.1, 0.2, 0.3], object: 'embedding' },
    id: 'x',
    model: 'doubao-embedding-vision-251215',
    object: 'list',
  }
  assert.deepEqual(extractVectors(payload), [[0.1, 0.2, 0.3]])
})

test('extractVectors: 空的 data 数组返回 null', () => {
  assert.equal(extractVectors({ data: [] }), null)
})
