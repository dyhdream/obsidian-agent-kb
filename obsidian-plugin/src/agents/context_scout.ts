/**
 * Agent 1: 情报员 (ContextScout)
 * 纯索引查询版本。扫描 Vault 上下文，为链接师和架构师提供参考。
 */

import { App, TFile } from "obsidian";
import { Agent } from "../agent_base";
import { Blackboard } from "../blackboard";
import { collectVaultContext } from "../vault_context";

const CONTEXT_SCOUT_PERSONA = `你是 Obsidian 知识库的「情报员」(Context Scout)。
你的工作是提供当前笔记的上下文摘要，供链接师和架构师参考。

## 输出格式
{
  "context_summary": "一句话概述当前笔记的核心主题",
  "key_entities": ["核心概念1", "核心概念2"],
  "data_quality": "good | partial | minimal",
  "notes": "任何值得其他 Agent 注意的事项"
}`;

export class ContextScout extends Agent {
  role = "scout";
  persona = CONTEXT_SCOUT_PERSONA;

  systemPrompt(): string {
    return this.persona + this.injectPreferences();
  }

  userPrompt(): string {
    const current = this.blackboard.read("current");
    const similar = this.blackboard.read("similar");

    let similarLines = "";
    for (const n of similar.slice(0, 5)) {
      similarLines += `- ${n.title} (${n.tags.slice(0, 3).join(",")})\n`;
    }

    const context = this.blackboard.read("context");
    const sameDirStr = context.sameDir.map((n) => n.title).join(", ") || "无";
    const matchedStr = context.matched.map((n) => n.title).join(", ") || "无";

    return `当前笔记: ${current.title}
路径: ${current.filePath}
标签: ${current.tags.join(", ")}

同目录笔记: ${sameDirStr}
标题匹配笔记: ${matchedStr}
语义相似笔记:
${similarLines || "无"}

笔记内容 (截取):
---
${current.content.slice(0, 2000)}
---

输出 JSON。`;
  }

  handleResponse(raw: string): boolean {
    const parsed = ContextScout.parseJson(raw);
    this.blackboard.updateFindings({
      contextSummary: (parsed.context_summary as string) || "",
      keyEntities: (parsed.key_entities as string[]) || [],
      dataQuality: (parsed.data_quality as string) || "partial",
      scoutNotes: (parsed.notes as string) || "",
    });
    return true;
  }

  /**
   * 静态方法：用 Obsidian API 收集 Vault 上下文并写入黑板
   */
  static scanVault(app: App, file: TFile, content: string, tags: string[], blackboard: Blackboard): void {
    const ctx = collectVaultContext(app, file, content, tags);

    blackboard.write("current", {
      noteId: file.path,
      filePath: file.path,
      title: file.basename,
      content: content.slice(0, 3000),
      tags,
    });

    blackboard.write("similar", ctx.similar);
    blackboard.write("vault", {
      totalNotes: ctx.totalNotes,
      allTitles: ctx.allTitles,
      existingTags: ctx.existingTags,
    });

    blackboard.write("context", {
      sameDir: ctx.sameDir,
      matched: ctx.matched,
    });
  }
}
