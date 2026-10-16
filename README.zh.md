# dsh-output-loop-guard

[English](./README.md) | 中文

DSH 的**输出自我重复看门狗**：模型流式输出出现退化循环时中止该轮，并唤醒 agent 带着纠正提示继续任务——不需要人按停止键，也不需要人再打一句"继续"。

- 适用于 DSH `>= 0.2.0-rc.2`，ESM，零运行时依赖。
- 21 项自包含回归测试（`npm test`）。
- 在 27 个真实会话 / 1,783 个 assistant 步骤上标定：**24 次触发，0 次假阳性**。

## 它补的是哪个洞

框架自带的 `@deepseek-ai/dsh-repeat-tool-reminder` 只能看见**重复的工具调用**（同一工具、同一参数连续 3/5/8 次）。发生在**推理通道**里的退化循环它结构上看不到。在促成这个插件的那次会话里：

- 模型在推理通道里反复吐 `好。→（执行）→好。→Write.→…` 达 **112,109 字符**，以 **50,196 个流式块、126 秒连续解码**产出，**工具调用数为 0** —— `repeat-tool-reminder` 不可能触发；
- 自动压缩也没能兜住：其触发阈值是 `floor(min(W × 0.8, W − O − B))`，对 1M 窗口 + 256k 输出上限约为 678k token，而该会话峰值约 508k token；
- 循环最终靠用户手动停止结束，而退化文本留在会话里，反而让后续更容易复发（自我模仿）。

`output-loop-guard` 挂在实时流事件 `agent/assistant-stream` 上，直接看**文本本身**。

## 工作方式

对每一段流式输出维护滑动窗口（默认 1200 字符，每新增 64 字符检查一次），四个信号：

| 信号 | 判据 | 抓什么 |
|---|---|---|
| `repeated-block` | **最短周期**块（≥2 个换行、≥2 个不同非空白字符）连续重复 ≥6 次 | 多行周期循环，如周期 106 字符的 `好。→（执行）→Write.` 循环 |
| `dominant-gram` | 某个 n-gram 覆盖窗口 ≥55% 且出现 ≥24 次，且跨 ≥2 行 | 尾部不整齐、但重复已主导窗口的循环 |
| `repeated-line` | 单行重复：推理通道 ≥40 次，可见正文 ≥60 次（`singleLineTextMinRepeats`，设 0 可关） | 推理里的单行空转、正文里失控的整行复制 |
| `flat-tic` | 无空白短 gram 覆盖窗口 ≥25% 且出现 ≥48 次，**仅推理通道** | 没有换行的纯口癖（`好。好。好。…`） |

两条设计约束保证精度：

- **只用最短周期判定。** 同一行重复时，行长的 2×、3× 也是"周期"；标定中按任意周期看，会把正常 bullet 列表误判成多行循环。因此只看最短周期，并要求**该周期块本身**跨 ≥2 个换行。
- **通道感知。** 可见正文里重复整行通常是合法内容（生成的夹具、配置文件、列表），所以正文单行门槛（60）高于推理通道（40）；无换行的纯口癖只在推理通道判定。缩进、`====` / `----` 分隔线、连续空行永不触发。

触发后：

1. `agent.cancel({ kind: 'hook', reason: 'output-loop-guard: …' })` —— 中止正在跑的生成（记录为 interrupted，退化文本不再增长）；
2. `agent.steer(<notice>)` —— 信号已被 abort，`steer` 会升级为**新一轮**并唤醒 driver，agent 立即带纠正提示继续（提示明确要求停止复述、直接产出动作或结束）；
3. 同一轮内触发超过 `maxTripsPerTurn` 次后不再自动继续，只 `inject` 提示并停下。

## 安装

本包是 DSH 的**组合包（bundle）**：加载器只读 `package.json` 里的 `dsh.bundle.patch`
（`dsh.plugin.json` 是可选元数据，供部分本地插件索引使用，**官方运行时不读取它**），由 `cordis.patch.yml` 插入 `output-loop-guard` 行。

```sh
# A. 从 git 托管安装并固定 commit（需要 DSH 进程的 PATH 里有 git）
dsh plugin --profile <profile> add "github:ADistanceThereIs/dsh-output-loop-guard#<commit>"

# B. 从 Release tarball 安装 —— 不需要 git
#    先从 Releases 页下载 dsh-output-loop-guard-0.1.0.tgz，然后：
dsh plugin --profile <profile> add ./dsh-output-loop-guard-0.1.0.tgz

# C. 直接用 Release 资产 URL（需要 Node 信任系统 CA 库）
dsh plugin --profile <profile> add \
  https://github.com/ADistanceThereIs/dsh-output-loop-guard/releases/download/v0.1.0/dsh-output-loop-guard-0.1.0.tgz
```

三种方式都会把包追加进 `dsh.profile.bundles` 并合成 bundle 的 patch 层。**重启 DSH 后该行才会激活。**

卸载：

```sh
dsh plugin --profile <profile> remove dsh-output-loop-guard
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖该行（patch 会替换整行的 `config`，要保留的键都要重述）：

```yaml
- id: output-loop-guard
  name: dsh-output-loop-guard
  config:
    dryRun: false                 # true = 只检测记录，绝不中止
    autoContinue: true            # 中止后唤醒 agent 并给出纠正提示
    maxTripsPerTurn: 2            # 每轮自动继续预算
    windowChars: 1200
    checkEveryChars: 64
    minPeriodRepeats: 6           # 多行周期重复次数门槛
    singleLineMinRepeats: 40      # 推理通道单行门槛
    singleLineTextMinRepeats: 60  # 正文通道单行门槛（0 = 关闭）
    useDominantGram: true
    dominantGramCoverage: 0.55
    dominantGramMinCount: 24
    useFlatTic: true
    ticMinCount: 48
    ticMinCoverage: 0.25
    verbose: false
