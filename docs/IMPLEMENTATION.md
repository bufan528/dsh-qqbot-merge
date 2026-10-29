# dsh-qqbot-merge —— 实现与证据（官方 0.5.3 的维护分支）

> 本文件由 Memory Vault 仓库的 `docs/evidence/qqbot-merge-implementation.md` 迁移而来，
> 是**本插件**（执行侧）的实现记录。文中路径若仍为
> `D:\dsh-memory-vault\extensions\dsh-qqbot-merge\`，那是 2026-10-27 开发时的历史路径；
> 本仓库（`bufan528/dsh-qqbot-merge` = `D:\dsh-qqbot-merge`）就是该目录独立化后的产物。
>
> 面向使用者的安装/迁移/回滚说明见仓库根目录 [README.md](../README.md)。




| 项 | 值 |
|---|---|
| 状态 | **COMPLETED**（代码 / 构建 / 单测 / 打包 / 运行期探针 / 真实 cordis 服务注册均已验证）；**真实 QQ 端到端未验证**（约束：不得替换用户正在运行的插件），详见 §10 |
| 实施时间 | 2026-10-27 22:39–23:05 +08:00（Asia/Shanghai） |
| 宿主基线 | DSH Desktop **0.2.1-rc.3**（`D:\dsh\resources\app.asar`）；profile `C:\Users\bf410\.dsh\profiles\desktop` |
| 上游基线 | `@tencent-connect/dsh-qqbot` **0.5.3**（MIT，源码 tag `0.5.3`；profile 内实装 0.5.3，SDK `@tencent-connect/qqbot-nodejs 1.0.5`） |
| 交付物 | `D:\dsh-qqbot-merge\`（源码 + `dist/` + `lib/client.js`）；npm `dsh-qqbot-merge@0.1.0`；本文件（迁移后） |
| 写入范围 | 本仓库 `**`（该文迁移前为 Memory Vault 仓库的 `extensions/dsh-qqbot-merge/**`） |
| 明确未做 | 未安装到任何真实 profile、未修改 `node_modules`（宿主/profile 内）、未改 `D:\dsh` 宿主文件、未改 Memory Vault `src/**`、未 commit/push、未重启/关闭 DSH |
| 构建/测试 | `tsc -p tsconfig.json` **0 error**；`vitest run` **17 files / 210 tests 全通过**；`npm pack` 282 files / 1,109,795 B |
| 契约 | 与 `D:\dsh-memory-vault\src\shared\qqbot-merge-contract.ts` **逐字一致**（SHA256 相同，`version: 1`） |

---

## 0. 结论摘要（先看这 10 条）

1. **fork 来源可核**：源码取自工作区已有的 0.5.3 tag 解包物（`.scratch/qqbot-053-src/dsh-qqbot-0.5.3.zip` → 解包目录），并做了独立核对：未改动的源码文件与 `https://raw.githubusercontent.com/tencent-connect/dsh-qqbot/0.5.3/...` **逐字节一致**（如 `src/session/session-manager.ts`、`src/transport/chunker.ts` 均为 `IDENTICAL`）。`LICENSE`（MIT）保留。
2. **旧行为被替换**（仅当 `qqbotMerge.enabled=true` 时；默认 `false` 保持旧行为）：
   - 忙碌期间的消息不再由 SDK `concurrencyGuard(strategy='merge')` 缓冲后排队到下一轮，而是经 `urgentPredicate` 直接进入入站链路，由新协调器接管；
   - 入站不再 `await record.agent.whenIdle()` 阻塞消息链；
   - 出站不再每个 `assistant/message` 都 finish/complete 一条独立 QQ 消息，而是一轮只修订/完成一条（`replyMode='single-message'`）。
3. **合并语义**：按 QQ 会话（`c2c:<openid>` / `group:<openid>`）隔离；800ms 可配 debounce（新消息续期）；flush 前**重查** `agent.status`；`running` → 一条结构化 user message 走 **`agent.steer(...)`**（非打断式，inbox next-step）；`idle` → 一条 `agent.followup(...)`；**绝不** `agent.cancel`/`ctx.abort`。
4. **turn-stopping 增强**：监听官方 `agent/turn-stopping`（serial 派发），把该会话仍在窗口内的批次立即 flush → 在监听器调用栈内同步 `steer(...)` → 机器重读 inbox 继续同一 turn，消除"消息恰好在收尾窗口内到达被留到下一轮"的缝隙。
5. **竞态兜底**：steer 抛错（轮次已结束/agent 已释放）→ 降级 `followup` 并计入 `steerFallbacks`；溢出消息不丢弃（通知 + 强制 followup 下一批）；`agent/turn-stopping` 里同步 steer 把竞态窗口压到最小。**已知遗留竞态**见 §6.4（公开 API 不含 `inbox.remove`，未实现自唤醒）。
6. **同一轮单条回复**：`assistant/message` 到达时只把该 step 文本定稿为前缀并全量 update 同一条流式消息；新 step 的 `attempt-start` 只 reset 当前 attempt；**只有 turn/end 才 finish/complete 一次**。流式不可用（群聊/无 msgId/配置关闭/openStream 失败）→ 文本缓存到内存，turn/end 只静态发送一次；工具结果、轮末交付文件、turn 错误提示、`/stop` 取消路径的收尾全部保留。
7. **对外服务 `qqbotMerge` 已用真实 cordis 验证**：在扩展自身安装的 `@deepseek-ai/cordis@4.0.1` 上用插件 fiber 模拟"provider → consumer"与"consumer → provider"两种加载顺序，`ctx.inject(['qqbotMerge'])` 均被唤醒（`fired=true`），`ctx.get('qqbotMerge').contract = {"name":"qqbot-merge","version":1}`；宿主 asar 内 cordis 为 4.0.5（`ctx.provide`/`ctx.reflect.provide` 同 API 线，源码已核对）。注册调用在 `src/index.ts:70-79`（`services.provide('qqbotMerge', mergeRuntime)`）。
8. **运行期探针**（不连 QQ，直接用 `dist/` 构建产物）：模拟"agent 忙碌期间连发两条"→ 只调用 **1 次** `agent.steer`，合并消息按顺序包含两条（时间戳/msgId 保留）；`getStatus()` 输出 `counters.messagesSteered=2`、`lastBatch={mode:'steer',count:2,ok:true}`、`applied.revision=1`，与契约逐字段一致（真实输出见 §5）。
9. **构建/测试/打包全绿**：`npm run build`（`tsc`）0 error；`npx vitest run` **17 files / 210 tests passed**（其中新增 54 条：coordinator 28 / service 13 / outbound-revision 9 / inbound 4；上游 156 条全部保留通过，2 处上游测试 fixture 因**刻意修改的 row id** 从 `im-qqbot` 改为 `qqbot-merge`）；`npm pack` 产出 **`.scratch/fork-impl/dsh-qqbot-merge-0.1.0.tgz`**（282 files，1,109,795 B，SHA256 `0C7FEB88…29714`），并在临时目录 `npm install` 成功、入口与 `./client` 导出均可解析。
10. **最大风险**：没有真实 QQ 收发验证（不得替换用户运行中插件）。因此"steer 在真实 QQ 轮次边界的用户可感知效果""流式修订在 QQ 客户端的实际呈现/频率限制""`agent/turn-stopping` 在真实宿主的触发时序"均为**未验证**，不应向用户宣称已生效。

---

## 1. 事实基线（可直接引用）

### 1.1 官方 0.5.3 旧链路（将被替换的行为）

行号口径：tag `0.5.3` 源码（工作区 `.scratch/qqbot-053-src/dsh-qqbot-0.5.3/`）。

| 位置 | 旧行为 |
|---|---|
| `src/gateway/middleware-setup.ts:98-102` | `concurrencyGuard({ strategy: 'merge', maxQueue, maxProcessingMs })`：忙碌时缓冲，当前消息完成后由"幸存者" `next()`，即**排队到下一轮** |
| `src/transport/inbound.ts:137,145-150` | `record.agent.followup(message)` 后 `await record.agent.whenIdle()`：消息链阻塞到本轮结束；这也是 guard 判忙碌的来源 |
| `src/transport/outbound.ts:182-199` | `onMessage`：每个 `assistant/message` 若 buffer 有文本 → `buffer.flush()` → `StreamingWriter.finish()` → `session.complete()` → **一条独立 QQ 消息**；`buffers.delete` |
| `src/transport/outbound.ts:250-281` | `onTurnEnd`：再 flush 剩余 buffer、投递交付文件、发 turn 错误 |
| `src/transport/outbound-buffer.ts:71-93` | `flush()`：流式优先 finish/complete，失败降级静态 `sendMarkdown`（整段） |
| `src/transport/streaming-writer.ts:77-100` | `finish()`：enqueue 最终 update + `complete()`；`reset()` 只清全文 |
| `node_modules/@tencent-connect/qqbot-nodejs/src/middleware/concurrency-guard.ts:237-244`（dist js `:137-150`，任务给出行号） | `urgentPredicate(ctx)` 为真 → 忙碌期间该消息跳过 merge 缓冲，直接沿剩余链 `next()` 并行执行（官方绕过排队的开关） |

### 1.2 DSH Agent 公开 API（引用 `docs/evidence/dsh-agent-api-steering.md`，同一份宿主事实核验）

- `agent.steer(input)` = `send(input,'next-step',true)`：**下一个 pre-step 边界**消费；轮次将收尾而 next-step 非空时**继续同一 turn**；空闲时也不丢（wakeDriver 起一轮）。（该文 §0 第 1–3 条，`dsh-agent-loop lib/index.js:809-811`）
- `agent/turn-stopping` 是官方"让轮次继续"的正式机制：serial(await) 派发，监听器里 steer 后机器重读 inbox。（§0 第 4 条，`lib/index.js:1000-1008`）
- `followup` → `next-turn`；`steer` → `next-step`；`cancel(cause)` 默认**清空 inbox**，`{keepInbox:true}` 才保留。（§0 第 5–6 条）
- `agent.status` 只有 `'idle' | 'running'`（maintenance 期间对外仍报 idle）。（§0 第 7 条）
- assistant 输出粒度：每个 step 一条 durable `assistant/message`；流式是瞬态 `agent/assistant-stream`（帧含 turn/step）。（§0 第 8 条）
- 收尾竞态：steer 落在 turn 已判定结束、status 未转 idle 的微任务窗口 → 消息停在 next-step、不丢不抛错，直到下一次 wake。（§0 第 9 条）

本实现直接依赖以上事实，并**不**依赖任何内部实现细节（`inbox` 不触碰）。

### 1.3 cordis 服务注册 API（本机真实证据）

- 宿主内 `@deepseek-ai/cordis` **4.0.5**（asar `/dsh/node_modules/@deepseek-ai/cordis/package.json`）；源码 `src/reflect.ts` 声明 `ctx.get / ctx.set / ctx.provide(name, value) -> disposer`，并注明"Only the fiber that provided the service may set it"。
- 扩展包 devDependency 安装的是 `@deepseek-ai/cordis@4.0.1`（上游 0.5.3 锁定值，同 API 线）。
- **真实注册探针**：`.scratch/fork-impl/provide-probe.mjs`

```text
cordis version: 4.0.1
provider→consumer: consumer fired=true contract={"name":"qqbot-merge","version":1} root ctx.get={"name":"qqbot-merge","version":1}
consumer→provider: consumer fired=true contract={"name":"qqbot-merge","version":1} root ctx.get={"name":"qqbot-merge","version":1}
```

即：本扩展 `apply()` 里 `ctx.provide('qqbotMerge', service)` 与 Memory Vault 的 `ctx.inject(['qqbotMerge'], cb)` 在**两种插件加载顺序**下都能接上；消费者从未命中到命中都会被 cordis 唤醒。

---

## 2. 交付物与源码来源

### 2.1 目录

```text
D:\dsh-qqbot-merge\
├─ package.json              # name dsh-qqbot-merge / version 0.1.0（其余字段尽量保持上游）
├─ cordis.patch.yml          # bundle patch：row id qqbot-merge、name dsh-qqbot-merge、qqbotMerge 默认配置
├─ tsconfig.json             # 上游原样
├─ vitest.config.ts          # 新增：独立于宿主仓库的测试 include
├─ LICENSE                   # 上游 MIT，原样保留
├─ README.md                 # 顶部新增维护分支说明（其余为上游文档）
├─ src\                      # 上游 0.5.3 src + 新增 merge/ + 补丁（详见 §4）
├─ dist\                     # tsc 构建产物（282 文件里的 dist）
├─ lib\client.js             # 客户端 bundle：复制自本机官方 0.5.3 包，仅改 2 处 id
├─ assets\ locale\ scripts\  # 上游原样
└─ node_modules\             # 本地开发依赖（gitignore；不随包发布）
```

### 2.2 `package.json` 变更（`package.json:2-3,21,26` 等）

| 字段 | 值 | 说明 |
|---|---|---|
| `name` | `dsh-qqbot-merge` | 独立包名 |
| `version` | `0.1.0` | fork 版本 |
| `description` | 中英双语，注明"0.5.3 维护分支 + 合并/单条回复" | — |
| `main/types/exports` | 与上游一致（`./dist/index.js`、`./client` → `./lib/client.js`） | 保持可安装性 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 保持 |
| `dsh.client` | `{ "platform": "web" }` | 保持 |
| `dsh.compatibility` | 继承上游两条声明 + note 明确"未在 0.2.1-rc.3 上端到端验收" | 不虚报 |
| `scripts.build` | `tsc -p tsconfig.json` | 上游是 `tsc && tsdown ...`；本 fork 客户端 bundle 直接沿用官方构建产物，因此构建只跑 tsc（`build:client` 仍保留） |
| `scripts.test` | `vitest run` | — |
| `dependencies/peerDependencies/engines` | 与上游一致 | 宿主版本门槛由 peerDeps 决定（0.2.1-rc.3 满足 `>=0.1.0-rc.6`） |
| `icon/keywords/repository` | 上游 + 追加 `steering`/`message-merge` | — |

### 2.3 客户端 bundle 来源与版本（任务要求注明）

| 项 | 值 |
|---|---|
| 来源 | `C:\Users\bf410\.dsh\profiles\desktop\node_modules\@tencent-connect\dsh-qqbot\lib\client.js`（官方 **0.5.3** 安装产物） |
| 原始大小 | 49,644 B |
| 改动 | 仅 2 处字符串：`lib/client.js:2` `id: "@tencent-connect/dsh-qqbot"` → `id: "dsh-qqbot-merge"`；`lib/client.js:915` `PACKAGE_NAME = "@tencent-connect/dsh-qqbot"` → `"dsh-qqbot-merge"`（与重新构建会得到的包名一致） |
| 改后大小 | 49,622 B（`lib/client.js.map` 一并复制，未改） |
| 未做 | **未重新构建**客户端 bundle（`npm run build:client` 仍可用）：本次不改客户端 UI，沿用上游产物可避免引入未验证的构建差异 |

### 2.4 行 id 改名（`qqbot-merge`）的连带改动

上游用 `im-qqbot` 作为 profile patch 行 id、fiber 名与持久化目标。fork 改为 `qqbot-merge` 以避免与官方插件**同时安装**时行冲突/重复连接同一个 QQ Bot：

- `src/index.ts:28`：`export const name = 'im-qqbot-merge'`；
- `cordis.patch.yml:17-18`：`- id: qqbot-merge` / `name: 'dsh-qqbot-merge'`；
- `src/setup/persist.ts:25` 新增 `PLUGIN_ROW_ID = 'qqbot-merge'`，凭据/配置持久化统一写该行（原硬编码 `im-qqbot` 的 3 处已替换：`:64,76,121,169,181`）；
- 上游测试 fixture `src/setup/bind-routes.test.ts:260,304` 同步改为 `qqbot-merge`（**这是唯一被修改的上游测试**，属预期行为变更）。

> 因此本包与官方 `@tencent-connect/dsh-qqbot` **不能同时启用**（同一 appId 会双连接；`/qqbot/im-qqbot/*` 绑定页路由同名）。安装指引见 §11。

---

## 3. 新增模块

### 3.1 `src/merge/contract.ts`（逐字复制，197 行）

- 来源：`D:\dsh-memory-vault\src\shared\qqbot-merge-contract.ts`；
- 复制方式：文件级复制，**SHA256 双端相同**：`C5FB797A7059F4A3238347A57F89991F331D4B78207013188E2239359BE97591`；
- 内容：`QQBOT_MERGE_CONTRACT = { name:'qqbot-merge', version:1 }`、`QQBOT_MERGE_BUSY_POLICIES=['steer','queue']`、`QQBOT_MERGE_REPLY_MODES=['single-message','per-step']`、`QqbotMergeConfig`、`DEFAULT_QQBOT_MERGE_CONFIG`、`QqbotMergeLastBatch`、`QqbotMergeCounters`（8 字段：`batchesMerged/messagesSteered/messagesFollowedUp/messagesOverflowed/steerFallbacks/replyRewrites/repliesCompleted/batchesAborted`）、`QqbotMergeStatus`（`contract/config/applied{revision,appliedAt,activeBatches,pendingMessages}/runtime{steerSupported,steerMechanism,integration,streamingRevision,note}/counters/lastBatch`）、`QqbotMergeService`、`QqbotMergeReport`、`normalize*` 与 `isMergeContractCompatible`。

### 3.2 `src/merge/coordinator.ts`（新增，约 470 行）

| 点 | 实现 |
|---|---|
| 会话隔离键 | `sessionKeyOf(record) = ${scope}:${peerId}`（`c2c:<openid>` / `group:<openid>`），批次表按此隔离；群聊启用合并时批次键再拼 `#${senderId}`（同一发送者才合并） |
| 窗口 | `windowMs`（默认 800，归一化 100–10000）；`submit()` 每条消息重排定时器（debounce 续期）；`flush` 前删除批次并清定时器 |
| 忙碌判定 | flush 时读 `record.agent.status === 'running'`（真实字段，见 §1.2），不在 submit 时缓存 |
| 忙碌策略 | `busyPolicy==='steer'` 且非溢出批次 → 构造**一条** `createUserMessage`（结构化补充文案）→ `agent.steer(msg)`；`queue` 或空闲 → `agent.followup(msg)`，一批只提交一条 |
| steer 竞态 | steer 抛错 → `steerFallbacks+1`，降级 `followup`；followup 也失败 → `lastBatch.ok=false` + 用本扩展 `bot.sendMarkdown` 告知用户"未能送达"（不静默） |
| turn-stopping | `flushSession(record)`：取消该会话所有未到期普通批次的定时器并立即 flush；`flush→deliver` 在第一个 `await` 前同步完成 `steer`，满足 serial 派发后机器重读 inbox 的语义 |
| 上限 | `maxBatchMessages`（1–50）/`maxBatchChars`（200–20000）：`partitionMessages` 取前缀，**第一条永远入批**；溢出消息计数、通知"本批第 N 条起共 M 条已转入后续处理"，并作为下一批**强制 followup** 继续投递（级联批次再溢出不再重复计数/提示） |
| 计数 | 成功后 `batchesMerged+1`、`messagesSteered/messagesFollowedUp += 本批实际提交条数`（不是批次总长）；`lastBatch` 记录 at/sessionKey/count/chars/mode/ok(/error) |
| 明确禁止 | 文件内无 `agent.cancel` / `ctx.abort` / `AbortController`；普通消息不解释为 `/stop` |
| 资源清理 | `dispose()` 清定时器与批次（由 `index.ts` 的 `ctx.effect` 注册） |

关键方法行号：`buildMergedBody:119`、`partitionMessages:143`、`noteTurnEnd:235`、`shouldBypass:252`、`submit:268`、`flushSession:316`、`flush:347`、`deliver:392`、`enqueueOverflow:430`。

### 3.3 `src/transport/reply-revision.ts`（新增，约 170 行）

`ReplyRevision` 状态机：`committed`（已定稿 step 前缀）+ `attempt`（当前 attempt 流式增量）+ 复用 `StreamingWriter`。

- `appendDelta`：流式帧增量；新 step 首帧前补 `\n\n`（与最终拼接一致）；
- `resetAttempt`：新 attempt（LLM 重试 / 下一 step）只清 attempt，保留前缀与已打开流式会话；
- `commitStep`：`assistant/message` 的权威文本 → 前缀 += `\n\n` + stepText → `writer.setBaseText(前缀)`（全量 update 同一条消息）→ `onRewrite()`；
- `finalize`：turn/end 才 `writer.finish()` → `complete()` 一次；若 `shouldFallback`（openStream 从未成功）→ 降级静态 `chunkMarkdownText` + `sendMarkdown` 一次；`onComplete()`；
- `cancel`：无文本/丢弃时 `writer.abort()`（关闭已打开会话，避免悬挂）。

### 3.4 `src/merge/service.ts`（新增，约 210 行）

`QqbotMergeRuntime implements QqbotMergeService, ReplyRevisionHooks`：

- `getStatus()`（`:137`）：契约 + 配置副本 + `applied`（revision/appliedAt/activeBatches/pendingMessages）+ `runtime` + `counters` + `lastBatch`；`runtime.note` 如实写"真实 QQ 端到端未验证 / 降级路径 / `/stop` 会清 inbox"；
- `setConfig()`（`:166`）：`applyMergeConfigPatch` 校验（类型/枚举/范围归一化，非法抛 `TypeError`）→ 应用到协调器与出站回复模式 → `persist({ qqbotMerge: next })` → revision+1、appliedAt 更新 → 返回新状态；持久化失败只 warn，不谎报；
- `enabledFor(record)`（`:184`）：`enabled && replyMode==='single-message' && scope[record.scope]`；
- `onRewrite/onComplete/onTurnEnd`：计入 `replyRewrites/repliesCompleted/batchesAborted`。

### 3.5 配置（`src/config.ts` + `cordis.patch.yml`）

- `ImQQBotConfig` 新增 `qqbotMerge: QqbotMergeConfig`（`config.ts:102`）；
- `QqbotMergeSchema`（`config.ts:114-124`）默认值 = 契约默认（**`enabled:false`**）；`ConfigSchema` 挂载（`config.ts:189`）；
- bundle patch 显式给出默认 `qqbotMerge` 块（`cordis.patch.yml:39-51`），用户也可只在 profile patch 里写差异字段。
- Schema 实测（构建产物 `dist/config.js`）：
  - `ConfigSchema({})` → `qqbotMerge = {"enabled":false,"windowMs":800,"maxBatchMessages":8,"maxBatchChars":4000,"scope":{"c2c":true,"group":false},"busyPolicy":"steer","replyMode":"single-message"}`；
  - `ConfigSchema({qqbotMerge:{enabled:true,windowMs:1500,scope:{group:true}}})` → 其余字段保持默认、`windowMs=1500`、`scope.group=true`。

---

## 4. 逐文件改动清单（文件 / 函数 / 行号 / 行为）

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/merge/contract.ts` | 1-197 | 新增：契约逐字复制（§3.1） |
| `src/merge/coordinator.ts` | 新增 ~470 行 | 合并协调器（§3.2） |
| `src/merge/service.ts` | 新增 ~210 行 | `qqbotMerge` 服务 + 回复 hooks（§3.4） |
| `src/transport/reply-revision.ts` | 新增 ~170 行 | 同轮单条回复状态机（§3.3） |
| `src/gateway/middleware-setup.ts` | `:27-34`（导入/接口）、`:103-116` | `setupMiddlewares(..., merge?)`；`concurrencyGuard` 增加 `urgentPredicate: mCtx => merge.shouldBypass(mCtx)`（仅 merge 存在时传；谓词内部再判 enabled+scope）。`strategy:'merge'` 保留作为未启用时旧行为 |
| `src/transport/inbound.ts` | `:14`（导入）、`:88-95`（签名/注释）、`:138-156` | `handleInbound(..., merge?)`；构建 user message 前分支：`merge.enabledFor(scope, senderId)` → `merge.submit(record, meta)` 成功则清群历史、`return`（**不** `followup`、**不** `whenIdle`）；否则保持原 `followup + whenIdle`（`:163-177`） |
| `src/transport/outbound.ts` | `:12,65-66,86-104,106-124` | 引入 `ReplyRevision`/hooks；每会话 `replies` Map；`usesSingleMessage`/`ensureReply`；构造函数与工厂新增可选 `replyRevision` 参数（`:362-371`） |
| 同上 | `:172-190` | `routeStreamFrame` 的 `attempt-start`：单条回复模式只 `reply.resetAttempt()`（保留消息与流式会话）；否则旧 buffer reset |
| 同上 | `:199-208` | `appendChunk`：单条回复模式进 `reply.appendDelta`，不建 OutboundBuffer |
| 同上 | `:220-236` | `onMessage`：单条回复模式只 `commitStep(stepText)`，**不 flush/finish/complete**；否则旧逻辑 |
| 同上 | `:300-340` | `onTurnEnd`：取出 reply → `finalize()`（无文本则 `cancel()`）→ `hooks.onTurnEnd(record, aborted)`；把 `replyTask` 并入 `Promise.all([flushTask,pending,replyTask])`，保证"文本 → 错误提示 → 交付文件"顺序；异常/中止同样收尾 |
| `src/transport/streaming-writer.ts` | `:24-31,53-59,76-84,133-160` | 新增 `baseText`（已定稿前缀）；`text` getter = base+attempt；新增 `setBaseText(text)`（写前缀 + 立即全量 update）；`reset()` 仍只清 attempt；`pushUpdate` 用 `base+attempt` |
| `src/session/types.ts` | `:34-40` | `DshAgent` 新增 `steer(message): void`（DSH 公开 API，见 §1.2） |
| `src/index.ts` | `:28-38` | `name='im-qqbot-merge'`；`provide=['qqbotMerge']`（仅声明，真正注册在 `apply`） |
| 同上 | `:55-83` | 创建 `MergeCoordinator` + `QqbotMergeRuntime`，**先于凭据判断** `services.provide('qqbotMerge', mergeRuntime)`；无 `provide()` 时 error 日志（不假装成功）；`ctx.effect` 注册 `coordinator.dispose()` |
| 同上 | `:112,119,137,141` | 把 `merge` 绑定传入两条 `bootstrapGateway` 路径 |
| `src/gateway/bootstrap.ts` | `:28-34`（`MergeGatewayBinding`）、`:70-78`（签名/中间件）、`:87`（入站）、`:114`（`attachBot`）、`:129-137`（出站 hooks） | 组装合并运行期 |
| 同上 | `:141-163` | 新增 `agent/turn-stopping` 全局监听：payload.agent → `manager.findByAgent` → `coordinator.flushSession(record)`（§3.2） |
| `src/config.ts` | `:3`（导入）、`:102`、`:114-124`、`:189` | `qqbotMerge` 类型 + Schema + 默认值 |
| `src/setup/persist.ts` | `:25`、`:64,76,121,169,181` | row id 常量化 `qqbot-merge`（凭据/解绑/配置三处持久化） |
| `src/setup/index.ts` | `:24` | 转出 `updateProfileConfig`（供服务持久化） |
| `src/gateway/index.ts` | `:2` | 转出 `MergeGatewayBinding` 类型 |
| `lib/client.js` | `:2,915` | 包名 id 改为 `dsh-qqbot-merge`（§2.3） |
| `cordis.patch.yml` | 全文 | row id/name 改 fork 名 + `qqbotMerge` 默认配置 + 互斥说明 |
| `vitest.config.ts` | 新增 | 独立 include `src/**/*.test.ts`（见 §7.2） |
| `src/merge/coordinator.test.ts` | 新增 28 tests | 窗口/续期/隔离/顺序/上限/溢出/steer vs followup/降级/群聊分组/urgentPredicate/turn-stopping/清理 |
| `src/merge/service.test.ts` | 新增 13 tests | 契约 v1、状态形状、setConfig 校验/归一化/持久化、replyMode 门控、hooks 计数 |
| `src/transport/outbound-revision.test.ts` | 新增 9 tests | 多 step 单条消息、turn/end 只 complete 一次、openStream 失败降级、群聊静态单发、异常/中止收尾、工具结果/交付文件顺序、hooks 关闭回归 |
| `src/transport/inbound.test.ts` | 新增 4 tests | 合并分支不 followup/whenIdle；submit=false 回落；未提供协调器旧行为；作用域未启用旧行为 |
| `src/setup/bind-routes.test.ts` | `:260,304` | fixture row id → `qqbot-merge`（唯一改动的上游测试） |

---

## 5. 结构化补充消息文案（真实运行输出，来自 status-probe）

`buildMergedBody()`（coordinator.ts:119）把本批消息按到达顺序拼成**一条** user message；下面是运行 `dist/` 构建产物、模拟 agent `running` 时连发两条后，`agent.steer(...)` 实际收到的 `content[0].text`：

```text
[连续补充消息 · 当前任务执行期间收到]
以下是当前任务执行期间收到的用户补充消息，按时间顺序排列（共 2 条）：

