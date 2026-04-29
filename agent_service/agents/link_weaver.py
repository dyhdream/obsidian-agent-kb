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
        vault = self.blackboard.read("vault")
        context = self.blackboard.read("context")
        findings = self.blackboard.read("findings")

        content = current.get("content", "")
        key_entities = findings.get("key_entities", [])

        import re
        existing = re.findall(r"\[\[([^\]|]+)", content)
        existing_str = "\n".join(f"- [[{w.strip()}]]" for w in existing[:15]) if existing else "无"

        # 同目录笔记（关联最大）
        same_dir = context.get("same_dir", [])
        same_str = "\n".join(f"- {n['title']} (@ {n.get('dir', '')}, tags: {','.join(n.get('tags',[])[:3])})" for n in same_dir)
        if not same_str:
            same_str = "无"

        # 标题匹配
        matched = context.get("matched", [])
        matched_str = "\n".join(f"- {n['title']}" for n in matched) if matched else "无"

        # 全量标题（链接候选）
        all_titles = vault.get("all_titles", [])
        titles_str = "\n".join(f"- {t['title']}" for t in all_titles[:80])
        if len(all_titles) > 80:
            titles_str += f"\n... 还有 {len(all_titles) - 80} 篇"

        return f"""当前笔记: {current.get('title', '')}
标签: {', '.join(current.get('tags', []))}

已有链接（不要重复）:
{existing_str}

◇ 同目录笔记（关联最大，优先考虑）:
{same_str}

◇ 标题匹配:
{matched_str}

◇ 可用笔记列表（只有这些可以建议 [[链接]]）:
{titles_str}

核心实体: {', '.join(key_entities[:8])}
笔记总数: {vault.get('total_notes', 0)}

输出 JSON。"""

    def handle_response(self, raw: str) -> bool:
        parsed = self.parse_json(raw)
        findings = self.blackboard.read("findings")

        import re
        content = self.blackboard.read("current").get("content", "")
        existing = set(
            w.strip().lower()
            for w in re.findall(r"\[\[([^\]|]+)", content)
        )

        # 已存在的笔记标题集合（硬过滤，不依赖 LLM 守规矩）
        all_titles = self.blackboard.read("vault").get("all_titles", [])
        valid_titles = {t["title"].lower(): t for t in all_titles}

        links = parsed.get("links", [])
        filtered_links = []
        skipped = []

        for l in links:
            target = l.get("target", "").strip()
            target_lower = target.lower()

            if target_lower in existing:
                skipped.append(f"跳过已存在链接: {target}")
                continue
            if target_lower not in valid_titles:
                skipped.append(f"跳过不存在的笔记: {target}")
                continue
            if l.get("confidence", 0) < 0.5:
                skipped.append(f"置信度不足: {target}")
                continue

            filtered_links.append(l)

        if skipped:
            import logging
            logging.getLogger("agent_kb").info(f"链接师硬过滤: {'; '.join(skipped)}")

        self.blackboard.update("findings", {
            "links": filtered_links,
            "concepts": parsed.get("new_concepts", []),
            "orphans": parsed.get("orphans", []),
            "link_notes": parsed.get("notes", ""),
        })
        return True
