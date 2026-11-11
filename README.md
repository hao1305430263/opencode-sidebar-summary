# opencode-sidebar-summary

OpenCode 终端界面（TUI）的侧边栏摘要插件：把当前会话里的用户输入、模型思考（thinking）
和模型回复，各自用 **DeepSeek** 总结成一句中文，显示在会话侧边栏里，并按类型用颜色区分。

```
摘要 你3 思18 答4
│你 较早的用户输入摘要……
│思 较早的思考摘要……
│答 较早的回复摘要……
│你 最新一条摘要……
滚轮上下滚动 · 最新在下 · 上方还有更早 8 条
```

- `你`：用户输入，info 蓝色
- `思`：模型 thinking / reasoning，warning 橙黄色
- `答`：模型回复，base 常规色
- 左侧 `│` 是连续竖列，标签 `你/思/答` 固定在左列，方便快速定位
- 最新内容在最下方，打开时默认停在底部；滚轮、滚动条箭头可上下滚动
- 标题栏只显示计数，不可点击、不能隐藏，列表始终展开

## 环境要求

- OpenCode V2（在 `2.2.7` 上验证），且支持 TUI 插件（`@opencode/plugin/tui`）
- OpenCode 里已配置好一个 DeepSeek provider。插件默认使用：
  - `providerID`: `magpie-lan`
  - `modelID`: `workbuddy/deepseek-v4.1-flash`
  - `variant`: `low`

  如果你的 provider 名称不同，在安装后的配置里改 `providerID` / `modelID` 即可。
  插件通过 OpenCode 服务端的一次性生成接口调用模型，**不需要在插件里单独写 API Key**。

## 安装

### 1. 复制插件目录

把整个 `opencode-sidebar-summary` 文件夹复制到 OpenCode 全局配置目录下，
并命名为 `sidebar-summary`。

Windows（PowerShell，在插件文件夹的上一级执行）：

```powershell
Copy-Item -Recurse .\opencode-sidebar-summary "$env:USERPROFILE\.config\opencode\sidebar-summary"
```

macOS / Linux：

```bash
cp -R opencode-sidebar-summary ~/.config/opencode/sidebar-summary
```

复制后应包含：

```
%USERPROFILE%\.config\opencode\sidebar-summary\
  tui.tsx          # 侧边栏组件、滚动、请求调度
  summary.ts       # 摘要 / 提示词 / 清洗逻辑
  package.json     # 插件入口声明（exports ./tui）
  README.md
```

> 如果只想用最简方式，也可以只复制 `tui.tsx` 和 `summary.ts`，
> OpenCode 会按根目录文件名自动识别 `tui` 入口。

### 2. 在 `cli.json` 中启用

编辑全局 CLI 配置：

- Windows：`%USERPROFILE%\.config\opencode\cli.json`
- macOS / Linux：`~/.config/opencode/cli.json`
- 设置了 `XDG_CONFIG_HOME` 时：`$XDG_CONFIG_HOME/opencode/cli.json`

在 `plugins` 数组里加入 `"./sidebar-summary"`（保留已有条目）：

```json
{
  "plugins": ["./sidebar-summary"]
}
```

如果已有其他插件：

```json
{
  "plugins": ["./herdr-opencode", "./sidebar-summary"]
}
```

路径是相对全局配置目录的。插件放在其他位置时，也可以写绝对路径：

```json
{
  "plugins": ["E:/partTimeWork/opencode-sidebar-summary"]
}
```

### 3. 重载

保存 `cli.json` 后 OpenCode 会自动重载插件。没有生效时在 TUI 中执行：

```
/reload
```

然后打开一个会话，按 `Ctrl+X` 再按 `B` 确保侧边栏可见。

### 4. 确认已加载

```bash
opencode plugin list
```

应能看到类似输出：

```
ID   VERSION  SOURCE
-    local    C:\Users\<you>\.config\opencode\sidebar-summary
```

## 配置选项

默认值已经可用。需要调整时，把 `cli.json` 里的字符串条目换成对象形式：

```json
{
  "plugins": [
    {
      "package": "./sidebar-summary",
      "options": {
        "limit": 30,
        "height": 24,
        "chars": 60,
        "kinds": ["user", "think", "reply"],
        "providerID": "magpie-lan",
        "modelID": "workbuddy/deepseek-v4.1-flash",
        "variant": "low",
        "concurrency": 2,
        "timeoutMs": 20000
      }
    }
  ]
}
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `limit` | `20` | 保留最近多少条；`0` 表示全部 |
| `height` | `20` | 滚动区域高度（行数） |
| `chars` | `60` | 每条摘要的最大字符数 |
| `kinds` | `["user","think","reply"]` | 要显示的类型；例如只留 `["user","think"]` |
| `providerID` | `magpie-lan` | DeepSeek provider ID |
| `modelID` | `workbuddy/deepseek-v4.1-flash` | 模型 ID |
| `variant` | `low` | 推理档位；改成 `none` 完全关闭推理，速度更快；空字符串表示模型默认 |
| `concurrency` | `2` | 同时进行的摘要请求数 |
| `timeoutMs` | `20000` | 单次请求超时（毫秒） |

## 工作方式

1. 先用本地启发式规则生成一个临时单句并立即显示，侧边栏不会空等。
2. 通过 OpenCode 服务端 `POST /api/experimental/generate/text` 调用 DeepSeek，
   只使用返回的最终文本，推理内容不会显示。
3. 模型返回后替换临时单句，并写入磁盘缓存；同一条内容只请求一次。
4. 接口失败或超时时保留本地单句，60 秒后再重试，不打断会话。
5. 新消息按时间顺序追加到列表底部，滚动区默认跟随到底部。

## 缓存

摘要缓存在：

```
~/.local/state/opencode/latest/tui/plugin.local.sidebar-summary.summary-cache.json
```

想强制重新生成，删除这个文件即可。消息文本变化会自动生成新的缓存 key。

## 本地开发

这些步骤只用于修改插件，运行插件本身不需要执行。

```bash
npm install
npm run typecheck
npm test
```

- `npm run typecheck`：用 `tsc` 校验 TUI 插件类型
- `npm test`：运行摘要逻辑单元测试（Node 24+ 可直接运行 `.ts`）

项目结构：

```
opencode-sidebar-summary/
  tui.tsx              # 侧边栏组件（滚动、颜色、请求调度）
  summary.ts           # 摘要、提示词、输出清洗、缓存 key
  test/summary.test.ts # 无 TUI 依赖的单元测试
  package.json
  tsconfig.json
```

## 常见问题

**侧边栏没有出现**
- 按 `Ctrl+X` 然后 `B` 切换侧边栏
- 确认终端宽度足够（侧边栏在空间不足时会自动隐藏）
- 执行 `/reload`
- `opencode plugin list` 确认插件已被识别

**一直显示本地占位句，没有变成模型摘要**
- 检查 OpenCode 的 provider 配置是否能正常调用 DeepSeek
- 确认 `providerID` / `modelID` 与你的配置一致
- 如果用了 `variant: "none"` 仍然失败，查看 OpenCode 日志：
  `~/.local/share/opencode/log/opencode.log`
- 删除缓存文件后重试

**想完全关闭推理**
- 在选项里设置 `"variant": "none"`

## 卸载

1. 从 `cli.json` 的 `plugins` 中删除 `"./sidebar-summary"`。
2. 删除 `~/.config/opencode/sidebar-summary` 文件夹。
3. 可选：删除缓存文件 `~/.local/state/opencode/latest/tui/plugin.local.sidebar-summary.summary-cache.json`。
