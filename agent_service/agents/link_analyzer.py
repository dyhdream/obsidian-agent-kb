import json
import re
from ..deepseek_client import client as ds
from ..preference_learner import preference_learner

LINK_ANALYZER_SYSTEM = """你是一个 Obsidian 知识库链接分析专家。你的任务是根据当前笔记的内容和知识库上下文，建议合理的链接关系。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{
  "links": [
    {
      "target": "目标笔记标题（不含路径和扩展名）",
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
    "当前笔记中值得单独创建新笔记的核心概念"
  ]
}"""


class LinkAnalyzer:
    async def analyze(self, context: dict) -> dict:
        similar_summary = self._format_similar(context.get("similar_notes", []))
        linked_summary = "\n".join(f"- [[{n}]]" for n in context.get("linked_notes", []))

        user_prompt = f"""当前笔记标题：{context['title']}
当前笔记标签：{', '.join(context.get('tags', []))}
当前笔记路径：{context['file_path']}

当前笔记内容（截取）：
---
{context['content']}
---

已有直接链接：
{linked_summary or '无'}

语义最接近的笔记（可能相关）：
{similar_summary}

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

    def _parse_json(self, raw: str) -> dict:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return {"links": [], "orphans": [], "new_concepts": []}


link_analyzer = LinkAnalyzer()
