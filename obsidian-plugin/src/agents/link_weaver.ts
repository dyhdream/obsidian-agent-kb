/**
 * Agent 2: 链接师 (LinkWeaver)
 * 基于黑板的上下文信息，建议链接关系、发现新概念、识别孤岛笔记。
 */

import { Agent } from "../agent_base";

const LINK_WEAVER_PERSONA = `你是 Obsidian 知识库的「链接师」(Link Weaver)。你的工作是发现笔记之间的关联。

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
      ? existing.slice(0, 15).map((w) => `- [[${w}]]`).join("\n")
      : "无";

    // 同目录笔记
    const sameDir = context.sameDir;
    const sameStr = sameDir.length > 0
      ? sameDir.map((n) => `- ${n.title} (@ ${n.dir}, tags: ${n.tags.slice(0, 3).join(",")})`).join("\n")
      : "无";

    // 标题匹配
    const matched = context.matched;
    const matchedStr = matched.length > 0
      ? matched.map((n) => `- ${n.title}`).join("\n")
      : "无";

    // 全量标题（链接候选）
    const allTitles = vault.allTitles;
    let titlesStr = allTitles.slice(0, 80).map((t) => `- ${t.title}`).join("\n");
    if (allTitles.length > 80) {
      titlesStr += `\n... 还有 ${allTitles.length - 80} 篇`;
    }

    return `当前笔记: ${current.title}
标签: ${current.tags.join(", ")}

已有链接（不要重复）:
${existingStr}

◇ 同目录笔记（关联最大，优先考虑）:
${sameStr}

◇ 标题匹配:
${matchedStr}

◇ 可用笔记列表（只有这些可以建议 [[链接]]）:
${titlesStr}

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
