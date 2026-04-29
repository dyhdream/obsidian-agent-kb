"""
Agent 1: 情报员 (ContextScout)
V2: 纯索引查询版本。不再遍历 vault 文件系统。
数据来自 VaultIndex + VectorStore 的轻量查询。
"""

import os
import hashlib
from ..agent_base import Agent
from ..config import settings
from ..vector_store import vector_store
from ..vault_index import vault_index


CONTEXT_SCOUT_PERSONA = """你是 Obsidian 知识库的「情报员」(Context Scout)。
你的工作是提供当前笔记的上下文摘要，供链接师和架构师参考。

## 输出格式
{
  "context_summary": "一句话概述当前笔记的核心主题",
  "key_entities": ["核心概念1", "核心概念2"],
  "data_quality": "good | partial | minimal",
  "notes": "任何值得其他 Agent 注意的事项"
}"""


class ContextScout(Agent):
    role = "scout"
    persona = CONTEXT_SCOUT_PERSONA

    def system_prompt(self) -> str:
        return self.persona + self.inject_preferences()

    def user_prompt(self) -> str:
        current = self.blackboard.read("current")
        similar = self.blackboard.read("similar")

        similar_lines = ""
        for n in similar[:5]:
            similar_lines += f"- {n['title']} ({n.get('dir', '')})\n"

        return f"""当前笔记: {current.get('title', '')}
路径: {current.get('file_path', '')}
标签: {', '.join(current.get('tags', []))}

同目录笔记: {', '.join(n['title'] for n in self.blackboard.read('context').get('same_dir', []))}
标题匹配笔记: {', '.join(n['title'] for n in self.blackboard.read('context').get('matched', []))}
语义相似笔记:
{similar_lines or '无'}

笔记内容 (截取):
---
{current.get('content', '')[:2000]}
---

输出 JSON。"""

    def handle_response(self, raw: str) -> bool:
        parsed = self.parse_json(raw)
        findings = self.blackboard.read("findings")
        findings.update({
            "context_summary": parsed.get("context_summary", ""),
            "key_entities": parsed.get("key_entities", []),
            "data_quality": parsed.get("data_quality", "partial"),
            "scout_notes": parsed.get("notes", ""),
        })
        self.blackboard.write("findings", findings)
        return True

    # ── 同步扫描（编排器在 Agent 运行前调用） ──

    @staticmethod
    def scan_vault(file_path: str, content: str, tags: list[str], blackboard) -> dict:
        """纯索引查询。0 次文件 open()，全部来自 SQLite 索引。"""
        # 增量同步当前文件（确保最新）
        vault_index._sync()

        note_id = hashlib.md5(file_path.encode()).hexdigest()

        # 语义搜索 (TF-IDF, 只索引标题+首段)
        search_text = (
            os.path.basename(file_path).replace(".md", "") + " " +
            content[:200]
        )
        similar_notes = vector_store.search_similar(search_text, n=settings.max_context_notes)

        # 同目录笔记（关联最大，0 文件读）
        same_dir = vault_index.same_dir(file_path)

        # 标题关键词匹配
        title_words = os.path.basename(file_path).replace(".md", "")
        matched = vault_index.search_title(title_words)

        # 全量标题索引（供链接师筛选可用链接目标）
        all_titles = vault_index.all_titles()

        # 更新向量库
        vector_store.add_or_update(
            note_id=note_id,
            title=os.path.basename(file_path).replace(".md", ""),
            content=content[:200],  # 只索引前 200 字
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
            "total_notes": vault_index.count(),
            "all_titles": all_titles,
            "existing_tags": list(set(
                t for n in all_titles for t in n.get("tags", [])
            ))[:100],
        })
        blackboard.write("context", {
            "same_dir": same_dir,
            "matched": matched,
        })

        return {"note_count": vault_index.count(), "similar_count": len(similar_notes)}
