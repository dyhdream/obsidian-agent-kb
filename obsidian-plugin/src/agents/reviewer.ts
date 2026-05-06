/**
 * Agent 4: 品控官 (Reviewer)
 * 审查所有 Agent 的产出，去重、排序、冲突消解，产出给用户的最终建议。
 */

import { Agent } from "../agent_base";
import { sessionMemory } from "../session_memory";

const REVIEWER_PERSONA = `你是 Obsidian 知识库的「品控官」(Reviewer)。你审查前面所有 Agent 的产出，确保给用户的建议是高质量、无冗余、无冲突的。

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
}`;

export class Reviewer extends Agent {
  role = "reviewer";
  persona = REVIEWER_PERSONA;

  systemPrompt(): string {
    return this.persona + this.injectPreferences();
  }

  userPrompt(): string {
    const findings = this.blackboard.read("findings");
    const rejected = sessionMemory.getRejectedInSession();

    const links = findings.links || [];
    const concepts = findings.concepts || [];
    const orphans = findings.orphans || [];
    const tags = findings.tags || [];
    const structure = findings.structure || {};

    const lines: string[] = [];

    lines.push(`## 链接师产出 (${links.length} 条)`);
    for (const l of links) {
      lines.push(`  - link → [[${l.target}]] (${l.confidence.toFixed(2)}) ${l.reason}`);
    }

    lines.push(`\n## 新概念 (${concepts.length} 个)`);
    for (const c of concepts) {
      lines.push(`  - concept → ${c}`);
    }

    lines.push(`\n## 孤岛笔记 (${orphans.length} 个)`);
    for (const o of orphans.slice(0, 5)) {
      lines.push(`  - orphan → ${o.note_title}`);
    }

    lines.push(`\n## 架构师产出: 标签 (${tags.length} 条)`);
    for (const t of tags) {
      lines.push(`  - tag → #${t.current} → #${t.suggested}`);
    }

    lines.push("\n## 架构师产出: 结构");
    const split = structure.split || {};
    const merge = structure.merge || {};
    const moc = structure.moc || {};
    const fm = structure.frontmatter || {};
    lines.push(`  - split: ${split.needs_split || false} → ${(split.suggested_topics || []).join(", ")}`);
    lines.push(`  - merge: ${merge.needs_merge || false}`);
    lines.push(`  - moc: ${moc.needs_moc || false} → ${moc.topic || ""}`);
    lines.push(`  - frontmatter: ${fm.missing_fields ? "缺失字段: " + (fm.missing_fields as string[]).join(", ") : "OK"}`);

    const rejectedStr = rejected.length > 0
      ? rejected.slice(0, 20).map((r) => `- ${r}`).join("\n")
      : "无";

    return `请审查以下所有 Agent 的分析产出，生成最终建议。

${lines.join("\n")}

本次会话已被拒绝的项目（注意降低这些相关建议的优先级）:
${rejectedStr}

请输出 JSON 结果。`;
  }

  handleResponse(raw: string): boolean {
    const parsed = Reviewer.parseJson(raw);
    const rawSuggestions = (parsed.suggestions as Array<Record<string, unknown>>) || [];

    // 去重 + 过滤会话内已拒绝
    const seen = new Set<string>();
    const filtered: Array<Record<string, unknown>> = [];

    for (const s of rawSuggestions) {
      const key = `${s.type || ""}:${s.title || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (sessionMemory.isRejected(String(s.type || ""), String(s.title || ""))) {
        continue;
      }

      filtered.push(s);
    }

    // 按 priority 排序 (1 = 最高)
    filtered.sort((a, b) => (Number(a.priority) || 5) - (Number(b.priority) || 5));

    this.blackboard.write("review", {
      suggestions: filtered.map((s) => ({
        type: String(s.type || ""),
        priority: Number(s.priority) || 5,
        title: String(s.title || ""),
        description: String(s.description || ""),
        confidence: Number(s.confidence) || 0,
        source_agent: String(s.source_agent || ""),
        is_conflicted: Boolean(s.is_conflicted),
        conflict_note: String(s.conflict_note || ""),
      })),
      summary: (parsed.summary as string) || "",
      conflicts: (parsed.conflicts_found as Array<Record<string, unknown>>) || [],
      notes: (parsed.notes as string) || "",
    });

    return true;
  }
}
