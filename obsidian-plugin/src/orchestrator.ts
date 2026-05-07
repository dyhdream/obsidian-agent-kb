/**
 * 编排器 — Agent 协作工作流（语义库增强版）
 * 情报员(语义库扫描) → 链接师+架构师(并行) → 品控官(后台异步)
 */

import { App, TFile } from "obsidian";
import { Blackboard, FinalSuggestion } from "./blackboard";
import { ContextScout } from "./agents/context_scout";
import { LinkWeaver } from "./agents/link_weaver";
import { StructureGuardian } from "./agents/structure_guardian";
import { Reviewer } from "./agents/reviewer";
import { SemanticLibrary } from "./semantic_library";
import { PreferenceLearner } from "./preference_learner";
import { sessionMemory } from "./session_memory";
import { AgentKBSettings } from "../settings";

export type AnalysisPhase = "scout" | "agents" | "reviewer" | "done";

export interface AnalysisCallbacks {
  onPhase?: (phase: AnalysisPhase, label: string) => void;
  onReviewerComplete?: (suggestions: FinalSuggestion[]) => void;
}

export class Orchestrator {
  private settings: AgentKBSettings;
  private preferenceLearner: PreferenceLearner;
  private semanticLibrary?: SemanticLibrary;

  constructor(
    settings: AgentKBSettings,
    preferenceLearner: PreferenceLearner,
    semanticLibrary?: SemanticLibrary
  ) {
    this.settings = settings;
    this.preferenceLearner = preferenceLearner;
    this.semanticLibrary = semanticLibrary;
  }

  updateSettings(settings: AgentKBSettings): void {
    this.settings = settings;
  }

  updateSemanticLibrary(lib: SemanticLibrary): void {
    this.semanticLibrary = lib;
  }

  /**
   * 分析流程：
   * 1. 语义库扫描上下文 + 客户端 keyEntities（瞬间完成）
   * 2. LinkWeaver + StructureGuardian 并行
   * 3. Reviewer 后台异步
   */
  async analyze(
    app: App,
    file: TFile,
    content: string,
    tags: string[],
    callbacks?: AnalysisCallbacks
  ): Promise<FinalSuggestion[]> {
    const bb = new Blackboard();
    bb.clearSession();

    // Phase 1: 情报员扫描（Obsidian API + 语义库，< 0.1s）
    callbacks?.onPhase?.("scout", "扫描知识库...");
    ContextScout.scanVault(app, file, content, tags, bb, this.semanticLibrary);

    // 增量更新当前笔记的 NoteProfile（异步，不阻塞）
    if (this.semanticLibrary) {
      this.semanticLibrary.generateProfile(file, app).catch(() => {});
    }

    // Phase 2: 链接师 + 架构师 并行
    callbacks?.onPhase?.("agents", "链接师 & 架构师分析中...");
    await Promise.all([
      new LinkWeaver(bb, this.settings, this.preferenceLearner).run(),
      new StructureGuardian(bb, this.settings, this.preferenceLearner).run(),
    ]);

    const phase2Suggestions = this.buildIntermediateSuggestions(bb, file.path);

    // Phase 3: 品控官后台异步
    callbacks?.onPhase?.("reviewer", "品控官审核中...");
    this.runReviewerAsync(bb, callbacks);

    callbacks?.onPhase?.("done", "完成");
    return phase2Suggestions;
  }

  private async runReviewerAsync(bb: Blackboard, callbacks?: AnalysisCallbacks): Promise<void> {
    try {
      await new Reviewer(bb, this.settings, this.preferenceLearner).run();
      const review = bb.read("review");
      if (review.suggestions.length > 0) {
        callbacks?.onReviewerComplete?.(review.suggestions);
      }
    } catch {
      // Reviewer 失败不影响已有建议
    }
  }

  recordFeedback(actionType: string, suggestion: string, accepted: boolean): void {
    this.preferenceLearner.record(actionType, suggestion, accepted);
    if (!accepted) {
      sessionMemory.recordRejection(actionType, suggestion);
    }
  }

  private buildIntermediateSuggestions(bb: Blackboard, filePath: string): FinalSuggestion[] {
    const findings = bb.read("findings");
    const sugs: FinalSuggestion[] = [];

    for (const l of findings.links || []) {
      sugs.push({
        type: "link",
        priority: 1,
        title: `链接到 [[${l.target}]]`,
        description: `锚点: "${l.anchor_text}" — ${l.reason}`,
      });
    }
    for (const c of findings.concepts || []) {
      sugs.push({
        type: "concept",
        priority: 2,
        title: `可新建: ${c}`,
        description: "知识库中暂无此概念对应笔记",
      });
    }
    for (const o of findings.orphans || []) {
      sugs.push({
        type: "orphan",
        priority: 3,
        title: `孤岛笔记: ${o.note_title}`,
        description: o.reason,
      });
    }

    for (const t of findings.tags || []) {
      sugs.push({
        type: "tag",
        priority: 3,
        title: `#${t.current} → #${t.suggested}`,
        description: t.reason,
      });
    }

    const structure = findings.structure || {};
    const split = structure.split || {};
    if (split.needs_split) {
      sugs.push({
        type: "structure",
        priority: 2,
        title: "建议拆分笔记",
        description: `${split.reason || ""} → 主题: ${(split.suggested_topics || []).join("、")}`,
      });
    }

    const fm = structure.frontmatter || {};
    const missing = (fm.missing_fields as string[]) || [];
    if (missing.length > 0) {
      sugs.push({
        type: "structure",
        priority: 1,
        title: "前言字段缺失",
        description: `缺少: ${missing.join("、")}`,
      });
    }

    const moc = structure.moc || {};
    if (moc.needs_moc) {
      sugs.push({
        type: "moc",
        priority: 3,
        title: `建议创建 MOC: ${moc.topic || ""}`,
        description: String(moc.reason || ""),
      });
    }

    return sugs;
  }
}
