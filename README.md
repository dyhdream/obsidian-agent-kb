# Obsidian Agent KB — 多 Agent 协作自动知识库管家

基于 DeepSeek API + 本地 Agent 服务的 Obsidian 知识库自动管理工具。保存笔记时自动分析内容，4 个 AI Agent 协作产出链接建议、标签标准化、结构优化、笔记拆分/新建，支持偏好学习、Git 版本控制和一键撤销。

## 架构

```
Obsidian Vault ──(onSave)──▶ Obsidian 插件 ──(HTTP)──▶ 本地 Agent 服务
                                                              │
                                    ┌─────────────────黑板（Blackboard）──────────────┐
                                    │                                                 │
                              情报员              链接师              架构师          品控官
                           ContextScout        LinkWeaver      StructureGuardian    Reviewer
                          (扫描Vault,0.5s)    (并行,~12s)        (并行,~12s)      (后台静默)
                                    │                 │                  │            │
                                    └─────────────────┼──────────────────┴─────┬──────┘
                                                      │                        │
                                              首屏建议(~14s)            精化建议(~30s)
                                                      │                        │
                                                  展示给用户              自动更新弹窗
```

| Agent | 角色 | 产出 |
|-------|------|------|
| **情报员** | 扫描 Vault，收集上下文 | 同目录笔记、标题匹配、语义相似笔记 |
| **链接师** | 发现关联 | 链接建议、新概念提示、孤岛笔记 |
| **架构师** | 结构检查 | 标签标准化、拆分建议、MOC、frontmatter |
| **品控官** | 最终审核 | 去重、排序、冲突消解、偏好过滤 |

## 性能

| 指标 | v0.1(串行) | v0.2(并行+优化) |
|------|-----------|----------------|
| 首屏建议 | ~37s | **~14s** |
| 完全精化 | ~37s | ~30s(后台，不阻塞) |
| LLM 调用次数 | 4 次 | 2 次(并行) + 1 次(后台) |
| 每次分析读取文件 | 100+ | 0(纯索引查询) |

核心优化：情报员 LLM 移除(省 8s) + 链接师/架构师并行(asyncio.gather) + 品控官后台静默。

> [!important] 强烈推荐搭配 Git 仓库使用
>
> ```bash
> cd D:/你的ObsidianVault路径
> git init && git add -A && git commit -m "初始化知识库"
> git remote add origin git@github.com:你的用户名/知识库.git
> git push -u origin main
> ```
> 每次采纳建议前自动 git 快照，可**逐次撤销**（`git revert`，安全回退，不丢未提交修改）。

## 功能

### 核心分析

| 功能 | 说明 |
|------|------|
| **自动链接建议** | 仅建议 vault 中已存在的笔记，硬过滤已有链接 + 不存在的文件 |
| **新概念提示** | vault 中不存在的概念，采纳后自动调用 LLM 生成完整 Obsidian 格式笔记 |
| **标签标准化** | 同义标签归一化，正则转义防误伤，空格分隔不堆叠 |
| **笔记拆分** | 超主题长笔记自动切割，创建子笔记 + 精简原笔记 |
| **孤岛笔记提醒** | 级联连接数不足的笔记，建议关联 |
| **MOC 建议** | 标签簇达阈值时建议创建 Map of Content |
| **frontmatter 检查** | aliases、tags、created 等字段完整性 |

### 用户体验

| 功能 | 说明 |
|------|------|
| **即时反馈** | 保存后弹窗立刻打开，状态栏显示文件名 + 分析阶段 |
| **渐进式建议** | 链接师/架构师完成后首批建议立刻出现，品控官后台精化 |
| **动画 dots** | 分析中 `分析中.` → `分析中..` → `分析中...` 轮转，不死寂 |
| **已处理 / 共发现** | 弹窗实时进度，全部处理自动关闭 |
| **采纳 / 忽略 / 永不要** | 三个按钮，永久忽略写入偏好学习，后续不再出现 |
| **防级联** | 插件自身操作不触发新分析，`_pendingPaths` + 3s 防抖 |
| **autoAnalyzeOnSave 开关** | 设置中关闭后保存不触发 |

### 安全

| 措施 | 说明 |
|------|------|
| **CORS 限制** | `allow_origin_regex` 仅允许 `app://` 和 `localhost` |
| **Shell 注入防御** | 所有 git 命令用 `cp.execFile` 参数数组，不再字符串拼接 |
| **Git 安全回退** | `git revert` 替代 `git reset --hard`，保留历史且不丢未保存修改 |

### 偏好学习

- 会话记忆：当前 server session 内拒绝的建议不再出现
- 永久忽略：用户点「永不要」后写入偏好，跨 session 生效
- 采纳率统计：每种建议类型的历史采纳率注入 Agent prompt 动态调整
- 偏好去重：同一条 suggestion 不重复记录，数据干净

