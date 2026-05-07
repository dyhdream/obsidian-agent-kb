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

// ── 主题归一化 ──

/**
 * 归一化主题词：去除修饰语，保留核心词
 * "Python装饰器" → "装饰器"
 * "机器学习算法" → "机器学习"
 * "深度学习框架" → "深度学习"
 * "JavaScript异步编程" → "异步"
 */
function normalizeTopic(topic: string): string {
  let t = topic.toLowerCase().trim();

  // 去除常见前缀（编程语言名、框架名等）
  const prefixes = [
    "python", "javascript", "typescript", "java", "go", "rust", "c++",
    "react", "vue", "angular", "node", "docker", "kubernetes", "k8s",
    "redis", "mysql", "postgresql", "mongodb", "elasticsearch",
    "tensorflow", "pytorch", "nginx", "webpack", "git",
    "css", "html", "sql", "graphql", "rest", "oauth",
    "机器学习", "深度学习", "人工智能", "数据科学",
  ];
  for (const prefix of prefixes) {
    if (t.startsWith(prefix) && t.length > prefix.length) {
      t = t.slice(prefix.length).trim();
    }
  }

  // 去除常见后缀
  const suffixes = [
    "基础", "入门", "进阶", "高级", "原理", "实践", "技术", "方法",
    "算法", "框架", "工具", "库", "模块", "概念", "模式", "策略",
    "设计", "实现", "优化", "管理", "开发", "编程", "语言", "系统",
    "对比", "简介", "概述", "详解", "指南", "教程", "思想", "理论",
  ];
  for (const suffix of suffixes) {
    if (t.endsWith(suffix) && t.length > suffix.length + 1) {
      t = t.slice(0, -suffix.length).trim();
    }
  }

  return t;
}

/**
 * 计算两段文本的关键词重叠度
 */
function countSummaryOverlap(a: string, b: string): number {
  const extractWords = (text: string): Set<string> => {
    const words = new Set<string>();
    // 中文词（2-4字）
    const cn = text.match(/[\u4e00-\u9fa5]{2,4}/g);
    if (cn) cn.forEach((w) => words.add(w));
    // 英文词（首字母大写或全大写）
    const en = text.match(/\b[A-Za-z]{3,}\b/g);
    if (en) en.forEach((w) => words.add(w.toLowerCase()));
    return words;
  };

  const aWords = extractWords(a);
  const bWords = extractWords(b);
  let overlap = 0;
  for (const w of aWords) {
    if (bWords.has(w)) overlap++;
  }
  return overlap / Math.max(aWords.size, bWords.size, 1);
}

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
   * 算法发现笔记间的连接（两两比较 keyTopics + category）
   * 不依赖 LLM，速度快，跨全部笔记
   */
  discoverConnections(): Array<{
    source: string;
    target: string;
    reason: string;
    confidence: number;
  }> {
    const allProfiles = this.getAllProfiles();
    const connections: Array<{
      source: string;
      target: string;
      reason: string;
      confidence: number;
    }> = [];

    // 预处理：归一化每个 profile 的 topic 集合
    const profileTopicSets = allProfiles.map((p) => ({
      profile: p,
      topics: new Set(
        p.keyTopics.map((t) => normalizeTopic(t)).filter((t) => t.length >= 2)
      ),
    }));

    // 两两比较
    for (let i = 0; i < profileTopicSets.length; i++) {
      for (let j = i + 1; j < profileTopicSets.length; j++) {
        const a = profileTopicSets[i];
        const b = profileTopicSets[j];

        // 计算 topic 重叠
        const overlap: string[] = [];
        for (const t of a.topics) {
          if (b.topics.has(t)) overlap.push(t);
        }

        if (overlap.length === 0) continue;

        // 计算置信度
        const maxTopics = Math.max(a.topics.size, b.topics.size, 1);
        let confidence = overlap.length / maxTopics;

        // 同类别加分
        if (a.profile.category === b.profile.category) {
          confidence += 0.2;
        }

        // summary 关键词重叠加分
        const summaryOverlap = countSummaryOverlap(
          a.profile.summary,
          b.profile.summary
        );
        confidence += summaryOverlap * 0.1;

        confidence = Math.min(confidence, 1.0);

        if (confidence >= 0.3) {
          connections.push({
            source: a.profile.path,
            target: b.profile.path,
            reason: `共同主题: ${overlap.join(", ")}`,
            confidence: Math.round(confidence * 100) / 100,
          });
        }
      }
    }

    // 按置信度排序，取前 50 条
    connections.sort((a, b) => b.confidence - a.confidence);
    return connections.slice(0, 50);
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

    // 按笔记数排序，阈值降至 2 篇
    return Array.from(groups.entries())
      .filter(([_, notes]) => notes.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, notes]) => ({
        category,
        notes,
        suggestedFolder: category,
      }));
  }

  /**
   * 按主题聚类，生成 MOC 建议
   * 使用归一化后的 keyTopics 聚合（不同措辞的同一概念会合并）
   */
  getMocSuggestions(): Array<{
    topic: string;
    notes: NoteProfile[];
    reason: string;
  }> {
    const topicMap = new Map<string, NoteProfile[]>();

    for (const profile of this.profiles.values()) {
      // 用 Set 去重，避免同一篇笔记在同一 topic 下出现多次
      const addedTopics = new Set<string>();
      for (const topic of profile.keyTopics) {
        const normalized = normalizeTopic(topic);
        if (normalized.length < 2) continue;
        if (addedTopics.has(normalized)) continue;
        addedTopics.add(normalized);

        if (!topicMap.has(normalized)) {
          topicMap.set(normalized, []);
        }
        topicMap.get(normalized)!.push(profile);
      }
    }

    // 只保留有 3 篇以上笔记的主题（降低阈值）
    return Array.from(topicMap.entries())
      .filter(([_, notes]) => notes.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20)
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
