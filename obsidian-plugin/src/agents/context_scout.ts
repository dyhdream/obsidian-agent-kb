/**
 * Agent 1: 情报员 (ContextScout)
 * 扫描 Vault 上下文，为链接师和架构师提供参考。
 * 集成语义库：优先使用语义相近笔记，回退到规则匹配。
 */

import { App, TFile } from "obsidian";
import { collectVaultContext } from "../vault_context";
import { Blackboard, RelatedNoteProfile } from "../blackboard";
import { SemanticLibrary } from "../semantic_library";

export class ContextScout {
  /**
   * 静态方法：用 Obsidian API + 语义库收集 Vault 上下文并写入黑板
   */
  static scanVault(
    app: App,
    file: TFile,
    content: string,
    tags: string[],
    blackboard: Blackboard,
    semanticLibrary?: SemanticLibrary
  ): void {
    const ctx = collectVaultContext(app, file, content, tags, semanticLibrary);

    blackboard.write("current", {
      noteId: file.path,
      filePath: file.path,
      title: file.basename,
      content: content.slice(0, 3000),
      tags,
    });

    blackboard.write("similar", []);
    blackboard.write("vault", {
      totalNotes: ctx.totalNotes,
      allTitles: ctx.allTitles,
      existingTags: ctx.existingTags,
    });

    blackboard.write("context", {
      sameDir: ctx.sameDir,
      matched: ctx.matched,
    });

    // 写入语义相近笔记
    const related: RelatedNoteProfile[] = ctx.related.map((r) => ({
      path: r.profile.path,
      title: r.profile.title,
      summary: r.profile.summary,
      keyTopics: r.profile.keyTopics,
      score: r.score,
      reason: r.reason,
    }));
    blackboard.write("related", related);

    // 写入客户端提取的核心实体
    blackboard.updateFindings({
      keyEntities: ctx.keyEntities,
    });
  }
}
