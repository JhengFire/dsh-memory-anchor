/**
 * 跨平台跑全部测试。
 *
 * 为什么需要这个脚本：core/store/eval 三个套件用普通 node 就能跑，
 * 但 plugin/ui 两个套件需要读取 DSH 安装目录里的 zod —— 它在 app.asar 内，
 * 只有 Electron 运行时（ELECTRON_RUN_AS_NODE=1）才能读。直接用
 * `node --test test/` 会在这两个套件上失败。
 *
 * 本脚本依次跑五个套件，任一失败即返回非零。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 普通 Node 可跑的套件 */
const PLAIN = [
  ['core', 'test/core.test.mjs'],
  ['store', 'test/store.test.mjs'],
  ['eval', 'test/eval.test.mjs'],
  ['report', 'test/report.test.mjs'],
  ['scope', 'test/scope.test.mjs'],
  ['embedding', 'test/embedding.test.mjs'],
  ['volcengine', 'test/volcengine.test.mjs'],
]

/** 需要 Electron 运行时的套件（要读 app.asar 内的 zod） */
const ELECTRON = [
  ['plugin', 'test/plugin.test.mjs'],
  ['ui', 'test/ui.test.mjs'],
]

/**
 * 找到可用的 Electron 可执行文件。
 * 优先环境变量，其次常见安装位置。
 * @returns {string|null}
 */
function findElectron() {
  const candidates = [
    process.env.DSH_NODE_EXECUTABLE,
    'C:/Users/AK-FMSB-0186/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe',
  ].filter(Boolean)
  for (const c of candidates) if (c && existsSync(c)) return c
  return null
}

let failed = 0
const results = []

function run(label, file, electronPath) {
  const args = ['--test-reporter=spec', file]
  const env = { ...process.env }
  let cmd
  let cmdArgs
  if (electronPath) {
    cmd = electronPath
    cmdArgs = args
    env.ELECTRON_RUN_AS_NODE = '1'
    if (process.env.DSH_INSTALL_DIR) env.DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR
  } else {
    cmd = process.execPath
    cmdArgs = args
  }
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, env, encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const pass = /ℹ pass (\d+)/.exec(out)?.[1] ?? '?'
  const fail = /ℹ fail (\d+)/.exec(out)?.[1] ?? '?'
  const ok = r.status === 0
  if (!ok) failed++
  results.push({ label, ok, pass, fail })
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(8)} pass ${pass}  fail ${fail}`)
  if (!ok) console.log(out.split('\n').slice(-25).join('\n'))
}

for (const [label, file] of PLAIN) run(label, file, null)

const electron = findElectron()
if (electron === null) {
  console.log('\n⚠ 未找到 DSH 的 Electron 可执行文件，跳过 plugin / ui 两个套件。')
  console.log('  设置环境变量 DSH_NODE_EXECUTABLE 指向它即可运行完整测试。')
  console.log('  （这两个套件需要读取 DSH 安装目录内 app.asar 里的 zod）')
} else {
  for (const [label, file] of ELECTRON) run(label, file, electron)
}

console.log('')
if (failed === 0) {
  console.log(`全部通过（${results.length} 个套件）`)
} else {
  console.log(`${failed} 个套件失败`)
  process.exitCode = 1
}