```

想先观察自己会话里的触发情况，可先用 `dryRun: true`。

## 实测证据

### 语料回放

在 27 个真实会话 / 1,783 个 assistant 步骤上回放（语料同时含健康文本与退化文本）：

- 24 次触发，**0 次假阳性**；
- 覆盖促成该插件的会话的全部循环步骤，并跨会话命中另一个工作区里同类的 `（好。）` 循环；
- 检出延迟：112,109 字符的失控在 **2,944 字符（2.6%）**处被抓住；其余循环在 1,152–7,808 字符内抓住——从 20–126 秒的空转变成数百毫秒结束。

### 真实运行时验证

在活的 DSH 运行时里跑一条"把两行重复输出 300 遍"的诱导任务，会话日志包含：

```json
{"type":"turn/end","data":{"turn":1,"reason":{"kind":"aborted","reason":{"kind":"hook","reason":"output-loop-guard: repeated output (repeated-block)"}}}}
{"type":"assistant/message","interrupted":true}          // 只输出 9 遍即被切断，而非 300 遍
{"type":"user/message","source":{"kind":"output-loop-guard","form":"notice"}}
```

随后 agent 把同样的内容改为**写文件**交付，而不是继续复述——这正是预期行为：护栏掐掉失控输出，而不是让任务失败。

### 回归测试

`npm test` 跑 21 项自包含检查（不需要语料）：真实退化必须被中止（24,180 字符的流在 576 字符处抓住）、健康长文档不受影响、真实形态的正文（列表/代码块/表格/分隔线/夹具）不得触发、失控的正文整行必须触发、`dryRun` 不得中止、禁用后不得注册监听、agent 句柄抛异常不得污染流。

## 已知边界

- 正文里的单行重复需 ≥60 个连续相同行才触发（保护合法夹具与列表）；`singleLineTextMinRepeats: 0` 可关闭。
- 只做结构化判定（周期与密度），不做语义判断：改动过的近似重复可能漏过 `repeated-block`，通常由 `dominant-gram` / `flat-tic` 兜住。
- 每个 agent、每次 attempt 独立计数，子 agent 不共享。
- 触发会丢掉该步骤尚未发出的工具调用（代价是一次重试），这是换取"不再空转数分钟"的取舍；可先用 `dryRun` 观察。

## 用到的事件契约

- `agent/assistant-stream`，载荷 `{ agent, frame }`，`frame = { type: 'start' | 'chunk' | 'end', attemptId, revision, …, chunk }`，`chunk` 为 `StreamChunk`（`reasoning-delta` / `text-delta` / …）。
- `Agent.cancel(cause, options)`：封闭原因集合为 `user | parent | disposed | hook`，`hook` 会把 reason 记入 `turn/end`——本插件使用 `hook`。
- `Agent.steer()` 即 `send(message, 'next-step', true)`；当活动信号已被 abort 时，`send` 会把目标升级为 `next-turn` 并唤醒 driver，因此 `cancel(); steer(notice)` 等于"中止这次生成，然后用新一轮继续"。

## 常见问题

**`dsh plugin add github:…` 报 `resolveGit` / `resolveRef` 失败。**
pnpm 解析 git 依赖要用 `git` 可执行文件，而 DSH 继承的是**启动它的那个进程**的环境变量。若你先启动 DSH、后安装 Git，新的 `PATH` 对已在运行的 DSH 不可见。把 Git 所在目录加进 shell 的 `PATH`（或重启 DSH）后重试：

```powershell
$env:PATH = 'C:\Program Files\Git\cmd;' + $env:PATH
dsh plugin --profile <profile> add "github:ADistanceThereIs/dsh-output-loop-guard#<commit>"
```

建议固定到具体 commit（或 tag），这样后续推送无法悄悄改变本机实际运行的代码。

**`dsh plugin add https://…` 报 `fetch failed` / `unable to verify the first certificate`。**
Node 的 `fetch` 用的是内置 CA 列表，因此做 HTTPS 检查的安全软件（企业代理、部分杀软）会破坏它，而 `curl` 仍然正常。Node 22.15+/24 可改用系统信任库：

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
dsh plugin --profile <profile> add https://github.com/ADistanceThereIs/dsh-output-loop-guard/releases/download/v0.1.0/dsh-output-loop-guard-0.1.0.tgz
```

自己下载 tarball 再安装本地文件可完全绕开该问题。

**护栏掐掉了你本来想要的内容。**
设 `dryRun: true`（只检测不中止）、放宽阈值，或设 `singleLineTextMinRepeats: 0` 关闭正文单行判定。

**感觉护栏没生效。**
bundle 的行需要**重启 DSH** 后才激活；对于非应用托管的 profile，可用
`dsh --profile <profile> --dump-config | Select-String output-loop-guard` 确认该行已合成。

## 开发

```sh
node test/guard.test.mjs   # 或 npm test
```

`detector.mjs` 无依赖、可单独导入（`dsh-output-loop-guard/detector`），因此检测逻辑可以脱离 DSH 复用或重新标定。

## 许可

MIT，见 [LICENSE](./LICENSE)。
