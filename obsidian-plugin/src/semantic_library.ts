/**
 * SemanticLibrary — 语义库核心模块
 * 为每篇笔记生成语义档案 (NoteProfile)，支持相近笔记查询和主题聚类。
 * 通过 Obsidian Plugin Data 持久化，关闭不丢失。
 */

import { App, TFile } from "obsidian";
import { getClient } from "./deepseek_client";
import { parseJson } from "./utils";

// ── 类型定义 ──

export interface NoteProfile {
  path: string;
  title: string;
  summary: string;        // 一句话概述（50-100字）
  keyTopics: string[];    // 核心主题
  category: string;       // 自动分类：技术 | 科学 | 历史 | 人文 | 生活 | 学习 | 商业 | 艺术
  lastUpdated: number;    // 记录最后更新时间（mtime）
}

export interface RelatedNote {
  profile: NoteProfile;
  score: number;           // 相关度 0-1
  reason: string;          // 关联理由
}

export interface LibraryData {
  profiles: Record<string, NoteProfile>;
  version: number;
}

// ── 分类标准 ──

const CATEGORIES = [
  "技术", "科学", "历史", "人文", "生活", "学习", "商业", "艺术", "其他",
];

// ── 语义库类 ──

export class SemanticLibrary {
  private profiles: Map<string, NoteProfile> = new Map();
  private saveFn: (data: LibraryData) => void;

  constructor(
    saveFn: (data: LibraryData) => void,
    initialData?: LibraryData
  ) {
    this.saveFn = saveFn;
    if (initialData?.profiles) {
      for (const [path, profile] of Object.entries(initialData.profiles)) {
        this.profiles.set(path, profile);
      }
    }
  }

  // ── 查询 ──

  getProfile(path: string): NoteProfile | undefined {
    return this.profiles.get(path);
  }

  getAllProfiles(): NoteProfile[] {
    return Array.from(this.profiles.values());
  }

  getProfileCount(): number {
    return this.profiles.size;
  }

  getCategories(): string[] {
    return CATEGORIES;
  }

  /**
   * 获取某个分类下的所有笔记
   */
  getByCategory(category: string): NoteProfile[] {
    return Array.from(this.profiles.values()).filter(
      (p) => p.category === category
    );
  }