--- 第 1 条 · 2026-10-27T14:58:48.009Z · msgId=m1
报告改成周三交付

--- 第 2 条 · 2026-10-27T14:58:48.010Z · msgId=m2
另外把图表换成柱状图

请结合最初目标、已完成操作、真实工具结果与未完成工作继续；除非明确要求，否则不要把这些补充消息当作独立新任务；不要取消当前任务，不要重复已完成的副作用操作；完成后给出统一答复。
```

同一探针随后调用 `runtime.setConfig({windowMs:800})` 得到的 `getStatus()`（节选，完整 JSON 见 `.scratch/fork-impl/status-probe.log`）：

```json
{ "contract": {"name":"qqbot-merge","version":1},
  "config": {"enabled":true,"windowMs":800,"maxBatchMessages":8,"maxBatchChars":4000,
             "scope":{"c2c":true,"group":false},"busyPolicy":"steer","replyMode":"single-message"},
  "applied": {"revision":1,"appliedAt":"2026-10-27T14:58:48.267Z","activeBatches":0,"pendingMessages":0},
  "runtime": {"steerSupported":true,"steerMechanism":"agent.steer(input)…",
              "integration":"dsh-qqbot 0.5.3 fork + concurrencyGuard urgentPredicate bypass + agent/turn-stopping 收尾并入",
              "streamingRevision":true,"note":"真实 QQ 端到端未验证…"},
  "counters": {"batchesMerged":1,"messagesSteered":2,"messagesFollowedUp":0,"messagesOverflowed":0,
               "steerFallbacks":0,"replyRewrites":0,"repliesCompleted":0,"batchesAborted":0},
  "lastBatch": {"at":"2026-10-27T14:58:48.115Z","sessionKey":"c2c:user-openid-1",
                "count":2,"chars":18,"mode":"steer","ok":true} }
