/**
 * Agent 3: 架构师 (StructureGuardian)
 * 检查笔记自身质量 — frontmatter、标签规范化、是否需要拆/合、MOC 维护。
 */

import { Agent } from "../agent_base";

const STRUCTURE_GUARDIAN_PERSONA = `你是 Obsidian 知识库的「架构师」(Structure Guardian)。你的工作是确保每篇笔记结构健康、标签规范。

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
}`;

export class StructureGuardian extends Agent {
  role = "structure_guardian";
  persona = STRUCTURE_GUARDIAN_PERSONA;

  systemPrompt(): string {
    return this.persona + this.injectPreferences();
  }

  userPrompt(): string {
    const current = this.blackboard.read("current");
    const vault = this.blackboard.read("vault");
    const findings = this.blackboard.read("findings");

    const content = current.content;
    const tags = current.tags;
    const existingTags = vault.existingTags;

    const linkConcepts = findings.concepts || [];
    const orphanCount = (findings.orphans || []).length;

    return `当前笔记: ${current.title}
路径: ${current.filePath}
字数: ${content.length}
标签: ${tags.join(", ")}

Vault 已有标签 (部分): ${existingTags.slice(0, 20).join(", ")}
Vault 笔记总数: ${vault.totalNotes}

链接师发现的新概念: ${linkConcepts.slice(0, 5).join(", ")}
链接师发现的孤岛笔记数: ${orphanCount}

笔记内容 (截取):
---
${content.slice(0, 3000)}
---

请输出 JSON 分析结果。`;
  }

  handleResponse(raw: string): boolean {
    const parsed = StructureGuardian.parseJson(raw);

    this.blackboard.updateFindings({
      tags: ((parsed.tag_suggestions as Array<Record<string, unknown>>) || []).map((t) => ({
        current: String(t.current || ""),
        suggested: String(t.suggested || ""),
        reason: String(t.reason || ""),
      })),
      structure: {
        frontmatter: (parsed.frontmatter_issues as Record<string, unknown>) || {},
        split: (parsed.split_suggestion as Record<string, unknown>) || {},
        merge: (parsed.merge_suggestion as Record<string, unknown>) || {},
        moc: (parsed.moc_suggestion as Record<string, unknown>) || {},
      },
      structureNotes: (parsed.notes as string) || "",
    });
    return true;
  }
}
