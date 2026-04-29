"""
Agent 2: 链接师 (LinkWeaver)
职责：基于黑板的上下文信息，建议链接关系、发现新概念、识别孤岛笔记。
产出写入 blackboard.findings.links / concepts / orphans。
"""

from ..agent_base import Agent

LINK_WEAVER_PERSONA = """你是 Obsidian 知识库的「链接师」(Link Weaver)。你的工作是发现笔记之间的关联。

## 你的职责
1. 建议当前笔记应与哪些已有笔记建立链接
2. 发现值得独立成篇的新概念（vault 中还不存在的）
3. 识别 Vault 中的孤岛笔记（连接数太少、未充分利用）

## 约束
- **只能建议链接到 Vault 中已存在的笔记**（见下方「可用笔记列表」）
- 如果某个概念很相关但没有对应笔记，放入 new_concepts
- 不要建议当前笔记中已经存在的 [[链接]]
- 不要建议链接到当前笔记自身
- Confidence 在 0.5-1.0 之间

## 输出格式
严格按以下 JSON 输出：
{
  "links": [
    {
      "target": "目标笔记标题（必须来自可用笔记列表）",
      "anchor_text": "适合作为链接锚点的文本",
      "reason": "建议链接的原因",
      "confidence": 0.0-1.0
    }
  ],
  "new_concepts": ["概念1", "概念2"],
  "orphans": [
    {
      "note_title": "孤岛笔记标题",
      "reason": "为什么是孤岛"
    }
  ],
  "notes": "任何值得架构师或品控官注意的额外信息"
}"""


class LinkWeaver(Agent):
    role = "link_weaver"
    persona = LINK_WEAVER_PERSONA

    def system_prompt(self) -> str:
        return self.persona + self.inject_preferences()

    def user_prompt(self) -> str:
        current = self.blackboard.read("current")
        similar = self.blackboard.read("similar")
        vault = self.blackboard.read("vault")
        findings = self.blackboard.read("findings")

        # 情报员分析结果
        key_entities = findings.get("key_entities", [])
        scout_notes = findings.get("scout_notes", "")

        # 已有链接（从内容中提取）
        import re
        content = current.get("content", "")
        existing = re.findall(r"\[\[([^\]|]+)", content)
        existing_str = "\n".join(f"- [[{w.strip()}]]" for w in existing[:20]) if existing else "无"

        # 相似笔记
        similar_lines = ""
        for n in similar[:5]:
            similar_lines += f"- {n['title']} (相关度: {1 - n.get('distance', 0):.2f})\n"

        # 已有笔记列表（只有这些可以被建议链接）
        all_titles = vault.get("all_titles", [])
        titles_lines = "\n".join(f"- {t['title']}" for t in all_titles[:50])
        if len(all_titles) > 50:
            titles_lines += f"\n... 还有 {len(all_titles) - 50} 篇"

        return f"""当前笔记: {current.get('title', '')}
路径: {current.get('file_path', '')}
标签: {', '.join(current.get('tags', []))}

情报员发现: {scout_notes}
核心实体: {', '.join(key_entities[:10])}

当前笔记中已有链接（不要重复建议）:
{existing_str}

相似笔记:
{similar_lines}

可用笔记列表（只有这些标题可以被建议链接，不在列表中的放入 new_concepts）:
{titles_lines}

Vault 笔记总数: {vault.get('total_notes', 0)}

笔记内容 (截取):
---
{content[:3000]}
---

请输出 JSON 分析结果。"""

    def handle_response(self, raw: str) -> bool:
        parsed = self.parse_json(raw)
        findings = self.blackboard.read("findings")

        # 过滤已存在的链接
        import re
        content = self.blackboard.read("current").get("content", "")
        existing = set(
            w.strip().lower()
            for w in re.findall(r"\[\[([^\]|]+)", content)
        )

        links = parsed.get("links", [])
        filtered_links = [
            l for l in links
            if l.get("target", "").lower() not in existing
            and l.get("confidence", 0) >= 0.5
        ]

        findings.update({
            "links": filtered_links,
            "concepts": parsed.get("new_concepts", []),
            "orphans": parsed.get("orphans", []),
            "link_notes": parsed.get("notes", ""),
        })
        self.blackboard.write("findings", findings)
        return True
