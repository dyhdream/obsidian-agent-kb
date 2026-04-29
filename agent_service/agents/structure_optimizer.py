import json
import re
from ..deepseek_client import client as ds
from ..preference_learner import preference_learner

STRUCTURE_OPTIMIZER_SYSTEM = """你是一个 Obsidian 知识库结构优化专家。你的任务是根据当前笔记的内容和元数据，检查结构合理性和维护建议。

格式规范提醒：
- YAML frontmatter 应包含 aliases、tags、created 等字段
- 内部链接统一使用 [[笔记标题]] 格式
- 标签归一化：全小写、中划线连接（如 #machine-learning 而非 #MachineLearning）

严格按以下 JSON 格式输出，不要输出任何其他内容：
{
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
  "tag_suggestions": [
    {
      "current": "当前使用的标签",
      "suggested": "建议的标准化标签",
      "reason": "归一化原因"
    }
  ],
  "moc_suggestion": {
    "needs_moc": true/false,
    "topic": "MOC 主题名称",
    "reason": "为什么需要创建 MOC"
  },
  "frontmatter_check": {
    "missing_fields": ["缺失的前言字段"],
    "issues": ["其他问题"]
  }
}"""


class StructureOptimizer:
    async def analyze(self, context: dict) -> dict:
        thresholds = preference_learner.get_thresholds()

        content_len = len(context["content"])
        tags = context.get("tags", [])

        user_prompt = f"""当前笔记标题：{context['title']}
当前笔记标签：{', '.join(tags)}
当前笔记路径：{context['file_path']}
当前笔记字数：{content_len}
同标签簇笔记数量：{len(context.get('linked_notes', []))}
知识库总笔记数：{context['total_notes']}

阈值参考：
- 建议拆分字数阈值：{thresholds['split_min_chars']}
- 建议合并字数阈值：{thresholds['merge_max_chars']}
- 建议创建 MOC 阈值：{thresholds['moc_cluster_min']} 篇

当前笔记内容（截取）：
---
{context['content']}
---

请按 JSON 格式返回分析结果。"""

        messages = [
            {"role": "system", "content": STRUCTURE_OPTIMIZER_SYSTEM},
            {"role": "user", "content": user_prompt},
        ]

        raw = await ds.chat(messages, temperature=0.3, max_tokens=2048)
        parsed = self._parse_json(raw)
        return parsed

    def _parse_json(self, raw: str) -> dict:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return {
            "split_suggestion": {"needs_split": False},
            "merge_suggestion": {"needs_merge": False},
            "tag_suggestions": [],
            "moc_suggestion": {"needs_moc": False},
            "frontmatter_check": {"missing_fields": [], "issues": []},
        }


structure_optimizer = StructureOptimizer()