  /**
   * 从语义库中查找与给定笔记语义相近的笔记
   * 第一层：关键词重叠预筛选（快）
   * 第二层：LLM 语义确认（准，可选）
   */
  findRelated(
    target: NoteProfile,
    excludePath?: string,
    limit: number = 10
  ): RelatedNote[] {
    const candidates: Array<{ profile: NoteProfile; score: number }> = [];

    for (const [path, profile] of this.profiles) {
      if (path === excludePath) continue;

      // 基于主题关键词重叠计算初始分数
      const targetTopics = new Set(
        [...target.keyTopics, ...target.summary.split(/[，,、\s]+/)].map((s) =>
          s.toLowerCase()
        )
      );
      const profileTopics = new Set(
        [...profile.keyTopics, ...profile.summary.split(/[，,、\s]+/)].map((s) =>
          s.toLowerCase()
        )
      );

      let overlap = 0;
      for (const t of targetTopics) {
        if (t.length >= 2 && profileTopics.has(t)) overlap++;
      }

      const maxLen = Math.max(targetTopics.size, profileTopics.size, 1);
      let score = overlap / maxLen;

      // 同类别加分
      if (target.category === profile.category) score += 0.15;

      if (score > 0.05) {
        candidates.push({ profile, score: Math.min(score, 1.0) });
      }
    }

    // 按分数排序，取前 limit 个
    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, limit).map((c) => ({
      profile: c.profile,
      score: c.score,
      reason: `主题重叠: ${c.profile.keyTopics.join(", ")}`,
    }));
  }

  // ── 生成 / 更新 ──

  /**
   * 为单篇笔记生成 NoteProfile（调用 DeepSeek）
   */
  async generateProfile(file: TFile, app: App): Promise<NoteProfile> {
    const content = await app.vault.read(file);
    const contentSnippet = content.slice(0, 1500);

    const raw = await getClient().chat(
      [
        {
          role: "system",
          content: `你是一个知识库分析专家。根据笔记内容生成简洁的语义档案。

## 输出格式（严格 JSON）
{
  "summary": "一句话概述笔记核心内容（50-100字）",
  "key_topics": ["核心主题1", "核心主题2", "核心主题3"],
  "category": "${CATEGORIES.join(" | ")}"
}

## 要求
- summary 必须精准概括核心内容，不要废话
- key_topics 3-5 个，用名词短语
- category 必须是上面列出的选项之一
- 只输出 JSON，不要其他内容`,
        },
        {
          role: "user",
          content: `笔记标题: ${file.basename}
路径: ${file.path}

内容:
---
${contentSnippet}
---

输出 JSON。`,
        },
      ],
      { temperature: 0.2, maxTokens: 256 }
    );

    const parsed = parseJson(raw);
    const profile: NoteProfile = {
      path: file.path,
      title: file.basename,
      summary: String(parsed.summary || ""),
      keyTopics: Array.isArray(parsed.key_topics)
        ? (parsed.key_topics as string[]).slice(0, 5)
        : [],
      category: CATEGORIES.includes(String(parsed.category))
        ? String(parsed.category)
        : "其他",
      lastUpdated: file.stat.mtime,
    };

    this.profiles.set(file.path, profile);
    this.persist();

    return profile;
  }

  /**
   * 增量更新：只处理发生变化的笔记（mtime 不同）
   * 返回 { updated, skipped, total }
   */
  async buildAll(
    app: App,
    onProgress?: (current: number, total: number, title: string) => void
  ): Promise<{ updated: number; skipped: number; total: number }> {
    const files = app.vault.getMarkdownFiles();
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.(i + 1, files.length, file.basename);

      const existing = this.profiles.get(file.path);
      // 增量：mtime 没变且已有 profile 则跳过
      if (existing && existing.lastUpdated >= file.stat.mtime) {
        skipped++;
        continue;
      }

      try {
        await this.generateProfile(file, app);
        updated++;
      } catch (e) {
        console.error(`SemanticLibrary: 生成 ${file.basename} 的档案失败`, e);
        skipped++;
      }
    }

    this.persist();
    return { updated, skipped, total: files.length };
  }

  /**
   * 用 LLM 批量发现笔记间的连接
   * 每次处理一个 batch（20 篇），返回跨笔记的链接建议
   */
  async discoverConnections(
    batchSize: number = 20
  ): Promise<
    Array<{
      source: string;
      target: string;
      reason: string;
      confidence: number;
    }>
  > {
    const allProfiles = this.getAllProfiles();
    const connections: Array<{
      source: string;
      target: string;
      reason: string;
      confidence: number;
    }> = [];

    // 按 batch 分组
    for (let i = 0; i < allProfiles.length; i += batchSize) {
      const batch = allProfiles.slice(i, i + batchSize);

      const profilesText = batch
        .map(
          (p, idx) =>
            `[${idx}] ${p.title} (${p.category}): ${p.summary} | 主题: ${p.keyTopics.join(", ")}`
        )
        .join("\n");

      try {
        const raw = await getClient().chat(
          [
            {
              role: "system",
              content: `你是一个知识库连接发现专家。分析以下笔记列表，找出它们之间的关联。

## 输出格式（严格 JSON 数组）
[
  {"from": "源笔记标题", "to": "目标笔记标题", "reason": "关联原因", "confidence": 0.0-1.0}
]

## 规则
- 只返回 confidence >= 0.6 的强关联
- from 和 to 必须是列表中已有的笔记标题
- 每条连接的 from 和 to 不能相同
- 最多返回 20 条连接
- 只输出 JSON 数组，不要其他内容`,
            },
            {
              role: "user",
              content: `笔记列表:\n${profilesText}\n\n输出 JSON 数组。`,
            },
          ],
          { temperature: 0.2, maxTokens: 1024 }
        );

        const parsed = parseJson(raw);
        if (Array.isArray(parsed)) {
          for (const conn of parsed) {
            if (conn.from && conn.to && conn.confidence >= 0.6) {
              // 找到对应的 profile path
              const fromProfile = batch.find((p) => p.title === conn.from);
              const toProfile = batch.find((p) => p.title === conn.to);
              if (fromProfile && toProfile) {
                connections.push({
                  source: fromProfile.path,
                  target: toProfile.path,
                  reason: String(conn.reason || ""),
                  confidence: Number(conn.confidence) || 0.7,
                });
              }
            }
          }
        }
      } catch (e) {
        console.error("SemanticLibrary: 批量发现连接失败", e);
      }
    }

    return connections;
  }

  /**
   * 按分类聚合，生成目录分类建议
   */
  getFolderSuggestions(): Array<{
    category: string;
    notes: NoteProfile[];
    suggestedFolder: string;
  }> {
    const groups = new Map<string, NoteProfile[]>();
    for (const profile of this.profiles.values()) {
      if (!groups.has(profile.category)) {
        groups.set(profile.category, []);
      }
      groups.get(profile.category)!.push(profile);
    }

    return Array.from(groups.entries())
      .filter(([_, notes]) => notes.length >= 3) // 至少 3 篇才建议归类
      .map(([category, notes]) => ({
        category,
        notes,
        suggestedFolder: category,
      }));
  }

  /**
   * 按主题聚类，生成 MOC 建议
   */
  getMocSuggestions(): Array<{
    topic: string;
    notes: NoteProfile[];
    reason: string;
  }> {
    // 按 keyTopics 聚合
    const topicMap = new Map<string, NoteProfile[]>();
    for (const profile of this.profiles.values()) {
      for (const topic of profile.keyTopics) {
        const normalized = topic.toLowerCase().trim();
        if (normalized.length < 2) continue;
        if (!topicMap.has(normalized)) {
          topicMap.set(normalized, []);
        }
        topicMap.get(normalized)!.push(profile);
      }
    }

    // 只保留有 5 篇以上笔记的主题
    return Array.from(topicMap.entries())
      .filter(([_, notes]) => notes.length >= 5)
      .map(([topic, notes]) => ({
        topic: topic.charAt(0).toUpperCase() + topic.slice(1),
        notes,
        reason: `${notes.length} 篇笔记涉及「${topic}」主题`,
      }));
  }

  // ── 持久化 ──

  private persist(): void {
    const data: LibraryData = {
      profiles: Object.fromEntries(this.profiles),
      version: 1,
    };
    this.saveFn(data);
  }

  /**
   * 清空语义库
   */
  clear(): void {
    this.profiles.clear();
    this.persist();
  }
}
