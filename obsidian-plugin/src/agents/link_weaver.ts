/**
 * Agent 2: 链接师 (LinkWeaver)
 * 基于黑板的上下文信息，建议链接关系、发现新概念、识别孤岛笔记。
 */

import { Agent } from "../agent_base";
import { TitleEntry, RelatedNoteProfile } from "../blackboard";

const LINK_WEAVER_PERSONA = `你是 Obsidian 知识库的「链接师」(Link Weaver)。你的工作是发现笔记之间的关联。

## 职责
1. 建议当前笔记应与哪些已有笔记建立链接
2. 发现值得独立成篇的新概念（vault 中还不存在的）
3. 识别孤岛笔记（连接数太少、未充分利用）

## 约束
- **只能建议链接到「可用笔记列表」中的笔记**
- 不要建议当前笔记中已存在的 [[链接]]
- 不要建议链接到当前笔记自身
- Confidence 在 0.5-1.0 之间

## 输出格式（严格 JSON）
{
  "links": [
    {"target": "目标笔记标题", "anchor_text": "锚点文本", "reason": "原因", "confidence": 0.0-1.0}
  ],
  "new_concepts": ["概念1"],
  "orphans": [
    {"note_title": "孤岛笔记标题", "reason": "原因"}
  ],
  "notes": "备注"
}`;

export class LinkWeaver extends Agent {
  role = "link_weaver";
  persona = LINK_WEAVER_PERSONA;

  systemPrompt(): string {
    return this.persona + this.injectPreferences();
  }

  userPrompt(): string {
    const current = this.blackboard.read("current");
    const vault = this.blackboard.read("vault");
    const context = this.blackboard.read("context");
    const related = this.blackboard.read("related");
    const findings = this.blackboard.read("findings");

    const content = current.content;
    const keyEntities = findings.keyEntities || [];

    // 已有链接
    const existingRegex = /\[\[([^\]|]+)/g;
    const existing: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = existingRegex.exec(content)) !== null) {
      existing.push(match[1].trim());
    }
    const existingStr = existing.length > 0
      ? existing.slice(0, 15).map((w) => `[[${w}]]`).join(", ")
      : "无";

    // 语义相近笔记（优先级最高）
    let relatedStr = "无";
    if (related.length > 0) {
      relatedStr = related
        .slice(0, 10)
        .map(
          (r) =>
            `- ${r.title} (${r.keyTopics.slice(0, 3).join(", ")}) — ${r.summary}`
        )
        .join("\n");
    }

    // 同目录笔记
    const sameDirStr =
      context.sameDir.length > 0
        ? context.sameDir.map((n) => `- ${n.title}`).join("\n")
        : "无";

    // 补充标题列表（语义库覆盖不到的）
    const seenTitles = new Set(related.map((r) => r.title.toLowerCase()));
    const additionalTitles: string[] = [];
    for (const n of context.sameDir) {
      if (!seenTitles.has(n.title.toLowerCase())) {
        additionalTitles.push(n.title);
        seenTitles.add(n.title.toLowerCase());
      }
    }
    for (const n of context.matched) {
      if (!seenTitles.has(n.title.toLowerCase()) && additionalTitles.length < 15) {
        additionalTitles.push(n.title);
        seenTitles.add(n.title.toLowerCase());
      }
    }
    const additionalStr =
      additionalTitles.length > 0
        ? additionalTitles.map((t) => `- ${t}`).join("\n")
        : "无";

    return `当前笔记: ${current.title}
标签: ${current.tags.join(", ")}

已有链接（不要重复）: ${existingStr}

◇ 语义相近笔记（最高优先级，语义上最可能需要链接）:
${relatedStr}

◇ 同目录笔记:
${sameDirStr}

◇ 其他相关笔记:
${additionalStr}

核心实体: ${keyEntities.slice(0, 8).join(", ")}
笔记总数: ${vault.totalNotes}

输出 JSON。`;
  }

  handleResponse(raw: string): boolean {
    const parsed = LinkWeaver.parseJson(raw);
    const content = this.blackboard.read("current").content;

    // 提取已有链接
    const existingRegex = /\[\[([^\]|]+)/g;
    const existing = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = existingRegex.exec(content)) !== null) {
      existing.add(match[1].trim().toLowerCase());
    }

    // 已存在的笔记标题集合（硬过滤）
    const allTitles = this.blackboard.read("vault").allTitles;
    const validTitles = new Map<string, (typeof allTitles)[0]>();
    for (const t of allTitles) {
      validTitles.set(t.title.toLowerCase(), t);
    }

    const links = (parsed.links as Array<Record<string, unknown>>) || [];
    const filteredLinks: Array<Record<string, unknown>> = [];

    for (const l of links) {
      const target = String(l.target || "").trim();
      const targetLower = target.toLowerCase();
      const confidence = Number(l.confidence || 0);

      if (existing.has(targetLower)) continue;
      if (!validTitles.has(targetLower)) continue;
      if (confidence < 0.5) continue;

      filteredLinks.push(l);
    }

    this.blackboard.updateFindings({
      links: filteredLinks.map((l) => ({
        target: String(l.target || ""),
        anchor_text: String(l.anchor_text || ""),
        reason: String(l.reason || ""),
        confidence: Number(l.confidence || 0),
      })),
      concepts: (parsed.new_concepts as string[]) || [],
      orphans: ((parsed.orphans as Array<Record<string, unknown>>) || []).map((o) => ({
        note_title: String(o.note_title || ""),
        reason: String(o.reason || ""),
      })),
      linkNotes: (parsed.notes as string) || "",
    });
    return true;
  }
}
