import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HASH_MODEL,
  remoteModelId,
  hashProvider,
  createRemoteProvider,
  createProvider,
  embedWithFallback,
  comparable,
  similarity,
  unpackStored,
} from '../lib/embedding.mjs'

/** 造一个假的 1024 维单位向量。 */
function fakeVector(seed, dim = 1024) {
  const v = new Array(dim)
  let sum = 0
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1))
    sum += v[i] * v[i]
  }
  const n = Math.sqrt(sum)
  return v.map((x) => x / n)
}

/** 把 fetch 替换掉，测试完恢复。 */
function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original
    })
}

// ---------------- 模型标识 ----------------

test('remoteModelId 把维度写进标识', () => {
  assert.equal(remoteModelId(1024), 'remote-1024')
  assert.equal(remoteModelId(2048), 'remote-2048')
})

test('不同维度产生不同模型标识——否则 1024 与 2048 向量会被混比', () => {
  assert.notEqual(remoteModelId(1024), remoteModelId(2048))
})

// ---------------- 哈希兜底 ----------------

test('hashProvider 永远可用', async () => {
  assert.equal(await hashProvider.ready(), true)
  const r = await hashProvider.embed('提交前必须跑单测')
  assert.equal(r.model, HASH_MODEL)
  assert.ok(r.vector.length > 0)
})

// ---------------- 远程解析 ----------------

test('远程 provider 解析 OpenAI 风格响应', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', apiKey: 'k', dimensions: 1024 })
  await withFetch(
    async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: fakeVector(1) }] }),
    }),
    async () => {
      const r = await p.embed('测试')
      assert.equal(r.model, 'remote-1024')
      assert.ok(r.vector.startsWith('i8:'))
    },
  )
})

test('远程 provider 兼容 embeddings 数组响应', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({
      ok: true,
      json: async () => ({ embeddings: [fakeVector(2)] }),
    }),
    async () => {
      const r = await p.embed('测试')
      assert.ok(r.vector.startsWith('i8:'))
    },
  )
})

test('远程 provider 把 dimensions 传给 API', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 2048 })
  let sent = null
  await withFetch(
    async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, json: async () => ({ data: [{ embedding: fakeVector(3, 2048) }] }) }
    },
    async () => {
      await p.embed('测试')
    },
  )
  assert.equal(sent.dimensions, 2048)
})

test('远程 provider 带 Authorization 头', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', apiKey: 'secret-key', dimensions: 1024 })
  let headers = null
  await withFetch(
    async (_url, init) => {
      headers = init.headers
      return { ok: true, json: async () => ({ data: [{ embedding: fakeVector(4) }] }) }
    },
    async () => {
      await p.embed('测试')
    },
  )
  assert.equal(headers.authorization, 'Bearer secret-key')
})

test('远程 provider 在 HTTP 错误时抛出', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
    async () => {
      await assert.rejects(() => p.embed('测试'), /401/)
    },
  )
})

test('远程 provider 在向量数量不匹配时抛出', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({ ok: true, json: async () => ({ data: [] }) }),
    async () => {
      await assert.rejects(() => p.embed('测试'), /no vector|no data|0 vectors/)
    },
  )
})

test('远程 provider 在响应缺字段时抛出', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({ ok: true, json: async () => ({ nothing: true }) }),
    async () => {
      await assert.rejects(() => p.embed('测试'), /no data/)
    },
  )
})

test('远程 provider 批量嵌入', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: fakeVector(5) }, { embedding: fakeVector(6) }] }),
    }),
    async () => {
      const r = await p.embedBatch(['a', 'b'])
      assert.equal(r.vectors.length, 2)
    },
  )
})

// ---------------- 降级 ----------------

test('未配置 URL 时 createProvider 返回 hash', () => {
  assert.equal(createProvider({}).id, HASH_MODEL)
  assert.equal(createProvider({ embeddingApiUrl: '' }).id, HASH_MODEL)
})

test('配置 URL 后 createProvider 返回远程 provider', () => {
  const p = createProvider({ embeddingApiUrl: 'http://x/e', embeddingDimensions: 1024 })
  assert.equal(p.id, 'remote-1024')
})

test('API 失败时降级为哈希，且标记 degraded', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => {
      throw new Error('network down')
    },
    async () => {
      const r = await embedWithFallback(p, '提交前必须跑单测')
      assert.equal(r.degraded, true)
      assert.equal(r.model, HASH_MODEL)
      assert.match(r.error, /network down/)
      assert.ok(r.vector.length > 0, '降级后仍要有向量，记忆不能丢')
    },
  )
})

test('API 正常时不降级', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({ ok: true, json: async () => ({ data: [{ embedding: fakeVector(7) }] }) }),
    async () => {
      const r = await embedWithFallback(p, '测试')
      assert.equal(r.degraded, false)
      assert.equal(r.model, 'remote-1024')
    },
  )
})

// ---------------- 分桶 ----------------

test('同模型才可比', () => {
  assert.equal(comparable('remote-1024', 'remote-1024'), true)
  assert.equal(comparable(HASH_MODEL, HASH_MODEL), true)
  assert.equal(comparable('remote-1024', HASH_MODEL), false)
  assert.equal(comparable('remote-1024', 'remote-2048'), false)
})

test('缺省 model 视为 hash', () => {
  assert.equal(comparable(undefined, HASH_MODEL), true)
})

test('跨模型比较返回 null 而不是 0', async () => {
  const a = await hashProvider.embed('提交前必须跑单测')
  const b = await hashProvider.embed('日志必须脱敏')
  // 同模型：应得到数字
  const same = similarity(a.vector, b.vector, HASH_MODEL, HASH_MODEL)
  assert.equal(typeof same, 'number')
  // 跨模型：必须是 null，0 会被误当"不相关"
  const cross = similarity(a.vector, b.vector, HASH_MODEL, 'remote-1024')
  assert.equal(cross, null)
})

test('unpackStored 兼容两种前缀', async () => {
  const h = await hashProvider.embed('测试文本')
  const fromHash = unpackStored(h.vector)
  assert.ok(fromHash && fromHash.length > 0)

  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({ ok: true, json: async () => ({ data: [{ embedding: fakeVector(8) }] }) }),
    async () => {
      const r = await p.embed('测试文本')
      const fromRemote = unpackStored(r.vector)
      assert.equal(fromRemote.length, 1024)
    },
  )
})

test('unpackStored 对坏输入返回 null', () => {
  assert.equal(unpackStored(''), null)
  assert.equal(unpackStored(null), null)
  assert.equal(unpackStored(123), null)
})

test('远程向量自身的相似度为 1', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 1024 })
  await withFetch(
    async () => ({ ok: true, json: async () => ({ data: [{ embedding: fakeVector(9) }] }) }),
    async () => {
      const r = await p.embed('测试')
      const s = similarity(r.vector, r.vector, 'remote-1024', 'remote-1024')
      assert.ok(Math.abs(s - 1) < 0.02, `自相似应接近 1，实际 ${s}`)
    },
  )
})

test('2048 维向量不被截断', async () => {
  const p = createRemoteProvider({ url: 'http://x/e', dimensions: 2048 })
  await withFetch(
    async () => ({ ok: true, json: async () => ({ data: [{ embedding: fakeVector(10, 2048) }] }) }),
    async () => {
      const r = await p.embed('测试')
      assert.equal(unpackStored(r.vector).length, 2048)
    },
  )
})