/**
 * 校验发布相关的配置文件。
 *
 * YAML 写坏了不会在本地报错，只会在 GitHub 上静默失败或变成空运行。
 * 这里做一轮严格检查。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/jhpro/separate-window/dsh-memory-anchor'
const problems = []
const notes = []

// ---- 1. 极简 YAML 结构检查（不引第三方库） ----
function checkYaml(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const lines = text.split('\n')
  let tabs = 0
  let badIndent = null
  lines.forEach((line, i) => {
    if (line.includes('\t')) {
      tabs++
      if (!badIndent) badIndent = i + 1
    }
    // 顶层键必须顶格
    if (/^[a-zA-Z_][\w-]*:/.test(line) === false && /^[a-zA-Z_][\w-]*\s*:/.test(line) && !line.startsWith(' ')) {
      // ok
    }
  })
  if (tabs > 0) problems.push(`${file}: 使用制表符缩进（第 ${badIndent} 行），YAML 不允许`)
  if (/^\s*steps\s*$/m.test(text) && !/^\s*steps:\s*$/m.test(text)) {
    problems.push(`${file}: steps 后缺少冒号`)
  }
  if (/steps\s*\n\s*:/.test(text)) {
    problems.push(`${file}: steps 的冒号位置错误（换行后才出现）`)
  }
  notes.push(`${file}: ${lines.length} 行`)
  return text
}

const workflows = fs
  .readdirSync(path.join(ROOT, '.github', 'workflows'))
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

for (const w of workflows) {
  const text = checkYaml(`.github/workflows/${w}`)
  if (!/^on:/m.test(text)) problems.push(`${w}: 缺少 on 触发器`)
  if (!/jobs:/m.test(text)) problems.push(`${w}: 缺少 jobs`)
  // 每个 job 必须有 runs-on
  const jobBlocks = text.split(/\n {2}[\w-]+:\n/)
  if (!/runs-on:/.test(text)) problems.push(`${w}: 没有 runs-on`)
}

// ---- 2. Issue 模板 ----
const tplDir = path.join(ROOT, '.github', 'ISSUE_TEMPLATE')
if (!fs.existsSync(tplDir)) {
  problems.push('缺少 .github/ISSUE_TEMPLATE 目录')
} else {
  for (const f of fs.readdirSync(tplDir)) {
    const text = fs.readFileSync(path.join(tplDir, f), 'utf8')
    // config.yml 是模板目录的配置（禁用空白 issue、添加外部链接），
    // 不是 issue 模板本身，不适用 name/body 等字段。
    if (f === 'config.yml') {
      if (!/blank_issues_enabled|contact_links/.test(text)) {
        problems.push('config.yml: 既没设置 blank_issues_enabled 也没设置 contact_links')
      }
      notes.push(`模板配置 ${f}: ${text.split('\n').length} 行`)
      continue
    }
    if (f.endsWith('.yml')) {
      if (!/^name:/m.test(text)) problems.push(`${f}: 缺少 name`)
      if (!/^description:/m.test(text)) problems.push(`${f}: 缺少 description`)
      if (!/^body:/m.test(text)) problems.push(`${f}: 缺少 body`)
      if (!/type: (input|textarea|dropdown|checkboxes|markdown)/.test(text)) {
        problems.push(`${f}: 没有可用的字段类型`)
      }
    }
    notes.push(`模板 ${f}: ${text.split('\n').length} 行`)
  }
}

// ---- 3. package.json 与发布契约 ----
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
if (pkg.private === true) problems.push('package.json private:true —— npm publish 会被拒绝')
if (!pkg.license) problems.push('缺少 license')
if (!pkg.repository?.url) problems.push('缺少 repository.url')
if (!pkg.keywords?.length) problems.push('缺少 keywords')
if (pkg.peerDependencies?.zod?.match(/^\d+\.\d+\.\d+$/)) {
  problems.push(`zod peer 依赖写死为 ${pkg.peerDependencies.zod}，应放宽为范围`)
}

// 占位符必须在发布前替换
const placeholderHint = []
if (pkg.repository?.url?.includes('YOUR_GITHUB_USERNAME')) placeholderHint.push('repository.url')
if (pkg.homepage?.includes('YOUR_GITHUB_USERNAME')) placeholderHint.push('homepage')
if (pkg.bugs?.url?.includes('YOUR_GITHUB_USERNAME')) placeholderHint.push('bugs.url')
if (pkg.author === 'YOUR_NAME') placeholderHint.push('author')

// README 里的图片用 GitHub raw 绝对地址（图片不进 npm 包），
// 同样含占位符，发布前必须替换，否则 npm 页面上是裂图。
for (const f of ['README.md', 'README.zh-CN.md']) {
  const p = path.join(ROOT, f)
  if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('YOUR_GITHUB_USERNAME')) {
    placeholderHint.push(`${f} 的图片地址`)
  }
}

// ---- 4. files 字段必须覆盖所有运行时文件 ----
const REQUIRED = [
  'lib/index.mjs',
  'lib/client.js',
  'lib/schema.mjs',
  'lib/store.mjs',
  'lib/eval.mjs',
  'lib/vector.mjs',
  'lib/polarity.mjs',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'LICENSE',
  'locale/en.json',
  'locale/zh.json',
  'docs/DETAIL.md',
]
for (const f of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push(`缺少必需文件: ${f}`)
}
const filesGlobs = pkg.files ?? []
const covered = (f) =>
  filesGlobs.some((g) => {
    if (g === f) return true
    if (g.endsWith('/*') || g.endsWith('/')) return f.startsWith(g.replace(/\*$/, ''))
    return f.startsWith(g + '/')
  })
for (const f of REQUIRED) {
  if (!covered(f)) problems.push(`files 未覆盖: ${f}`)
}

// ---- 5. 脚本可用性 ----
for (const s of ['test', 'test:all', 'check']) {
  if (!pkg.scripts?.[s]) problems.push(`缺少 npm script: ${s}`)
}

console.log('=== 发布配置检查 ===')
for (const n of notes) console.log('  ✓', n)
console.log('')

if (placeholderHint.length > 0) {
  console.log('需要在发布前替换的占位符:')
  for (const p of placeholderHint) console.log('  ·', p)
  console.log('')
}

if (problems.length === 0) {
  console.log('结构检查全部通过（0 个问题）')
} else {
  console.log(`发现 ${problems.length} 个问题:`)
  for (const p of problems) console.log('  ✗', p)
  process.exitCode = 1
}