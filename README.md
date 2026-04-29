# Obsidian Agent KB - 多 Agent 协作自动知识库管家

## 概述

基于 DeepSeek API  + 本地 Agent 服务的 Obsidian 知识库自动管理工具。保存笔记时自动分析内容，提供链接建议、标签标准化、结构优化和孤岛笔记提醒。

## 架构

```
Obsidian Vault ──(onSave)──▶ Obsidian 插件 ──(HTTP)──▶ 本地 Agent 服务
                                                          │
                                              ┌───────────┼───────────┐
                                              │           │           │
                                          Agent A      Agent B     Agent C
                                        上下文构建    链接分析    结构优化
                                              │           │           │
                                              └───────────┼───────────┘
                                                          │
                                                     DeepSeek API
```

## 快速开始

### 1. 配置

```bash
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY 和 vault 路径
```

### 2. 启动 Agent 服务

```bash
cd agent_service
pip install -r requirements.txt
python -m agent_service.main
```

### 3. 安装 Obsidian 插件

将 `obsidian-plugin/` 目录复制到 `.obsidian/plugins/obsidian-agent-kb/`，在 Obsidian 设置中启用。

## 功能

- **自动链接建议**：分析内容语义，建议与已有笔记建立双向链接
- **标签标准化**：识别同义标签，归一化命名
- **内容原子化**：检测笔记是否需要拆分或合并
- **MOC 自动维护**：标签簇达到阈值时建议创建/更新 MOC
- **孤岛笔记提醒**：标记连接数不足的孤立笔记
- **偏好学习**：根据用户接受/拒绝历史动态调整策略

## 技术栈

- Agent 服务：Python FastAPI
- 推理引擎：DeepSeek API
- 向量库：ChromaDB
