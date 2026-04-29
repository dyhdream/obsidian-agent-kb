"""
Agent 4: 品控官 (Reviewer)
职责：审查所有 Agent 的产出，去重、排序、冲突消解，产出给用户的最终建议。
这是让 "LLM 工作流" 变为 "Agent 协作" 的关键角色。
"""

from ..agent_base import Agent
from ..preference_learner import preference_learner
from ..session_memory import session_memory

REVIEWER_PERSONA = """你是 Obsidian 知识库的「品控官」(Reviewer)。你审查前面所有 Agent 的产出，确保给用户的建议是高质量、无冗余、无冲突的。

## 你的职责
1. 去重 — 检查多 Agent 是否给了重复建议
2. 排序 — 按优先级和置信度排列给用户的建议
3. 冲突检测 — 标记相互矛盾的建议（如同时建议拆分和合并）
4. 偏好过滤 — 过滤用户常拒绝类型的低质量建议

## 输出格式
严格按以下 JSON 输出，给用户的建议放在 suggestions 数组中:
{
  "suggestions": [
    {
      "type": "link | concept | orphan | tag | structure | moc",
      "priority": 1-5 (1=最高),
      "title": "建议标题（面向用户展示）",
      "description": "详细说明",
      "confidence": 0.0-1.0,
      "source_agent": "link_weaver | structure_guardian",
      "is_conflicted": true/false,
      "conflict_note": "如果冲突，说明和哪条冲突"
    }
  ],
  "summary": "给用户的一句话总结",
  "conflicts_found": [
    {"suggestion_a": "第一方", "suggestion_b": "第二方", "resolution": "建议的解决方式"}
  ],
  "notes": "给开发者的备注"
}"""


class Reviewer(Agent):
    role = "reviewer"
    persona = REVIEWER_PERSONA

    def system_prompt(self) -> str:
        return self.persona + self.inject_preferences()

    def user_prompt(self) -> str:
        findings = self.blackboard.read("findings")
        session = self.blackboard.read("session")

        rejected = session.get("rejected_this_session", [])

        # 汇总所有 Agent 的产出
        links = findings.get("links", [])
        concepts = findings.get("concepts", [])
        orphans = findings.get("orphans", [])
        tags = findings.get("tags", [])
        structure = findings.get("structure", {})

        findings_lines = []
        findings_lines.append(f"## 链接师产出 ({len(links)} 条)")
        for l in links:
            findings_lines.append(f"  - link → [[{l.get('target', '')}]] ({l.get('confidence', 0):.2f}) {l.get('reason', '')}")

        findings_lines.append(f"\n## 新概念 ({len(concepts)} 个)")
        for c in concepts:
            findings_lines.append(f"  - concept → {c}")

        findings_lines.append(f"\n## 孤岛笔记 ({len(orphans)} 个)")
        for o in orphans[:5]:
            findings_lines.append(f"  - orphan → {o.get('note_title', '')}")

        findings_lines.append(f"\n## 架构师产出: 标签 ({len(tags)} 条)")
        for t in tags:
            findings_lines.append(f"  - tag → #{t.get('current', '')} → #{t.get('suggested', '')}")

        findings_lines.append(f"\n## 架构师产出: 结构")
        split = structure.get("split", {})
        merge = structure.get("merge", {})
        moc = structure.get("moc", {})
        fm = structure.get("frontmatter", {})
        findings_lines.append(f"  - split: {split.get('needs_split', False)} → {', '.join(split.get('suggested_topics', []))}")
        findings_lines.append(f"  - merge: {merge.get('needs_merge', False)}")
        findings_lines.append(f"  - moc: {moc.get('needs_moc', False)} → {moc.get('topic', '')}")
        findings_lines.append(f"  - frontmatter: {'缺失字段: ' + ', '.join(fm.get('missing_fields', [])) if fm else 'OK'}")

        rejected_str = "\n".join(f"- {r}" for r in rejected[:20]) if rejected else "无"

        return f"""请审查以下所有 Agent 的分析产出，生成最终建议。

{chr(10).join(findings_lines)}

本次会话已被拒绝的项目（注意降低这些相关建议的优先级）:
{rejected_str}

请输出 JSON 结果。"""

    def handle_response(self, raw: str) -> bool:
        parsed = self.parse_json(raw)
        raw_suggestions = parsed.get("suggestions", [])

        # 去重 + 过滤会话内已拒绝
        seen = set()
        filtered = []
        for s in raw_suggestions:
            key = f"{s.get('type', '')}:{s.get('title', '')}"
            if key in seen:
                continue
            seen.add(key)

            if session_memory.is_rejected(s.get("type", ""), s.get("title", "")):
                continue

            filtered.append(s)

        # 按 priority 排序 (1 = 最高)
        filtered.sort(key=lambda x: x.get("priority", 5))

        self.blackboard.write("review", {
            "suggestions": filtered,
            "summary": parsed.get("summary", ""),
            "conflicts": parsed.get("conflicts_found", []),
            "notes": parsed.get("notes", ""),
        })

        return True
