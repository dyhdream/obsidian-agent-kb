from ..deepseek_client import client as ds
from ..utils import parse_json

SPLIT_SYSTEM = """你是一个 Obsidian 知识库笔记撰写专家。输出必须严格遵循 Obsidian 格式规范。

## 强制格式规范

1. **YAML frontmatter（必须放在文件最顶部）**：
```yaml
---
aliases: [别名1, 别名2]
tags: [标签1, 标签2]
created: YYYY-MM-DD
---
```
2. **内部链接**：使用 `[[笔记标题]]` 或 `[[笔记标题|显示文字]]`，不要用 Markdown 链接
3. **标签**：在 frontmatter 中用 YAML 数组，内容中可加 `#标签` 但不强制
4. **标题层级**：内容从 `##` 开始（文件名即一级标题），不要用 `# 标题` 开头
5. **Callout 提示**：使用 `> [!note]` / `> [!tip]` / `> [!warning]` 语法
6. **嵌入**：使用 `![[笔记标题]]`
7. **内容密度**：每段 2-4 行，要点用列表，关键概念用 `[[链接]]` 标记

## 禁止事项
- 禁止使用 `[文字](url)` 外部链接格式（内部全部用 `[[]]`）
- 禁止以 `# 标题` 作为第一行
- 禁止在内容中重复写 frontmatter 以外的"标签:"、"别名:"等元数据行

严格按以下 JSON 格式输出，不要输出任何其他内容：
{
  "files": [
    {
      "title": "新笔记标题（纯文本，不含扩展名）",
      "content": "新笔记的完整 Obsidian 格式内容（含 YAML frontmatter）",
      "reason": "这个主题为什么独立成篇"
    }
  ],
  "remaining": "拆分后原笔记中精简版内容（Obsidian 格式，含 frontmatter，保留对各子主题的 [[链接]]）"
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
        return parse_json(raw)

    def _parse_json(self, raw: str) -> dict:
        return parse_json(raw)


note_splitter = NoteSplitter()