```

`setConfig` 的持久化调用参数（真实输出）：`[{"qqbotMerge":{"enabled":true,"windowMs":800,…}}]` —— 只写本插件自己的 `qqbotMerge` 字段。

---

## 6. 行为边界与竞态

### 6.1 忙碌 / 空闲判定

- flush 时**重新**读取 `record.agent.status`；submit 时不缓存（窗口期内状态会变）。
- `running` + `busyPolicy='steer'` + 非溢出批次 → steer；其余 → followup。一批只提交一条消息。
- `enabled=false` 时：`enabledFor` 恒 false → `urgentPredicate` 恒 false → 入站/出站完全走官方 0.5.3 路径（上游 156 条测试即回归证明）。

### 6.2 降级与不丢弃

- steer 抛错 → `steerFallbacks+1` → followup（若成功则批次成功，`lastBatch.mode='followup'`）。
- followup 也抛错 → `lastBatch.ok=false` + 通知用户（`bot.sendMarkdown`）。
- 超上限 → 前 N 条本批，其余：计数 + 通知 + 新批次强制 followup（级联溢出不重复计数/提示）。
- 无 bot（凭据未就绪）时通知降级为 `logger.warn`，但消息仍排队投递。

### 6.3 `agent/turn-stopping` 并入当前轮

- 监听全局 `agent/turn-stopping`（payload 自带 `agent`，见 dsh-agent `agentEvents` fused payload）。
- 对该会话所有**普通**待处理批次（不含溢出批次）：清定时器 → `flush` → 在监听器调用栈内同步 `steer`。
- 效果：消息在"窗口未到期但轮次正在收尾"时并入同一 turn 的下一个 step；溢出批次仍按自己的窗口/强制 followup 语义处理（避免打乱"后续处理"顺序）。

### 6.4 已知遗留竞态（**未实现兜底，如实记录**）

`docs/evidence/dsh-agent-api-steering.md` §0 第 9 条指出：steer 若落在"turn 已判定结束、phase 尚未转 idle"的微任务缝隙，消息会停在 `next-step` 且**不自动唤醒**（不丢、不抛错）。该文建议的兜底需要访问 inbox（`await whenIdle()` 后检查自己的消息仍在 inbox → `inbox.remove(id)` → 重新 steer），但：

- `inbox` 是 `ReactLoopAgent` 的内部字段，**不在公开 Agent API**（公开面只有 `status/steer/followup/cancel/whenIdle/runMaintenance`）；
- 在 coordinator 里 `await whenIdle()` 会把入站链路重新阻塞（正是本任务要消除的旧行为），且无法区分"消息已被消费"与"消息仍停在 inbox"，盲目重发会**重复执行副作用**。

因此本实现选择：用 `agent/turn-stopping` 把竞态窗口压到最小 + steer 抛错降级 + 文档标注，**不写看起来生效的 inbox 操作**。若后续宿主公开 inbox 操作接口（或 `steer` 返回值暴露投递状态），可按上述方案补齐。

### 6.5 `/stop` 与取消

- 本实现从不调用 `agent.cancel`；用户 `/stop` 仍走官方 slash 命令（`agent.cancel({kind:'user'})`），按 DSH 语义**清空 inbox** → 已 steer 但未被消费的批次会被丢弃（符合"用户主动停止"预期，已在 `runtime.note` 与本文档写明）。
- 仍在合并窗口内、尚未提交的批次不受 `/stop` 影响：窗口到期后若 agent 已 idle → followup 起新轮（消息不丢）。
- turn/end 一定到达：单条回复在 `turn/end`（含 `kind:'aborted'` / `error`）时也会 finish/complete 或降级静态发送，不会悬挂流式会话。

### 6.6 其他边界

| 场景 | 行为 |
|---|---|
| 群聊默认 | `scope.group=false` → 不接管，`urgentPredicate` false |
| 群聊启用 | 批次键含发送者：不同发送者各自成批；flush 仍用同一 QQ 会话 record（steer/followup 到同一个 agent） |
| 流式不可用 | 群聊/无 `msgId`/`config.streaming=false`/`openStream` 失败 → 轮末单条静态发送；长文按 `textChunkLimit` 切分（唯一会拆成多条的情形，属 QQ 单条长度限制） |
| HMR 重载 | `setConfig` 写 profile patch（本插件行）会触发宿主 HMR；重载时 `coordinator.dispose()` 清空未 flush 批次（这些消息会丢，日志有记录）。运行时 revision 归 0，从 row config 重新应用 |
| 计数 | 进程内计数，重启/重载归零（契约注明） |

---

## 7. 构建

### 7.1 命令与结果

```powershell
cd D:\dsh-memory-vault\extensions\dsh-qqbot-merge
npm install                        # 本机 registry.npmmirror.com
npm run build                      # tsc -p tsconfig.json
npm test                           # vitest run
npm pack --pack-destination D:\dsh-memory-vault\.scratch\fork-impl
```

- 环境：Node **v24.13.0**、npm **11.6.2**、registry `https://registry.npmmirror.com`（本机 `~/.npmrc`）。
- `npm run build` → 输出 `dist/**`（256 files 含 `.d.ts`/`.map`），**exit 0，0 error**（日志 `.scratch/fork-impl/build.log`）。
- 官方仓库原 `build` 是 `tsc && tsdown --config tsdown.client.config.ts`；fork 只需 host 构建，客户端 bundle 用官方 0.5.3 产物（§2.3），`build:client` 脚本仍保留。

