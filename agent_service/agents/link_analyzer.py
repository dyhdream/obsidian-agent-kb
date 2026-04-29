import json
import re
from ..deepseek_client import client as ds

LINK_ANALYZER_SYSTEM = """你是一个 Obsidian 知识库链接分析专家。你的任务是根据当前笔记的内容和知识库上下文，建议合理的链接关系。

重要规则：
1. **只能建议链接到知识库中已存在的笔记**（见下方"知识库已有笔记列表"）。如果某个概念很相关但没有对应笔记，请将它放入 new_concepts。
2. 不要建议当前笔记中已经存在的链接（如笔记已有 [[某标题]] 就不要重复建议）
3. 不要建议链接到当前笔记自身
4. confidence 值在 0.5-1.0 之间

严格按以下 JSON 格式输出，不要输出任何其他内容：
{
  "links": [
    {
      "target": "目标笔记标题（必须来自知识库已有笔记列表中的标题）",
      "anchor_text": "当前笔记中适合作为链接锚点的文本",
      "reason": "建议链接的原因",
      "confidence": 0.0-1.0,
      "direction": "bidirectional | forward | backlink"
    }
  ],
  "orphans": [
    {
      "note_id": "孤岛笔记 ID（来自 similar_notes）",
      "reason": "为什么这个笔记是孤岛",
      "suggested_link": "建议连接的笔记标题"
    }
  ],
  "new_concepts": [
    "当前笔记中值得单独创建新笔记的核心概念（知识库中还不存在的）"
  ]
}"""


class LinkAnalyzer:
    async def analyze(self, context: dict) -> dict:
        similar_summary = self._format_similar(context.get("similar_notes", []))
        linked_summary = "\n".join(f"- [[{n}]]" for n in context.get("linked_notes", []))
        existing_wikilinks = self._extract_wikilinks(context.get("content", ""))
        existing_summary = "\n".join(f"- [[{w}]]" for w in existing_wikilinks) if existing_wikilinks else "无"

        all_titles = context.get("all_titles", [])
        titles_list = "\n".join(f"- {t['title']}" for t in all_titles) if all_titles else "(空)"

        user_prompt = f"""当前笔记标题：{context['title']}
当前笔记标签：{', '.join(context.get('tags', []))}
当前笔记路径：{context['file_path']}

当前笔记内容（截取）：
---
{context['content']}
---

当前笔记中已有的 Wiki 链接（严禁重复建议）：
{existing_summary}

相同标签的笔记：
{linked_summary or '无'}

语义最接近的笔记（可能相关）：
{similar_summary}

知识库已有全部笔记列表（只有这些标题可以建议链接，不在列表中的概念放入 new_concepts）：
{titles_list}

知识库总笔记数：{context['total_notes']}

请按 JSON 格式返回分析结果。"""

        messages = [
            {"role": "system", "content": LINK_ANALYZER_SYSTEM},
            {"role": "user", "content": user_prompt},
        ]

        raw = await ds.chat(messages, temperature=0.3, max_tokens=2048)
        parsed = self._parse_json(raw)
        return parsed

    def _format_similar(self, similar_notes: list[dict]) -> str:
        if not similar_notes:
            return "无"
        lines = []
        for n in similar_notes:
            lines.append(f"- [{n['id']}] 标题: {n['title']} | 相关度: {1 - n['distance']:.2f}")
            preview = n["content"][:200].replace("\n", " ")
            lines.append(f"  内容预览: {preview}")
        return "\n".join(lines)

    def _extract_wikilinks(self, content: str) -> list[str]:
        matches = re.findall(r"\[\[([^\]|]+)", content)
        return list(set(m.strip() for m in matches))

    def _parse_json(self, raw: str) -> dict:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return {"links": [], "orphans": [], "new_concepts": []}


link_analyzer = LinkAnalyzer()
