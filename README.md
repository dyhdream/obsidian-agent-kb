# Obsidian Agent KB — 多 Agent 协作自动知识库管家

基于 DeepSeek API + 本地 Agent 服务的 Obsidian 知识库自动管理工具。保存笔记时自动分析内容，提供链接建议、标签标准化、结构优化、笔记拆分/新建、Git 版本控制和偏好学习。

## 架构

```
Obsidian Vault ──(onSave)──▶ Obsidian 插件 ──(HTTP)──▶ 本地 Agent 服务 (Python FastAPI)
                                                              │
                                         ┌─────────────┬──────┼──────┬─────────────┐
                                         │             │             │             │
                                     Agent A       Agent B       Agent C       NoteSplitter
                                   上下文构建     链接分析器    结构优化器      笔记拆分/创建
                                         │             │             │             │
                                         └─────────────┴──────┬──────┴─────────────┘
                                                              │
                                                     DeepSeek API (deepseek-v4-flash)
                                                              │
                                                      SQLite + TF-IDF 向量库 (本地)
```

> [!important] 强烈推荐搭配 Git 仓库使用
> 
> 将你的 Obsidian Vault 初始化为 Git 仓库并绑定远程（GitHub/GitLab）：
> ```bash
> cd D:/你的ObsidianVault路径
> git init
> git add -A && git commit -m "初始化知识库"
> git remote add origin git@github.com:你的用户名/知识库.git
> git push -u origin main
> ```
> 
> 这样做的好处：
> - 每次采纳建议前自动 git 快照，可**逐次撤销**
> - 知识库天然拥有**云备份**和**历史回溯**
> - 跨设备同步 + 协作编辑
> 
> 插件首次加载时会自动检测并初始化 git（若无则 `git init`），但绑定远程仍需你手动执行。

## 功能

### 核心分析

| 功能 | 说明 |
|------|------|
| **自动链接建议** | 语义分析内容，仅建议 vault 中**已存在的笔记**建立链接，过滤已有链接 |
| **新概念提示** | 值得独立成篇但 vault 中尚不存在的概念，采纳后自动调用 LLM 生成完整笔记 |
| **标签标准化** | 识别同义标签（如 `AI` / `artificial-intelligence`），归一化命名并批量替换 |
| **笔记拆分** | 检测超过 800 字多主题笔记，采纳后自动切割内容、创建子笔记、精简原笔记 |
| **孤岛笔记提醒** | 标记连接数 < 2 的孤立笔记，建议关联 |
| **MOC 自动维护** | 标签簇达到阈值时建议创建/更新 MOC（Map of Content） |
| **前言检查** | 检测缺失的 YAML frontmatter 字段（aliases、tags、created） |

### 用户体验

| 功能 | 说明 |
|------|------|
| **已处理 / 共发现** | 弹窗实时显示建议处理进度，全部处理完自动关闭 |
| **一键采纳/忽略** | 绿色「采纳」按钮执行操作 + 记录偏好，灰色「忽略」仅记录偏好 |
| **防级联** | 插件自身操作（拆分、创建）不会触发新一轮分析 |
| **3 秒防抖** | 同一文件短期内不重复分析 |

### Git 版本控制

| 功能 | 说明 |
|------|------|
| **自动快照** | 每次采纳建议前，git 自动提交当前 vault 状态（`[Agent KB] link: ...`） |
| **一键撤销** | `Ctrl+P` → "撤销 Agent KB 上次修改"，`git reset --hard HEAD~1` 回退 |
| **自动初始化** | 首次加载插件时自动 `git init` 并创建 `.gitignore` |

### 偏好学习

本地记录用户接受/拒绝历史，动态调整拆分阈值、合并阈值、MOC 阈值等。

### Obsidian 格式

所有 Agent 输出强制遵循 Obsidian 规范：
- YAML frontmatter（`aliases`、`tags`、`created`）
- `[[wiki链接]]` 替代 Markdown 链接
- 标题从 `##` 开始（文件名即一级标题）
- callout 语法（`> [!tip]` / `> [!note]` / `> [!warning]`）
- 内嵌标签 `#tag`