### 7.2 两个本机环境坑（已解决，记录以免误判为实现问题）

1. **vitest 配置被宿主仓库"继承"**：宿主 `D:\dsh-memory-vault\vitest.config.ts` 把 `include` 限定为 `tests/**/*.test.ts`，在扩展目录直接跑 `vitest` 会报 `No test files found`。→ 新增扩展自己的 `vitest.config.ts`（`include: ['src/**/*.test.ts']`，串行）。
2. **首次 `npm install` 产生不完整的 linked 布局**：本机 npm 首次安装把依赖放进了 `node_modules/.pnpm`，其中 `ws`/`qrcode-terminal`/`@deepseek-ai/cosmokit` 等内容缺失，导致 3 个上游测试文件 import 失败（`Cannot find package 'ws' …`）。→ 删除 `node_modules` 与生成的 lock 后用 `npm install --install-strategy=hoisted` 重装（**126 packages**），全部通过。该问题与 fork 代码无关；干净环境直接 `npm install` 即可。

---

## 8. 测试

### 8.1 结果

| 项 | 值 |
|---|---|
| 命令 | `npm test`（= `vitest run`，配置见 `vitest.config.ts`） |
| 结果 | **Test Files 17 passed (17)** / **Tests 210 passed (210)**，exit 0（日志 `.scratch/fork-impl/test.log`） |
| 新增测试 | 54 条：`src/merge/coordinator.test.ts` **28**、`src/merge/service.test.ts` **13**、`src/transport/outbound-revision.test.ts` **9**、`src/transport/inbound.test.ts` **4** |
| 上游回归 | 156 条上游测试全部保留并通过（含 `outbound.test.ts` 14、`streaming-writer.test.ts` 12、`outbound-buffer.test.ts` 5、`bind-routes.test.ts` 25、`binding-service.test.ts` 8 等） |
| 上游测试改动 | 仅 `src/setup/bind-routes.test.ts:260,304` 的 fixture row id（`im-qqbot` → `qqbot-merge`），原因见 §2.4 |