## 快速开始

### 1. 前提

- Python 3.10+
- Git
- DeepSeek API Key（[platform.deepseek.com](https://platform.deepseek.com)）

### 2. 配置

```bash
git clone https://github.com/dyhdream/obsidian-agent-kb.git
cd obsidian-agent-kb
cp .env.example .env
# 编辑 .env：
#   DEEPSEEK_API_KEY=sk-xxx
#   VAULT_PATH=D:/your/obsidian/vault
```

### 3. 启动服务

```bash
pip install -r agent_service/requirements.txt
python -m agent_service.main
# → http://127.0.0.1:9527
```

### 4. 安装插件

将 `obsidian-plugin/` 目录复制到 vault 的 `.obsidian/plugins/agent-kb/`，在设置中启用。

### 5. 验证

重启 Obsidian，状态栏显示 `Agent KB`。保存 `.md` → 弹窗打开 → 14s 后出建议。

## 使用

| 操作 | 方式 |
|------|------|
| 触发分析 | 保存 `.md`（自动），或 `Ctrl+P` → "立即分析当前笔记" |
| 采纳建议 | 弹窗绿色按钮，执行操作 + 记录偏好 |
| 忽略建议 | 灰色按钮，本次不再提示 |
| 永久不要 | 右侧小字按钮，写入 preference，以后也不再建议 |
| 撤销修改 | `Ctrl+P` → "撤销 Agent KB 上次修改" |
| 设置 | 设置 → 第三方插件 → Agent KB |

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 服务状态 + 笔记数量 |
| `/api/analyze` | POST | 同步分析（向后兼容） |
| `/api/analyze/start` | POST | 启动异步分析，返回 `session_id` |
| `/api/analyze/results/{sid}` | GET | 轮询当前进度 + 增量建议 |
| `/api/split` | POST | 拆分笔记 / 生成新概念 |
| `/api/feedback` | POST | 记录反馈（action_type/suggestion/accepted） |
| `/api/usage` | GET | 今日/累计 Token 用量 + 花费 |

## 成本

`deepseek-v4-flash`，索引查询零 token：

| 场景 | Token | 费用 |
|------|-------|------|
| 单次分析 | ~3K | ~¥0.001 |
| 日均 10 篇 | ~30K | ~¥0.01 |
| 月均 | ~900K | ~¥0.3 |

## 技术栈

| 组件 | 方案 |
|------|------|
| Agent 服务 | Python FastAPI + uvicorn |
| 推理引擎 | DeepSeek API（deepseek-v4-flash） |
| 索引 | SQLite（VaultIndex）+ TF-IDF（title + 首 200 字） |
| 插件 | Obsidian Plugin API（CommonJS，ES5 兼容） |
| 版本控制 | Git（execFile 参数化 + git revert） |

## 项目结构

```
obsidian-agent-kb/
├── agent_service/
│   ├── main.py                    # FastAPI 入口 + 所有 API 端点
│   ├── config.py                  # pydantic-settings 配置（所有魔术数字）
│   ├── blackboard.py              # Agent 共享黑板
│   ├── agent_base.py              # Agent 基类（偏好注入 + JSON 解析）
│   ├── orchestrator.py            # 编排器（并行调度 + 后台 reviewer） ｜
│   ├── deepseek_client.py         # DeepSeek API 封装 + usage 追踪
│   ├── vector_store.py            # SQLite + TF-IDF 轻量向量库
│   ├── vault_index.py             # vault 元数据索引（标题/标签/目录/mtime）
│   ├── preference_learner.py      # 偏好学习（接受率 + 去重）
│   ├── session_memory.py          # 会话记忆（当次拒绝不再提）
│   ├── usage_tracker.py           # Token 用量 + 费用追踪
│   ├── utils.py                   # 公共工具（parse_json 等）
│   ├── agents/
│   │   ├── context_scout.py       # 情报员（纯索引查询，不读文件）
│   │   ├── link_weaver.py         # 链接师（硬过滤不存在笔记 + 已存在链接）
│   │   ├── structure_guardian.py  # 架构师
│   │   ├── reviewer.py            # 品控官
│   │   └── note_splitter.py       # 笔记拆分
│   └── requirements.txt
├── obsidian-plugin/
│   ├── main.js                    # 插件入口（ES5，零构建）
│   ├── main.ts                    # TypeScript 源文件
│   ├── manifest.json
│   ├── settings.ts
│   └── styles.css
├── tests/
│   └── test_e2e.py                # E2E 全链路测试
├── .env.example
├── .gitignore
└── README.md
```
