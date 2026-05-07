/**
 * Vault 上下文收集器（语义库增强版）
 * 使用 Obsidian MetadataCache 收集基础上下文 + SemanticLibrary 语义检索
 */

import { App, TFile, CachedMetadata } from "obsidian";
import { TitleEntry, SimilarNote } from "./blackboard";
import { SemanticLibrary, RelatedNote } from "./semantic_library";

export interface VaultContextResult {
  sameDir: TitleEntry[];
  matched: TitleEntry[];
  related: RelatedNote[];       // 语义库返回的相近笔记
  allTitles: TitleEntry[];
  totalNotes: number;
  existingTags: string[];
  keyEntities: string[];        // 客户端提取的核心实体
}

// ── 工具函数 ──

function extractTagsFromFile(
  app: App,
  file: TFile,
  cache: CachedMetadata | null
): string[] {
  const tags: Set<string> = new Set();

  if (cache?.frontmatter?.tags) {
    const fmTags = cache.frontmatter.tags;
    if (Array.isArray(fmTags)) {
      fmTags.forEach((t: string) => tags.add(String(t).toLowerCase()));
    } else if (typeof fmTags === "string") {
      tags.add(fmTags.toLowerCase());
    }
  }

  if (cache?.tags) {
    cache.tags.forEach((t) => tags.add(t.tag.replace(/^#/, "").toLowerCase()));
  }

  const nameTag = file.basename.toLowerCase();
  if (nameTag) tags.add(nameTag);

  return Array.from(tags);
}

// ── 主函数 ──

/**
 * 收集当前笔记的 Vault 上下文（语义库增强版）
 */
export function collectVaultContext(
  app: App,
  currentFile: TFile,
  currentContent: string,
  currentTags: string[],
  semanticLibrary?: SemanticLibrary
): VaultContextResult {
  const allFiles = app.vault.getMarkdownFiles();
  const currentDir = currentFile.parent?.path || "";
  const allTags: Set<string> = new Set();
  const allTitles: TitleEntry[] = [];
  const sameDir: TitleEntry[] = [];

  // 提取已有链接（用于排除）
  const existingLinks = new Set<string>();
  const linkRegex = /\[\[([^\]|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(currentContent)) !== null) {
    existingLinks.add(match[1].toLowerCase());
  }

  for (const file of allFiles) {
    if (file.path === currentFile.path) continue;

    const cache = app.metadataCache.getFileCache(file);
    const fileTags = extractTagsFromFile(app, file, cache);
    const title = file.basename;
    const dir = file.parent?.path || "";

    fileTags.forEach((t) => allTags.add(t));

    const entry: TitleEntry = { title, path: file.path, dir, tags: fileTags };
    allTitles.push(entry);

    if (dir === currentDir) {
      sameDir.push(entry);
    }
  }

  // 标题关键词匹配
  const titleWords = currentFile.basename
    .split(/[\s\-_]+/)
    .filter((w) => w.length > 1);
  const matched: TitleEntry[] = [];
  for (const entry of allTitles) {
    const entryTitleLower = entry.title.toLowerCase();
    const isMatch = titleWords.some((w) =>
      entryTitleLower.includes(w.toLowerCase())
    );
    if (isMatch && !sameDir.some((s) => s.path === entry.path)) {
      matched.push(entry);
    }
  }

  // 语义库：查找相近笔记
  let related: RelatedNote[] = [];
  if (semanticLibrary) {
    const currentProfile = semanticLibrary.getProfile(currentFile.path);
    if (currentProfile) {
      related = semanticLibrary.findRelated(
        currentProfile,
        currentFile.path,
        10
      );
    }
  }

  // 客户端提取核心实体
  const keyEntities = extractKeyEntities(currentContent, currentTags);

  return {
    sameDir,
    matched: matched.slice(0, 10),
    related,
    allTitles: allTitles.sort((a, b) => a.title.localeCompare(b.title)),
    totalNotes: allFiles.length,
    existingTags: Array.from(allTags).slice(0, 100),
    keyEntities,
  };
}

/**
 * 客户端提取核心实体（替代 ContextScout LLM）
 */
export function extractKeyEntities(
  content: string,
  tags: string[]
): string[] {
  const entities: Set<string> = new Set();

  // 已有链接目标
  const linkRegex = /\[\[([^\]|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(content)) !== null) {
    entities.add(match[1].trim());
  }

  // 标签
  tags.forEach((t) => entities.add(t));

  // 高频名词
  const chineseRegex = /[\u4e00-\u9fa5]{2,6}/g;
  const engRegex = /\b[A-Z][a-zA-Z]{2,}\b/g;
  const engAllCaps = /\b[A-Z]{2,}\b/g;

  const wordCount: Map<string, number> = new Map();
  const countWord = (w: string) =>
    wordCount.set(w, (wordCount.get(w) || 0) + 1);

  let m: RegExpExecArray | null;
  while ((m = chineseRegex.exec(content)) !== null) countWord(m[0]);
  while ((m = engRegex.exec(content)) !== null) countWord(m[0]);
  while ((m = engAllCaps.exec(content)) !== null) countWord(m[0]);

  for (const [word, count] of wordCount) {
    if (count >= 2 && word.length >= 2) {
      entities.add(word);
    }
  }

  return Array.from(entities).slice(0, 12);
}

/**
 * 获取优先排序的标题列表（限制 30 个）
 */
export function getPrioritizedTitles(
  result: VaultContextResult,
  excludePaths: Set<string>
): TitleEntry[] {
  const seen = new Set<string>();
  const res: TitleEntry[] = [];

  const add = (entries: TitleEntry[]) => {
    for (const e of entries) {
      if (seen.has(e.path) || excludePaths.has(e.path)) continue;
      seen.add(e.path);
      res.push(e);
      if (res.length >= 30) return;
    }
  };

  add(result.sameDir);
  add(result.matched);
  add(result.related.map((r) => ({
    title: r.profile.title,
    path: r.profile.path,
    dir: "",
    tags: r.profile.keyTopics,
  })));

  if (res.length < 30) {
    add(result.allTitles);
  }

  return res;
}
