import json
import re
from ..deepseek_client import client as ds

SPLIT_SYSTEM = """你是一个知识库笔记拆分专家。根据原笔记内容和需要拆分的主题列表，将原笔记拆分为多个独立文件。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{
  "files": [
    {
      "title": "新笔记标题",
      "content": "新笔记的完整 Markdown 内容（包含前言和标签）",
      "reason": "这个主题为什么独立成篇"
    }
  ],
  "remaining": "拆分后原笔记中剩余的核心内容（精简版，保留对各个子主题的链接）"
}"""


class NoteSplitter:
    async def split(self, file_path: str, content: str, topics: list[str]) -> dict:
        user_prompt = f"""原笔记标题：{file_path}
原笔记的内容：
---
{content}
---

需要拆分为以下主题：{', '.join(topics)}

请为每个主题生成独立的笔记内容，并为原笔记保留一个精简版。"""

        messages = [
            {"role": "system", "content": SPLIT_SYSTEM},
            {"role": "user", "content": user_prompt},
        ]

        raw = await ds.chat(messages, temperature=0.3, max_tokens=4096)
        return self._parse_json(raw)

    def _parse_json(self, raw: str) -> dict:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return {"files": [], "remaining": ""}


note_splitter = NoteSplitter()
