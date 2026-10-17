# dsh-free-api-pool

DeepSeek Harness 插件：把各大平台**长期可白嫖的免费 API 额度**集中到一个面板里，并且**管理你自己的密钥**。

输入框左侧一个「免费 API 池」按钮，点开是四页仪表盘。

界面字体：**MiSans**（小米）。优先用本机安装的 MiSans，缺失时从 CDN 加载 400/500/600 三个字重，再回退到系统 UI 字体 —— 不会掉到衬线或点阵字体。

## 功能

### 0.0 免费池模型选择器

输入框的模型按钮旁边多了一个 **免费池** 按钮，点开就是模型选择面板（和宿主主题完全一致）：

- 按厂商分组，默认顺序 **OpenRouter → Google AI Studio → Groq → Mistral → 其他大厂 → 自己导入的中转站**
- 每组右上角 **↑↓** 可调顺序，顺序记在本地
- 顶部搜索框实时过滤模型
- 先显示已缓存的厂商（约 50ms），其余边探测边出现，不用等全部拉完
- 查不到的厂商直接写明原因，不再是一句「异常」

### 0.1 导入自动去重

导入 FreeLLMAPI 文件时**按 Key 去重**，只补缺的部分：

- 导入 A 再导入 B（B 是 A 的子集）→ 新增 0 条
- 先导 B 再导 A（A 只多一个 Key）→ **正好新增 1 条**
- 重复导入同一个文件 → 新增 0 条
- 文件内部的重复行也只算一条

## 功能

### 0. 一个平台，多个 Key

同一厂商可以加任意多个 Key（例如 Groq 主号 + 小号 + 小号2）：

- **收起** 显示所有账号的**合计额度**（`剩余总量（合计）`）
- **展开**（点卡片左侧箭头）逐条显示每个账号的剩余、已用、速率窗口，可单独测速 / 删除

导入的第三方中转站会按 Base URL 各自成卡片，同名不同站不会混在一起；同一站点的多个 Key 会正确合并。

### 1. 秒开，不等待（0.4.0）

打开面板只读本地 vault，**不发起任何网络请求**：162 个 Key / 156 张卡片实测 **14–40 ms** 渲染完成。

额度按需查询：

- 卡片上的「探测」按钮 → 只查这一张
- 顶部「刷新额度」 → 查 39 家内置厂商（不含导入的第三方中转）
- 结果缓存 5 分钟；连不通的站点记 10 分钟，同一站点后续的 Key 直接返回，不再逐个超时

> 为什么改：之前每次打开都会同步探测全部 156 张卡片。实测 **113 / 135 个导入的中转站根本连不上**，每个等 8 秒超时，一次刷新要 **101 秒**。这些站点用户大概率永远不看，不该让它们挡住启动。

### 2. 免费额度池 —— 真实数字，不猜

每个平台一行，显示 `剩余总量 / 今日剩余 / 已用 / 今日已用`。**只有平台真的提供了数字才显示**，没有余额接口的平台明确写「需控制台」，不会编造一个余额。

- **Groq / GitHub Models**：读 `x-ratelimit-*` 响应头，显示真实的每分钟请求数 / token 剩余（Groq 会发一个 `max_tokens:1` 的探针请求换取实时头部）
- **OpenRouter**：`/api/v1/key` + `/credits`，显示免费层状态、已用金额、当前免费模型数
- **Kimi / Moonshot**：`/users/me/balance`，显示代金券 + 现金余额
- **one-api / new-api 中转站**：读账单接口的累计已用；`hard_limit_usd: 1e8` 是「不限额度」的占位值，识别出来不会当成九位数余额
- **Cloudflare / sharedchat** 等没有余额接口的：标注「需控制台」

### 3. 免费模型 —— 每日自动探测，标注限免 / 长期免费

- **OpenRouter**：拉全量模型清单，按 `pricing.prompt === 0 && pricing.completion === 0` 筛出真正免费的模型（实测 470 个模型里 19 个免费）
- **OpenCode Zen**：按 `-free` 后缀筛（实测 85 个里 9 个免费）

每个模型带「长期免费 / 每日刷新 / 新用户赠额」标签和上下文长度。点「重新探测」随时刷新。

### 4. 密钥管理 —— 填 Key 自动读模型 ID

- 选平台 → **Base URL 自动填好**（39 家大厂已内置）→ 填 Key → 点「读取模型 ID」，插件真的去请求该平台的 `/models` 接口，把模型 ID 列表拉回来
- 保存后只显示掩码（`gsk_RE…0dUP`），Key 存在本机 `data/vault.json`
- 支持**删除**单条、**导入 / 导出**
- 自定义平台也能用：平台选「自定义」，填 Base URL + Key 即可

