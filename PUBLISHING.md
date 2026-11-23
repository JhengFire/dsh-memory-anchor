# 发布步骤

这份文件是**给你自己看的操作清单**，不进 npm 包（未列入 `files`），发布完成后可以删除。

- 包名：`dsh-memory-anchor`
- npm 账号：`jiahengfire`
- GitHub：`https://github.com/JhengFire/dsh-memory-anchor`

---

## 一、占位符：已完成

`package.json`、两份 README、`CHANGELOG.md`、`CONTRIBUTING.md`、issue 模板里的占位符
已全部替换为 `JhengFire`。CI 会检查 `repository.url`，改动过的话记得保持真实。

`scripts/check-publish.mjs` 与 `.github/workflows/ci.yml` 里仍然出现 `YOUR_GITHUB_USERNAME`
字样，那是**检查逻辑本身要匹配的字符串**，不是遗漏。

---

## 二、npm registry 必须切到官方源

**这是你第一次发布时卡住的原因。**

本机默认 registry 是 `https://registry.npmmirror.com`（淘宝镜像）。
镜像站只提供安装加速，**不能发布**，所以会报 `ENEEDAUTH`。

先确认官方源的登录状态：

```bash
npm whoami --registry=https://registry.npmjs.org
```

应该输出 `jiahengfire`。

发布时二选一：

```bash
# 方式 A：只在这一次用官方源（推荐，不改变全局配置）
npm publish --registry=https://registry.npmjs.org

# 方式 B：临时切换全局源，发布完切回镜像
npm config set registry https://registry.npmjs.org
npm publish
npm config set registry https://registry.npmmirror.com
```

**不要**直接把全局源永久改成官方源——那会让你之后所有安装都变慢。

---

## 三、本地验证

```bash
cd /d D:\jhpro\separate-window\dsh-memory-anchor

node scripts/test-all.mjs      # 5 个套件
npm run check                  # 客户端 bundle 静态校验
node scripts/check-publish.mjs # 发布配置检查
npm pack --dry-run             # 看一眼最终内容
```

**一定要先 `cd` 到包目录**，在 `D:\` 根目录执行 `npm publish` 会报
`ENOENT: Could not read package.json`。

---

## 四、推到 GitHub

仓库目前**还不是 git 仓库**：

```bash
cd /d D:\jhpro\separate-window\dsh-memory-anchor
git init
git add .
git commit -m "feat: memory anchor plugin for DeepSeek Harness"

# 先在 GitHub 网页建一个空仓库 dsh-memory-anchor，不要勾 README/gitignore
git remote add origin https://github.com/JhengFire/dsh-memory-anchor.git
git branch -M main
git push -u origin main
```

推上去后 Actions 会自动跑 CI（Ubuntu / Windows / macOS × Node 20 / 22）。

---

## 五、发布到 npm

```bash
cd /d D:\jhpro\separate-window\dsh-memory-anchor
npm publish --registry=https://registry.npmjs.org
```

### 或者走 GitHub Actions（会自动建 Release）

1. 在 npm 网站生成一个 **Automation token**（不是 Publish token）
2. GitHub 仓库 → Settings → Secrets and variables → Actions → 新建 `NPM_TOKEN`
3. 打标签触发：

```bash
npm version patch
git push --follow-tags
```

`release.yml` 会：校验标签与版本一致 → 跑测试 → 校验 bundle → 发布 → 建 GitHub Release。

**token 只放在 GitHub Secret 里，不要写进任何文件，也不要贴到对话里。**

---

## 六、发布后自查

```bash
npm view dsh-memory-anchor
mkdir /tmp/t && cd /tmp/t && npm i dsh-memory-anchor
ls node_modules/dsh-memory-anchor/lib/
```

然后回到 Harness：

```bash
dsh plugin add dsh-memory-anchor
```

确认三件事：
- 工具列表里有 `memory`
- 设置里有「记忆锚点」分类
- 开关能切换、列表能翻页

---

## 七、仓库设置建议

| 项 | 建议 |
|---|---|
| About 描述 | 抄 `package.json` 的 description |
| Topics | `dsh` `dsh-plugin` `deepseek-harness` `agent-memory` `ai-agent` |
| License | MIT（`LICENSE` 已备好） |
| Branch protection | 保护 `main`，要求 CI 通过 |
| Releases | 由 `release.yml` 自动创建 |

---

## 八、已知的发布前限制

1. **CI 不跑 `plugin` 和 `ui` 两个套件。** 它们依赖 DSH 安装目录 `app.asar` 里的 `zod`，
   GitHub Runner 上没有 DSH。CI 只跑三个纯 Node 套件 + bundle 静态校验。
   这是有意的取舍：补上需要把 `zod` 提为 devDependency，会让"零依赖"打折。
2. **包体积约 51 kB**（18 个文件）。没有构建步骤，发什么跑什么。
3. **截图不在包里**，README 用 GitHub raw 绝对地址引用。npm 页面上能正常加载，
   但如果仓库改了名或图被删，两处 README 会同时裂图。

---

## 附：曾经踩过的两个坑

| 现象 | 原因 | 解决 |
|---|---|---|
| `ENOENT: Could not read package.json` | 在 `D:\` 根目录执行 | 先 `cd` 到包目录 |
| `ENEEDAUTH` | registry 指向淘宝镜像，镜像不能发布 | 发布时加 `--registry=https://registry.npmjs.org` |