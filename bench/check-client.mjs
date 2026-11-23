/**
 * Client bundle 静态校验。
 *
 * 无法从命令行打开已认证的页面，因此这里检查 bundle 是否符合
 * DSH 客户端加载器的契约——这类错误只会在浏览器里炸，
 * 必须在安装前用静态手段拦住。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// 从脚本位置推导仓库根，避免硬编码路径（改目录名后无需再改这里）
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const src = fs.readFileSync(`${ROOT}/lib/client.js`, 'utf8')
const problems = []
const notes = []

// ---- 1. 语法 ----
try {
  new vm.Script(src, { filename: 'client.js' })
  notes.push('语法检查通过')
} catch (e) {
  problems.push(`语法错误: ${e.message}`)
}

// ---- 2. 模块格式 ----
if (!src.includes('__ModuleLoader__')) problems.push('未调用 __ModuleLoader__.load')
if (!/load\(\{\s*id:\s*ID/.test(src)) problems.push('load() 的 id 未使用 ID 常量')
if (!/factory:\s*createPlugin/.test(src)) problems.push('load() 未提供 factory')

// ---- 3. 包名一致性 ----
const pkg = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, 'utf8'))
const idMatch = src.match(/const ID = ['"]([^'"]+)['"]/)
if (!idMatch) problems.push('缺少 ID 常量')
else if (idMatch[1] !== pkg.name) problems.push(`ID "${idMatch[1]}" 与包名 "${pkg.name}" 不一致`)
else notes.push(`模块 id 与包名一致: ${idMatch[1]}`)

// ---- 4. 导出声明 ----
if (pkg.exports?.['./client'] !== './lib/client.js') problems.push('exports["./client"] 未指向 lib/client.js')
if (pkg.dsh?.client === undefined) problems.push('缺少 dsh.client 声明')
else notes.push(`dsh.client: ${JSON.stringify(pkg.dsh.client)}`)

// ---- 5. 禁止依赖 Harness 私有 UI 包 ----
for (const f of ['dsh-client-ui-primitives', 'dsh-client-ui-chat', 'dsh-client-ui-settings']) {
  if (new RegExp(`require\\(["']@deepseek-ai/${f}["']\\)`).test(src)) {
    problems.push(`禁止直接 require @deepseek-ai/${f}`)
  }
}

// ---- 6. 槽位注册 ----
if (!src.includes('ctx.slots.inject') || !src.includes('ctx.slots.register')) {
  problems.push('未通过 ctx.slots.inject/register 注册')
}
if (!src.includes('settings.section')) problems.push('未注册到 settings.section 槽位')
if (/document\.body\.appendChild|document\.body\.innerHTML/.test(src)) {
  problems.push('向 document.body 写入：禁止')
}

// ---- 7. 关键：组件必须在 register 之前就定义（本次踩的坑）----
//
// register(options, Component) 在调用那一刻就捕获组件。
// 若组件用外层 let 持有、在 apply 末尾才赋值，register 拿到的是 null，
// 槽位静默不渲染 —— 设置页看不到分类，且没有任何报错。
//
// 注意：检查必须剥离注释，否则文档里描述这个坑的文字本身会被当成代码。
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
  .replace(/^\s*\/\/.*$/gm, '') // 行注释
  .replace(/([^:])\/\/.*$/gm, '$1') // 行尾注释

if (/let\s+Section\s*=\s*null/.test(code)) {
  problems.push('检测到 `let Section = null` 模式：register 会在赋值前捕获 null，槽位不会渲染')
}

const createIdx = code.indexOf('function createPlugin')
const applyIdx = code.indexOf('function apply(ctx)')
if (applyIdx > 0 && createIdx > 0 && applyIdx < createIdx) {
  problems.push('apply 定义在 createPlugin 之外，无法引用 factory 内的组件')
}

// register 传参必须是已定义的标识符。
// 用括号配对解析而不是正则匹配对象文本 —— options 对象可跨多行、
// 内部还可能含花括号，正则很容易漏。
const regComponents = []
{
  const needle = 'ctx.slots.register('
  let from = 0
  while (true) {
    const at = code.indexOf(needle, from)
    if (at < 0) break
    from = at + needle.length
    // 从 ( 之后开始，按括号层级找顶层逗号
    let depth = 0
    let i = from
    let commaAt = -1
    for (; i < code.length; i++) {
      const c = code[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break // 到达 register 的右括号
        depth--
      } else if (c === ',' && depth === 0 && commaAt < 0) commaAt = i
    }
    if (commaAt > 0) {
      // 去掉尾随的换行与逗号（`Section,\n)` 这种 trailing comma）
      const second = code
        .slice(commaAt + 1, i)
        .replace(/,\s*$/, '')
        .trim()
      regComponents.push(second)
    }
  }
}
if (regComponents.length === 0) {
  problems.push('未找到形如 ctx.slots.register(options, Component) 的调用')
} else {
  for (const comp of regComponents) {
    if (!/^[A-Za-z_$][\w$]*$/.test(comp)) {
      problems.push(`register 的第二个参数不是简单标识符: "${comp.slice(0, 40)}"`)
    } else if (!new RegExp(`function\\s+${comp}\\s*\\(`).test(code)) {
      problems.push(`register 传入的 ${comp} 不是 createPlugin 内的函数声明`)
    }
  }
  notes.push(`槽位注册 ${regComponents.length} 处：${regComponents.join(', ')}`)
}

// ---- 8. 组件不得依赖模块层的 ctx ----
const sectionStart = code.indexOf('function Section(')
const sectionEnd = code.indexOf('function SectionIcon(')
const sectionBody = sectionStart >= 0 ? code.slice(sectionStart, sectionEnd > sectionStart ? sectionEnd : undefined) : ''
if (/\bctx\.locale\.bind/.test(sectionBody)) {
  problems.push('Section 组件内直接用了 ctx.locale.bind：应改用 props.t（框架按 locale 注入）')
}
if (sectionBody && !/props\.t/.test(sectionBody)) {
  problems.push('Section 组件未从 props 取 t：界面文本无法本地化')
}

// ---- 9. 主题令牌：颜色必须有令牌兜底 ----
const cssBlock = src.match(/const CSS = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
const hardcoded = cssBlock.match(/#[0-9a-fA-F]{3,6}/g) ?? []
const bare = hardcoded.filter((c) => {
  const idx = cssBlock.indexOf(c)
  return !cssBlock.slice(Math.max(0, idx - 70), idx).includes('var(--dsw-alias-')
})
if (bare.length > 0) problems.push(`存在未走主题令牌的裸颜色: ${[...new Set(bare)].join(', ')}`)
else notes.push(`主题令牌 ${(cssBlock.match(/var\(--dsw-alias-/g) ?? []).length} 处，颜色均有令牌兜底`)

// ---- 10. 可访问性 ----
if (!src.includes("role: 'switch'")) problems.push('开关缺少 role="switch"')
if (!src.includes("'aria-checked'")) problems.push('开关缺少 aria-checked')

// ---- 11. 核心功能 ----
if (!src.includes('PAGE_SIZE = 10')) problems.push('每页条数不是 10')
if (!src.includes('/lwm/list')) problems.push('未调用分页接口')
if (!src.includes('/lwm/toggle')) problems.push('未调用开关接口')
if ((src.match(/ctx\.effect\(/g) ?? []).length < 2) problems.push('至少应有 locale 与样式两个 effect 清理')

// ---- 12. 状态覆盖 ----
for (const key of ['empty', 'failed', 'loading']) {
  if (!src.includes(`${key}:`)) problems.push(`缺少${key}文案`)
}

console.log('=== 静态校验结果 ===')
for (const n of notes) console.log('  ✓', n)
if (problems.length === 0) {
  console.log('\n全部检查通过（0 个问题）')
} else {
  console.log(`\n发现 ${problems.length} 个问题:`)
  for (const p of problems) console.log('  ✗', p)
  process.exitCode = 1
}