### 4.2 导入 / 导出 —— 兼容 FreeLLMAPI

导出格式与 [FreeLLMAPI](https://github.com/) 的 vault 完全一致，两边可以互相导：

```json
{
  "version": 1,
  "exportedAt": "2026-10-18T00:00:00.000Z",
  "source": "freellmapi",
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "主号", "baseUrl": "https://api.groq.com/openai/v1" },
    { "platform": "custom", "key": "sk-...", "label": "我的中转站", "baseUrl": "https://relay.example.com/v1" }
  ]
}
```

- **导出**：`platform`（厂商 ID 或 `custom`）+ `key` + `label`（你的备注名）+ `baseUrl`，一个不少
- **导入**：直接吃 FreeLLMAPI 导出的文件。认识的厂商映射到内置目录，不认识的按 `custom` + 它自带的 `baseUrl` 建卡
- 重复 Key 自动跳过（实测导入 166 条 → 新增 159、跳过 7 条缺 baseUrl 的自定义条目）
- 导出再导回完全无损（159 → 159）

### 4.5 Token 测速 —— 实测首字延迟与吞吐

每条已保存的 Key 都有「测速」按钮，真发一次流式请求并测量：

| 指标 | 含义 |
|---|---|
| **首字延迟** | 从发请求到收到第一个 token 的毫秒数（决定交互体感） |
| **输出速度** | 生成阶段的 tok/s（`tokens ÷ 生成耗时`） |
| **总耗时** | 整个请求的墙钟时间 |
| **输出 token** | 优先用上游 `usage.completion_tokens`，没有才数增量帧（标「估」） |

结果带评级标签：**极快** (<600ms) / **良好** (<1500ms) / **一般** (<3000ms) / **偏慢**。

实现要点：
- 测的是 SSE 流本身，不是非流式响应 —— 只有流式才能量出真实的 TTFT，非流式会把 10 秒卡顿藏在一个漂亮的总额里
- 推理模型（如 Groq 的 `gpt-oss`）把思考内容放在 `delta.reasoning`，正文在 `delta.content`，**两者都算首 token**，否则推理模型的 TTFT 会永远测成 null
- 不指定模型时自动挑该平台第一个**聊天**模型，跳过 guard / embedding / TTS / 图像类模型（它们不支持流式或不出文本）
- 45 秒超时；失败也返回已测到的部分数据，不会静默吞掉

### 5. 平台目录 —— 一键去申请

39 家平台，每家带**官方密钥申请页**（全部实测 HTTP 200 可访问），点「申请」在新标签打开。按「长期免费 / 每日刷新 / 新用户赠额」筛选。

### 6. 一键签到

支持签到赠额的中转站。目前：
- **sharedchat 公益站**：每日签到送 $50 Codex 额度（已实现并验证可用）
- **AgentRouter / 新疆幻城**：走 one-api 登录 + 签到接口；新疆幻城需 Cloudflare 人机验证，会给出明确提示而不是静默失败

## 为什么有些平台显示「异常」

面板现在会写明具体原因，这些不是插件的 bug：

| 显示 | 真实原因 | 能不能修 |
| --- | --- | --- |
| 被 Cloudflare 拦截（浏览器挑战页） | 站点对非浏览器请求返回 403 挑战页（Cerebras、Cohere 等） | 换网络环境或走代理 |
| Key 被拒绝或地区受限（HTTP 403） | Groq 等对部分地区直接 403，与 Key 无关 | 需要能访问该地区的网络 |
| 探测超时（8 秒） | 域名在当前网络下连不通（Mistral、HuggingFace 等） | 换网络环境 |
| Key 无效或未启用（HTTP 401） | Key 确实无效或没开通该接口 | 去控制台重新生成 |
| 接口路径不存在（HTTP 404） | Base URL 填错 | 改 Base URL |

在作者机器上实测 22 个有 Key 的厂商：**12 个正常**，4 个超时，3 个 403，2 个 Cloudflare 挑战，1 个 405。也就是说大部分「异常」是网络可达性问题，不是代码问题。

## 界面 —— 完全跟随 DSH 主题

面板的颜色、字体、圆角全部取自宿主的设计 token，没有一处硬编码：

| 用途 | token |
| --- | --- |
| 面板 / 卡片 / 下沉底色 | `--dsw-alias-bg-layer-1` / `-3` / `-2` |
| 主 / 次 / 三级文字 | `--dsw-alias-label-primary` / `-secondary` |
| 描边 | `--dsw-alias-border-l1` / `-l2` |
| 主按钮 | `--dsw-alias-button-primary-fill` + `label-primary-foreground` |
| 成功 / 异常 / 警告 | `--dsw-alias-state-success-primary` / `-error-primary` / `-warn-label` |
| 字体 / 等宽字体 | `--dsw-font-family`、`--dsw-font-markdown-code` |

浅色、暗色、跟随系统三种模式都无需单独适配，文字颜色永远和宿主一致。

**对比度实测**（按 token 真实取值算，非估算）：

| | 浅色 | 暗色 |
| --- | --- | --- |
| 正文 | 18.9:1 AAA | 15.0:1 AAA |
| 次要文字 / 提示 | 5.8:1 AA | 10.4:1 AA |
| 选中页签 | 18.9:1 AAA | 15.0:1 AAA |
| 主按钮 | 18.9:1 AAA | 18.1:1 AAA |

> 为什么改：之前硬编码 `#0065fd` 配 10% 蓝填充，并且给面板装了 MiSans 网络字体。DSH 的 `brand-primary` 实际解析成近黑色，所以"蓝字压蓝底"在暗色下几乎看不见；网络字体没下载完之前先渲染系统字体，就是"字都是糊的"的来源。现在字体完全交给宿主，没有加载闪烁。


## 内置平台

| 平台 | 免费类型 | Base URL |
|---|---|---|
| Groq | 长期免费（限速） | `https://api.groq.com/openai/v1` |
| Google AI Studio | 长期免费（限速） | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Cerebras | 每日刷新 | `https://api.cerebras.ai/v1` |
| OpenRouter | 每日刷新 | `https://openrouter.ai/api/v1` |
| OpenCode Zen | 每日刷新 | `https://opencode.ai/zen/v1` |
| Mistral | 长期免费 | `https://api.mistral.ai/v1` |
| GitHub Models | 长期免费 | `https://models.github.ai/inference` |
| Cloudflare Workers AI | 每日刷新 | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` |
| Hugging Face | 新用户赠额 | `https://router.huggingface.co/v1` |
| 智谱 GLM | 长期免费 | `https://open.bigmodel.cn/api/paas/v4` |
| 硅基流动 | 长期免费 | `https://api.siliconflow.cn/v1` |
| 阿里云百炼 | 新用户赠额 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 魔搭 ModelScope | 每日刷新 | `https://api-inference.modelscope.cn/v1` |
| Kimi 月之暗面 | 新用户赠额 | `https://api.moonshot.cn/v1` |
| NVIDIA NIM | 新用户赠额 | `https://integrate.api.nvidia.com/v1` |
| 阶跃星辰 StepFun | 新用户赠额 | `https://api.stepfun.com/v1` |
| LongCat 美团 | 每日刷新 | `https://api.longcat.chat/openai/v1` |
| 商汤日日新 | 新用户赠额 | `https://token.sensenova.cn/v1` |
| Together AI | 新用户赠额 | `https://api.together.xyz/v1` |
| Cohere | 长期免费 | `https://api.cohere.ai/compatibility/v1` |
| SambaNova | 长期免费 | `https://api.sambanova.ai/v1` |
| Nebius AI Studio | 新用户赠额 | `https://api.studio.nebius.ai/v1` |
| AMD Radeon | 长期免费 | `https://developer.amd.com.cn/radeon/api/v1` |
| 蚂蚁百灵 Ling | 长期免费 | `https://api.ant-ling.com/v1` |
| Agnes AI | 以站内为准 | `https://apihub.agnes-ai.com/v1` |
| AgentRouter | 中转站（签到） | `https://agentrouter.org` |
| 新疆幻城网安 | 中转站（签到） | `https://api.hcnsec.cn/v1` |
| sharedchat Codex | 每日签到 $50 | `https://new.sharedchat.cc/codex` |

## 安装

插件放在 DSH profile 的 `dsh-free-api-pool` 目录下，并在 `package.json` 里注册：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-free-api-pool": "link:C:/Users/<you>/.dsh/profiles/<profile>/dsh-free-api-pool"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其它 bundle
        "dsh-free-api-pool"
      ]
    }
  }
}
```

重启 DeepSeekHarness 生效。

## 配置

### Auto 的选法

每个 profile 有**自己的厂商偏好顺序**和**自己的评分函数**，两者都写在
`lib/index.js` 的 `AUTO_MODELS` / `PROFILE_PREFERENCE` 里，可以直接改。

| Profile | 偏好顺序 | 打分依据 |
| --- | --- | --- |
| **Auto** | OpenRouter → Google → Groq → Mistral → Cerebras → … | 厂商等级 × 20 + 模型规模，取最高 |
| **Auto-Fast** | Groq → Cerebras → Google → OpenRouter → … | 厂商延迟等级 × 100；小于 20B 的模型直接扣 200 分 |
| **Auto-Cheap** | Google → Groq → OpenRouter → … | 真免模型 +1000，长期免费 +200，再看厂商等级 |
| **Auto-Code** | OpenRouter → Google → Groq → … | 命中代码模型系列 +1000（deepseek/qwen/coder/claude/glm…） |
| **Auto-Write** | Google → OpenRouter → Mistral → … | 长上下文 +500，写作向模型 +400 |

延迟等级是按实测行为定的，不是厂商宣传：

- **3** = 自建推理硬件（Groq LPU、Cerebras WSE）
- **2** = 有专属端点的一线云（Google、OpenRouter、Mistral）
- **1** = 聚合转发
- **0** = 以排队著称的（NVIDIA NIM、Ollama、HuggingFace）

**失败会自动换下一个**：402（没额度）、429（限流）、5xx、以及「HTTP 200 但 body 里是 error」
（OpenRouter 免费模型过载时就返回这个）都会跳下一个候选，最多试 12 个。响应头
`x-dfp-route` 会写明最终用了谁，`x-dfp-fallbacks` 是跳过了几个。

调试：`POST /dsh-free-pool/v1/route?profile=auto-fast` 返回当前会选谁、以及被跳过的厂商。

### Auto 网关（可选，推荐）

插件自带一个 OpenAI 兼容端点 `http://127.0.0.1:51373/dsh-free-pool/v1`，装好后在
`cordis.patch.yml` 里加一个 provider 即可让 Auto 出现在模型列表：