### 8.2 新增测试覆盖点

**coordinator（28）**：结构化文案（顺序/时间/发送者/约束句）、`partitionMessages`（条数/字符/首条保留）、窗口合并与顺序、debounce 续期（旧句柄取消）、会话隔离、忙碌 steer（不 followup/不 cancel）、空闲 followup、flush 前重查 status、`busyPolicy='queue'`、steer 抛错降级、followup 失败通知、条数上限溢出（通知+级联 followup+计数不重复）、字符上限溢出、群聊默认不接管、群聊按发送者分组、私聊 scope 关闭、总开关关闭、`shouldBypass` 各上下文、`turn-stopping` 同步 steer、flushSession 只影响本会话、空操作安全、aborted 计数、dispose 清理、配置归一化。

**service（13）**：契约 `qqbot-merge@v1`、状态形状（applied/runtime/counters/lastBatch null）、getConfig 副本隔离、setConfig 应用+revision+持久化字段、非法值拒绝（类型/枚举/scope）、归一化夹值、持久化失败仍生效但 warn、`enabledFor` 门控（enabled/replyMode/scope）、hooks 计数、`applyMergeConfigPatch` 部分合并/拒绝非对象。

**outbound-revision（9）**：多 step 单条流式消息（openStream 1 次、assistant/message 不 complete、中间 update 全量含两段、turn/end complete 恰好 1 次）、重复 turn/end 不重复 complete、`openStream` 失败 → 中间不发、轮末只发一次、群聊静态单发一次、异常轮"文本先于错误提示"、aborted 保留 partial 并 complete、工具错误独立即时发送、交付文件在文本之后、hooks 关闭时恢复上游 per-step（complete 2 次）。

