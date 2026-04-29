"""
Agent 3: 架构师 (StructureGuardian)
职责：检查笔记自身质量 — frontmatter、标签规范化、是否需要拆/合、MOC 维护。
产出写入 blackboard.findings.structure / tags。
"""

from ..agent_base import Agent

STRUCTURE_GUARDIAN_PERSONA = """你是 Obsidian 知识库的「架构师」(Structure Guardian)。你的工作是确保每篇笔记结构健康、标签规范。

## 你的职责
1. 检查 YAML frontmatter 是否完整（aliases、tags、created 等）
2. 标签归一化建议（参考 Vault 已有标签全集）
3. 判断笔记是否超主题需要拆分（>800 字且含多个独立主题）
4. 找可以合并的短笔记（<100 字且主题相近）
5. 某种标签的笔记数达到 10+ 时建议创建 MOC

## 约束
- 拆分建议需指定具体主题名
- 标签归一化使用全小写 + 中划线 (kebab-case)
- 不要建议把没有重叠主题的短笔记合并

## 输出格式
严格按以下 JSON 输出：
{
  "frontmatter_issues": {
    "is_present": true/false,
    "missing_fields": ["aliases", "created"],
    "issues": ["tags 中存在同义标签"]
  },
  "tag_suggestions": [
    {"current": "原标签", "suggested": "建议标签", "reason": "原因"}
  ],
  "split_suggestion": {
    "needs_split": true/false,
    "reason": "需要拆分的原因",
    "suggested_topics": ["主题1", "主题2"]
  },
  "merge_suggestion": {
    "needs_merge": true/false,
    "reason": "需要合并的原因",
    "candidates": ["候选笔记标题"]
  },
  "moc_suggestion": {
    "needs_moc": true/false,
    "topic": "MOC 主题",
    "reason": "触发 MOC 的原因"
  },
  "notes": "任何值得品控官注意的信息"
}"""


class StructureGuardian(Agent):
    role = "structure_guardian"
    persona = STRUCTURE_GUARDIAN_PERSONA

    def system_prompt(self) -> str:
        return self.persona + self.inject_preferences()

    def user_prompt(self) -> str:
        current = self.blackboard.read("current")
        vault = self.blackboard.read("vault")
        findings = self.blackboard.read("findings")
        similar = self.blackboard.read("similar")

        content = current.get("content", "")
        tags = current.get("tags", [])
        existing_tags = vault.get("existing_tags", [])

        # 上下文来自链接师的发现
        link_concepts = findings.get("concepts", [])
        orphan_count = len(findings.get("orphans", []))

        # 同标签簇统计
        tag_counts = {}
        for t in existing_tags:
            tag_counts[t.lower()] = tag_counts.get(t.lower(), 0) + 1

        return f"""当前笔记: {current.get('title', '')}
路径: {current.get('file_path', '')}
字数: {len(content)}
标签: {', '.join(tags)}

Vault 已有标签 (部分): {', '.join(tags[:20])}
Vault 笔记总数: {vault.get('total_notes', 0)}

链接师发现的新概念: {', '.join(link_concepts[:5])}
链接师发现的孤岛笔记数: {orphan_count}

笔记内容 (截取):
---
{content[:3000]}
---

请输出 JSON 分析结果。"""

    def handle_response(self, raw: str) -> bool:
        parsed = self.parse_json(raw)
        findings = self.blackboard.read("findings")

        findings.update({
            "tags": parsed.get("tag_suggestions", []),
            "structure": {
                "frontmatter": parsed.get("frontmatter_issues", {}),
                "split": parsed.get("split_suggestion", {}),
                "merge": parsed.get("merge_suggestion", {}),
                "moc": parsed.get("moc_suggestion", {}),
            },
            "structure_notes": parsed.get("notes", ""),
        })
        self.blackboard.write("findings", findings)
        return True