```yaml
      dfp-auto:
        displayName: 免费池 Auto
        apiKeyEnv: DFP_POOL_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:51373/dsh-free-pool/v1
        models:
          - id: auto
            name: Auto（自动选择）
          - id: auto-fast
            name: Auto-Fast（最快）
          - id: auto-cheap
            name: Auto-Cheap（最省额度）
          - id: auto-code
            name: Auto-Code（写代码）
          - id: auto-write
            name: Auto-Write（写文章）
```

并在 `~/.dsh/.credentials.yaml` 里放一行占位（网关不校验 Key）：

```yaml
DFP_POOL_KEY: local-gateway
```

> 端口要和 DSH 的 Web GUI 端口一致。查看方式：设置里的 Web GUI 地址，或 `127.0.0.1:51373`。

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-free-api-pool
      name: dsh-free-api-pool
      config:
        # 可选：中转站签到用的账号密码 CSV（name,url,username,password）
        credentialsFile: 'C:\path\to\accounts.csv'
```

## 密钥存在哪

`data/vault.json`，**只在主机进程内读取，不会发给浏览器**（面板只拿得到掩码）。导出功能是唯一会返回明文的路由，需要用户主动点「导出全部」。

`.gitignore` 已排除 `data/vault.json`，所以 fork 或上传不会带出你的 Key。

## 安全说明

- 插件只监听 DSH 自己的 `webServer` 路由（`/dsh-free-pool/*`），不额外开端口
- 不上传任何数据到第三方，所有请求直接发往各平台官方接口
- 面板里显示的账号信息只有用户名，不显示密码

## 开发

`test/` 下有一个独立的 UI 测试台，可以不开 DSH 就渲染真实面板：

```bash
node test/server.mjs      # http://127.0.0.1:8791
```

- `?demo=add` 会预填表单并高亮「填 Key → 读模型 ID」这条链路
- 测试台用真实的 `lib/client.js`，只把主机侧路由换成固定 fixture

## 目录结构

```
dsh-free-api-pool/
├── cordis.patch.yml       # bundle 层
├── package.json           # dsh.client 声明 → 浏览器半自动加载
├── data/
│   ├── providers.json     # 39 家平台目录（Base URL / 申请页 / 免费类型）
│   └── vault.json         # 你的密钥（gitignored）
├── lib/
│   ├── index.js           # 主机半：路由、额度探测、模型发现、签到
│   └── client.js          # 浏览器半：按钮 + 四页仪表盘
└── test/
    ├── server.mjs         # UI 测试台
    └── harness.html
```

## License

MIT
