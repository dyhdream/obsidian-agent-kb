/**
 * 编排器 — Agent 协作工作流
 * 情报员 → 链接师 + 架构师 → 品控官
 * 黑板驱动，前一 Agent 的产出对后续 Agent 可见。
 */

import { App, TFile } from "obsidian";
import { Blackboard, FinalSuggestion } from "./blackboard";
import { ContextScout } from "./agents/context_scout";
import { LinkWeaver } from "./agents/link_weaver";
import { StructureGuardian } from "./agents/structure_guardian";
import { Reviewer } from "./agents/reviewer";
import { PreferenceLearner } from "./preference_learner";
import { sessionMemory } from "./session_memory";
import { AgentKBSettings } from "../settings";

export type AnalysisPhase = "scout" | "agents" | "reviewer" | "done";

export interface AnalysisResult {
  suggestions: FinalSuggestion[];
  summary: string;
  phase: AnalysisPhase;
}

export interface AnalysisCallbacks {
  onPhase?: (phase: AnalysisPhase, label: string) => void;
  onSuggestions?: (suggestions: FinalSuggestion[]) => void;
}

export class Orchestrator {
  private settings: AgentKBSettings;
  private preferenceLearner: PreferenceLearner;

  constructor(settings: AgentKBSettings, preferenceLearner: PreferenceLearner) {
    this.settings = settings;
    this.preferenceLearner = preferenceLearner;
  }

  updateSettings(settings: AgentKBSettings): void {
    this.settings = settings;
  }

  /**
   * 完整分析流程
   */
  async analyze(
    app: App,
    file: TFile,
    content: string,
    tags: string[],
    callbacks?: AnalysisCallbacks
  ): Promise<AnalysisResult> {
    const bb = new Blackboard();
    bb.clearSession();

    // Phase 1: 情报员扫描 (纯 Obsidian API，无 LLM)
    callbacks?.onPhase?.("scout", "扫描知识库...");
    ContextScout.scanVault(app, file, content, tags, bb);

    try {
      await new ContextScout(bb, this.settings, this.preferenceLearner).run();
    } catch {
      // 情报员 LLM 失败不影响后续
    }

    // Phase 2: 链接师 + 架构师 并行 (~12s)
    callbacks?.onPhase?.("agents", "链接师 & 架构师分析中...");
    const [linkResult, structResult] = await Promise.all([
      new LinkWeaver(bb, this.settings, this.preferenceLearner).run(),
      new StructureGuardian(bb, this.settings, this.preferenceLearner).run(),
    ]);

    // 合并中间产出
    const midSuggestions = this.buildIntermediateSuggestions(bb, file.path);
    callbacks?.onSuggestions?.(midSuggestions);

    // Phase 3: 品控官
    callbacks?.onPhase?.("reviewer", "品控官审核中...");
    try {
      await new Reviewer(bb, this.settings, this.preferenceLearner).run();
    } catch {
      // 品控官失败，使用中间产出
    }

    // 构建最终结果
    const review = bb.read("review");
    const finalSuggestions = review.suggestions.length > 0 ? review.suggestions : midSuggestions;

    callbacks?.onPhase?.("done", "完成");

    return {
      suggestions: finalSuggestions,
      summary: review.summary || "分析完成",
      phase: "done",
    };
  }

  /**
   * 记录用户反馈
   */
  recordFeedback(actionType: string, suggestion: string, accepted: boolean): void {
    this.preferenceLearner.record(actionType, suggestion, accepted);
    if (!accepted) {
      sessionMemory.recordRejection(actionType, suggestion);
    }
  }

  /**
   * 构建中间建议（品控官产出前）
   */
  private buildIntermediateSuggestions(bb: Blackboard, filePath: string): FinalSuggestion[] {
    const findings = bb.read("findings");
    const sugs: FinalSuggestion[] = [];

    // 链接师产出
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

    // 架构师产出
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