**inbound（4）**：合并分支只 `submit`（不 followup/whenIdle，meta.body 正确）、`submit` 返回 false 回落、未提供协调器旧行为、作用域未启用旧行为。

### 8.3 运行期探针（超出单测的真实构建产物验证）

- `.scratch/fork-impl/status-probe.mjs`：用 `dist/` 实例化 `MergeCoordinator + QqbotMergeRuntime`，模拟 agent `running` + 两条消息 → **1 次 steer**、结构化文案、`getStatus()` 与契约一致、`setConfig` 持久化参数（输出见 §5 与 `.scratch/fork-impl/status-probe.log`）。
- `.scratch/fork-impl/provide-probe.mjs`：真实 cordis 提供/消费（§1.3）。

---

## 9. 打包与安装验证

| 项 | 值 |
|---|---|
| 产物 | `D:\dsh-memory-vault\.scratch\fork-impl\dsh-qqbot-merge-0.1.0.tgz` |
| 大小 | **1,109,795 B**（package size 1.1 MB / unpacked 1.8 MB） |
| 文件数 | **282**（`src/` 与 `node_modules/` 均不在包内 —— 继承上游 `.npmignore: src/`；含 `dist/**`、`lib/client.js(+map)`、`cordis.patch.yml`、`LICENSE`、`locale/`、`assets/`） |
| SHA256 | `0C7FEB88695C64CE6AD5375EB9B7AB2CD1E884F0BE5CFF00BF0405F984529714` |
| npm shasum | `ecb64f2d849fc7a5ede13f61b15a178e115d2333` |
| 内容抽查 | `package/dist/index.js`、`package/dist/merge/{contract,coordinator,service}.js`、`package/dist/transport/reply-revision.js`、`package/lib/client.js`、`package/cordis.patch.yml`（row `qqbot-merge`）、`package/LICENSE` |
| 安装冒烟 | 新建临时目录 `npm init -y` + `npm install <tgz>` → **added 50 packages**，`node_modules/dsh-qqbot-merge/{dist/index.js,lib/client.js,cordis.patch.yml}` 均存在，`version=0.1.0`；`import('dsh-qqbot-merge')` → `name=im-qqbot-merge, apply=function, provide=["qqbotMerge"]`；`require.resolve('dsh-qqbot-merge/client')` 解析到 `lib/client.js` 且 `id: "dsh-qqbot-merge"`（冒烟目录 `.scratch/fork-impl/install-smoke/`，pack 日志 `.scratch/fork-impl/pack.log`） |

