"""
Agent 1: 情报员 (ContextScout)
职责：扫描 vault，构建上下文，产出原材料供其他 Agent 使用。
不做任何分析判断 — 只提供事实数据。
"""

import os
import hashlib
from ..agent_base import Agent
from ..config import settings
from ..vector_store import vector_store


CONTEXT_SCOUT_PERSONA = """你是 Obsidian 知识库的「情报员」(Context Scout)。你的工作是扫描当前笔记和 Vault，提取上下文信息供其他 Agent 使用。

## 你的职责
1. 收集当前笔记的基本信息
2. 从 Vault 中找到语义最相近的几篇笔记
3. 列出 Vault 中已有的所有标签（供架构师做标签标准化参照）
4. 统计 Vault 整体信息（笔记总数、标签分布等）

## 你不能做的事
- 不做任何链接建议（那是链接师的工作）
- 不做拆分/合并判断（那是架构师的工作）
- 不做标签标准化（那是架构师的工作）
- 只是收集事实，不做分析判断

## 输出格式
严格按以下 JSON 输出：
{
  "context_summary": "当前笔记的一句话概述",
  "key_entities": ["笔记中提到的核心概念/实体"],
  "data_quality": "good | partial | minimal",
  "notes": "任何值得其他 Agent 注意的事项"
}"""


class ContextScout(Agent):
    role = "scout"
    persona = CONTEXT_SCOUT_PERSONA

    def __init__(self, blackboard):
        super().__init__(blackboard)
        self._scanned_at = 0

    def system_prompt(self) -> str:
        return self.persona + self.inject_preferences()

    def user_prompt(self) -> str:
        current = self.blackboard.read("current")
        similar = self.blackboard.read("similar")
        vault = self.blackboard.read("vault")

        similar_lines = ""
        for n in similar[:5]:
            similar_lines += f"- {n['title']} (相关度: {1 - n.get('distance', 0):.2f})\n"

        existing_tags = vault.get("existing_tags", [])

        return f"""当前笔记: {current.get('title', '')}
路径: {current.get('file_path', '')}
标签: {', '.join(current.get('tags', []))}

相似笔记:
{similar_lines or '无'}

Vault 已有标签: {', '.join(existing_tags[:30])}
Vault 笔记总数: {vault.get('total_notes', 0)}

笔记内容 (截取):
---
{current.get('content', '')[:3000]}
---

请输出 JSON 分析结果。"""

    def handle_response(self, raw: str) -> bool:
        parsed = self.parse_json(raw)
        self.blackboard.write("findings", {
            **self.blackboard.read("findings"),
            "context_summary": parsed.get("context_summary", ""),
            "key_entities": parsed.get("key_entities", []),
            "data_quality": parsed.get("data_quality", "partial"),
            "scout_notes": parsed.get("notes", ""),
        })
        return True

    # ── 工具方法（预备，供 Agent 内部或编排器调用） ──

    @staticmethod
    def scan_vault(file_path: str, content: str, tags: list[str], blackboard) -> dict:
        """执行 vault 扫描并填充黑板。（同步方法，由编排器调用）"""
        vault = settings.vault_path

        note_id = hashlib.md5(file_path.encode()).hexdigest()

        # 语义搜索
        similar_notes = vector_store.search_similar(content, n=settings.max_context_notes)

        # 读取 vault 中已有的所有标题和标签
        all_titles = []
        existing_tags_set = set()
        linked_notes = []

        if vault and os.path.isdir(vault):
            current_basename = os.path.basename(file_path)
            for root, dirs, files in os.walk(vault):
                dirs[:] = [d for d in dirs if d not in (".obsidian", ".trash", ".git")]
                for fname in files:
                    if not fname.endswith(".md") or fname == current_basename:
                        continue
                    fpath = os.path.join(root, fname)
                    rel = os.path.relpath(fpath, vault)
                    title = os.path.splitext(fname)[0]
                    all_titles.append({"title": title, "path": rel})

                    if tags and len(linked_notes) < 10:
                        try:
                            with open(fpath, "r", encoding="utf-8") as f:
                                fcontent = f.read()
                            tag_matches = set(
                                tag.lower() for tag in tags
                                if f"#{tag.lower()}" in fcontent.lower()
                                or tag.lower() in fcontent.lower()
                            )
                            if tag_matches:
                                linked_notes.append(rel)
                        except Exception:
                            pass

                    # 收集已有标签
                    try:
                        import re
                        tag_match = re.findall(r"#([\u4e00-\u9fa5a-zA-Z][\u4e00-\u9fa5a-zA-Z0-9_-]*)", open(fpath, "r", encoding="utf-8").read()[:5000])
                        existing_tags_set.update(t.lower() for t in tag_match)
                    except Exception:
                        pass

        # 更新向量库
        vector_store.add_or_update(
            note_id=note_id,
            title=os.path.basename(file_path).replace(".md", ""),
            content=content,
            metadata={"path": file_path, "tags": ",".join(tags or [])},
        )

        # 写入黑板
        blackboard.write("current", {
            "note_id": note_id,
            "file_path": file_path,
            "title": os.path.basename(file_path).replace(".md", ""),
            "content": content[:settings.max_note_chars],
            "tags": tags or [],
        })
        blackboard.write("similar", similar_notes)
        blackboard.write("vault", {
            "total_notes": vector_store.count(),
            "all_titles": all_titles,
            "existing_tags": list(existing_tags_set),
            "linked_notes": linked_notes,
        })

        return {"note_count": vector_store.count(), "similar_count": len(similar_notes)}
