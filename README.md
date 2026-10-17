# dsh-free-api-pool

DeepSeek Harness 插件：把各大平台**长期可白嫖的免费 API 额度**集中到一个面板里，并且**管理你自己的密钥**。

输入框左侧一个「免费 API 池」按钮，点开是四页仪表盘。

## 功能

### 1. 免费额度池 —— 真实数字，不猜

每个平台一行，显示 `剩余总量 / 今日剩余 / 已用 / 今日已用`。**只有平台真的提供了数字才显示**，没有余额接口的平台明确写「需控制台」，不会编造一个余额。

- **Groq / GitHub Models**：读 `x-ratelimit-*` 响应头，显示真实的每分钟请求数 / token 剩余（Groq 会发一个 `max_tokens:1` 的探针请求换取实时头部）
- **OpenRouter**：`/api/v1/key` + `/credits`，显示免费层状态、已用金额、当前免费模型数
- **Kimi / Moonshot**：`/users/me/balance`，显示代金券 + 现金余额
- **one-api / new-api 中转站**：读账单接口的累计已用；`hard_limit_usd: 1e8` 是「不限额度」的占位值，识别出来不会当成九位数余额
- **Cloudflare / sharedchat** 等没有余额接口的：标注「需控制台」

### 2. 免费模型 —— 每日自动探测，标注限免 / 长期免费

- **OpenRouter**：拉全量模型清单，按 `pricing.prompt === 0 && pricing.completion === 0` 筛出真正免费的模型（实测 470 个模型里 19 个免费）
- **OpenCode Zen**：按 `-free` 后缀筛（实测 85 个里 9 个免费）

每个模型带「长期免费 / 每日刷新 / 新用户赠额」标签和上下文长度。点「重新探测」随时刷新。

### 3. 密钥管理 —— 填 Key 自动读模型 ID

- 选平台 → **Base URL 自动填好**（28 家大厂已内置）→ 填 Key → 点「读取模型 ID」，插件真的去请求该平台的 `/models` 接口，把模型 ID 列表拉回来
- 保存后只显示掩码（`gsk_RE…0dUP`），Key 存在本机 `data/vault.json`
- 支持**删除**单条、**导出全部**为 JSON 文件
- 自定义平台也能用：不选平台，直接填 Base URL + Key 即可

### 4. 平台目录 —— 一键去申请

28 家平台，每家带**官方密钥申请页**（全部实测 HTTP 200 可访问），点「申请」在新标签打开。按「长期免费 / 每日刷新 / 新用户赠额」筛选。

### 5. 一键签到

支持签到赠额的中转站。目前：
- **sharedchat 公益站**：每日签到送 $50 Codex 额度（已实现并验证可用）
- **AgentRouter / 新疆幻城**：走 one-api 登录 + 签到接口；新疆幻城需 Cloudflare 人机验证，会给出明确提示而不是静默失败

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
│   ├── providers.json     # 28 家平台目录（Base URL / 申请页 / 免费类型）
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