---

## 10. 未验证项与风险（必须如实告知用户）

| # | 未验证 / 风险 | 说明与影响 |
|---|---|---|
| 1 | **真实 QQ 端到端全部未验证** | 约束要求不安装到真实 profile、不替换用户正在运行的官方插件。QQ 侧能看到的实际效果（消息条数、修订频率、群聊降级表现、`/stop` 行为）没有验证 |
| 2 | `agent/turn-stopping` 的真实触发时序 | 已按 asar 源码事实与单测实现；真实宿主中的派发是否总能覆盖"窗口未到期"的场景未实测 |
| 3 | 流式修订的客户端表现 | 同一 round 多次 `update` 全量重写同一条 QQ 流式消息：QQ 客户端是否闪烁、是否有 update 频率/长度限制、`complete` 后是否保留最终文本——未验证 |
| 4 | steer 竞态（§6.4） | 公开 API 无 inbox 操作，自唤醒兜底未实现；极端微任务窗口下消息可能停到下一次 wake（不丢、不报错） |
| 5 | `/stop` 会丢已并入但未消费的批次 | DSH `cancel` 默认清 inbox；属官方语义，已在 runtime.note 与本文档写明 |
| 6 | 配置写入触发 HMR | `setConfig` 写本插件 profile row 会触发插件重载（QQ 连接重建），正在合并窗口内的消息会丢（日志记录）。与官方插件"保存配置即重载"一致 |
| 7 | 与官方插件互斥 | row id/包名不同，可同时装上，但会双连接同一 appId 且绑定页路由同名 → 必须停用/移除官方插件后再启用本包 |
| 8 | 客户端 bundle 未重新构建 | 仅改 id 字符串；若上游源码与 0.5.3 产物有差异（我们按 0.5.3 安装产物复制）未核对，UI 行为应无变化 |
| 9 | `dsh.compatibility` 未申报 0.2.1-rc.3 | 继承上游声明；宿主安装门槛由 `peerDependencies` 判定（0.2.1-rc.3 满足），但"官方已验证"语义不应外推到本 fork |
| 10 | 编译产物未做真实 profile 解析 | 包内 peerDeps `@deepseek-ai/cordis/dsh-*` 由宿主 profile 提供；在真实 profile 中模块解析未实测（与官方 0.5.3 相同的解析方式） |