## 快速开始

### 1. 前提条件

- Python 3.10+
- Node.js（Obsidian 插件天然支持）
- Git（用于版本控制）
- DeepSeek API Key（[获取地址](https://platform.deepseek.com)）

### 2. 配置

```bash
git clone https://github.com/dyhdream/obsidian-agent-kb.git
cd obsidian-agent-kb
cp .env.example .env
# 编辑 .env：
#   DEEPSEEK_API_KEY=sk-xxx
#   VAULT_PATH=D:/your/path/to/obsidian/vault
```

### 3. 启动 Agent 服务

```bash
cd agent_service
pip install -r requirements.txt
python -m agent_service.main
# 服务运行在 http://127.0.0.1:9527
```

### 4. 安装 Obsidian 插件

```bash
cp -r obsidian-plugin/ <你的vault>/.obsidian/plugins/agent-kb/
```

在 Obsidian 设置 → 第三方插件 → 启用 "Agent KB"。

### 5. 验证

重启 Obsidian，状态栏左下角应显示 `Agent KB`。保存任意 `.md` 文件，右下角弹出分析建议。

## 使用方式

| 操作 | 方式 |
|------|------|
| 触发分析 | 保存 `.md` 文件（自动），或 `Ctrl+P` → "立即分析当前笔记" |
| 采纳建议 | 弹窗中点击绿色「采纳」按钮 |
| 忽略建议 | 弹窗中点击灰色「忽略」按钮 |
| 撤销修改 | `Ctrl+P` → "撤销 Agent KB 上次修改" |
| 调整设置 | 设置 → 第三方插件 → Agent KB（服务地址、最低置信度等） |

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 服务状态 + 笔记数量 |
| `/api/analyze` | POST | 分析单篇笔记（file_path、content、tags） |
| `/api/split` | POST | 拆分笔记 / 生成新概念笔记（file_path、content、topics） |
| `/api/feedback` | POST | 记录用户反馈（action_type、suggestion、accepted） |

## 成本估算

使用 `deepseek-v4-flash` 模型：

| 场景 | Token 消耗 | 费用（约） |
|------|-----------|-----------|
| 单次分析（< 3000 字笔记） | ~6K | ~0.0015 元 |
| 单次拆分 / 新建概念 | ~10K | ~0.0025 元 |
| 日均 10 篇笔记 | ~150K | ~0.04 元 |
| 月均 | ~4.5M | ~1.2 元 |

## 技术栈

| 组件 | 方案 |
|------|------|
| Agent 服务 | Python FastAPI + uvicorn |
| 推理引擎 | DeepSeek API（deepseek-v4-flash） |
| 向量化 | sklearn TfidfVectorizer（纯本地，零 API 调用） |
| 向量存储 | SQLite |
| 插件开发 | Obsidian Plugin API（CommonJS） |
| 版本控制 | Git（自动提交 + 一键撤销） |

## 项目结构

```
obsidian-agent-kb/
├── agent_service/
│   ├── main.py                    # FastAPI 入口
│   ├── config.py                  # 配置（pydantic-settings）
│   ├── deepseek_client.py         # DeepSeek API 封装
│   ├── orchestrator.py            # 编排器（并行调度）
│   ├── vector_store.py            # SQLite + TF-IDF 向量库
│   ├── preference_learner.py      # 偏好学习
│   ├── agents/
│   │   ├── context_builder.py     # Agent A：上下文构建
│   │   ├── link_analyzer.py       # Agent B：链接分析 + 新概念
│   │   ├── structure_optimizer.py # Agent C：结构优化
│   │   └── note_splitter.py       # 笔记拆分 / 新概念生成
│   └── requirements.txt
├── obsidian-plugin/
│   ├── main.ts                    # 插件入口（TypeScript 源文件）
│   ├── manifest.json
│   ├── settings.ts                # 设置面板
│   └── styles.css                 # 弹窗样式
├── .env.example
├── .gitignore
└── README.md
```