---

## 11. 安装 / 替换（仅在用户明确授权后执行）

> 前置：**先停用/移除官方插件**，避免双连接与路由冲突；不要在本机验证期间直接替换用户正在运行的插件。

1. **备份 profile**（例如复制 `C:\Users\bf410\.dsh\profiles\desktop\package.json`、`cordis.patch.yml`）。
2. **移除/禁用官方插件**（二选一）：
   ```powershell
   npx @deepseek-ai/dsh plugin --profile desktop remove @tencent-connect/dsh-qqbot
   # 或在 profile cordis.patch.yml / bundle 行里把 im-qqbot 行 disabled: true
   ```
3. **安装本 fork**（支持本地 tgz 绝对路径；`@deepseek-ai/dsh-plugin-manager` 的 `parseInstallSpec` 明确支持 tarball）：
   ```powershell
   npx @deepseek-ai/dsh plugin --profile desktop add "D:\dsh-memory-vault\.scratch\fork-impl\dsh-qqbot-merge-0.1.0.tgz"
   ```
4. **重启 DSH**（插件安装/`cordis.patch.yml` 变更需要重载；本任务期间未执行）。
5. **确认生效**：
   - 插件清单出现 `dsh-qqbot-merge@0.1.0`，profile `package.json` 依赖表出现该包；
   - 启动日志出现 `qqbotMerge service provided (contract qqbot-merge@v1)`（`src/index.ts:73`）；
   - QQ 绑定/扫码流程照旧（或把 `appId/appSecret` 写进 profile `cordis.patch.yml` 的 `qqbot-merge` 行）；
   - Memory Vault 的 QQ 合并页不再显示 BLOCKED，`available:true`、`compatible:true`、`applied.revision≥1`，计数随真实消息增长。
6. **打开合并**（默认关闭）：通过 Memory Vault 页面 `setConfig`，或在该 profile `cordis.patch.yml` 的 `qqbot-merge` 行写：
   ```yaml
   - id: qqbot-merge
     config:
       qqbotMerge:
         enabled: true
         windowMs: 800
         scope: { c2c: true, group: false }
         busyPolicy: steer
         replyMode: single-message
   ```
7. **验收建议（最小）**：私聊发一条长任务 → 执行中连发两条补充 → 观察 (a) 只有一次结构化补充并入（steer），(b) 同一轮只有一条 QQ 回复被持续修订，(c) 页面 counters：`batchesMerged/messagesSteered` 增长、`lastBatch.mode='steer'`。

## 12. 回滚

```powershell
npx @deepseek-ai/dsh plugin --profile desktop remove dsh-qqbot-merge
npx @deepseek-ai/dsh plugin --profile desktop add @tencent-connect/dsh-qqbot@0.5.3
# 恢复 profile 备份中的 package.json / cordis.patch.yml（如有手工编辑）
```
行为回滚（不卸载）：Memory Vault 页面把 `qqbotMerge.enabled` 设为 `false`（或在 row config 写 `enabled: false`）→ `urgentPredicate` 恒 false、出站不走单条回复，等价官方 0.5.3。

## 13. 证据文件索引（`.scratch/fork-impl/`）

| 文件 | 内容 |
|---|---|
| `dsh-qqbot-merge-0.1.0.tgz` | 最终安装包（§9） |
| `build.log` / `test.log` / `pack.log` | 最终 `npm run build` / `vitest run` / `npm pack` 原始输出 |
| `status-probe.mjs` / `status-probe.log` | 运行期探针：窗口合并→steer、结构化文案、`getStatus()` 真实 JSON、`setConfig` 持久化参数 |
| `provide-probe.mjs` | 真实 cordis `provide/inject` 双顺序探针输出（§1.3） |
| `install-smoke/` | tgz 安装冒烟（entry/`./client` 解析） |
| `probe-agent-loop.cjs` | 从宿主 asar 读取 `dsh-agent-loop` 关键行（steer/followup/status/turn-stopping） |
| `dump-asar-file.cjs` / `dump-cordis-src.cjs` / `probe-cordis.cjs` / `probe-provide.cjs` / `probe-compat.cjs` | asar/cordis 只读探针（本报告行号与 API 事实的取证工具） |

> 源码来源核对命令（可复现，证明"未改文件 == GitHub tag 0.5.3"）：
> ```powershell
> foreach($f in @('src/session/session-manager.ts','src/transport/chunker.ts')) {
>   $r=(Invoke-WebRequest "https://raw.githubusercontent.com/tencent-connect/dsh-qqbot/0.5.3/$f" -UseBasicParsing).Content
>   # 与 extensions/dsh-qqbot-merge/$f 做换行归一后逐字节比较 → IDENTICAL
> }
> ```



