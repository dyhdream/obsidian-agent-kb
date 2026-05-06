/**
 * Vault 上下文收集器
 * 替代 Python 版的 vault_index.py + vector_store.py
 * 使用 Obsidian 内置 API (MetadataCache) 收集笔记上下文
 */

import {
  App,
  TFile,
  CachedMetadata,
} from "obsidian";
import { TitleEntry, SimilarNote, Findings } from "./blackboard";

export interface VaultContextResult {
  sameDir: TitleEntry[];
  matched: TitleEntry[];
  similar: SimilarNote[];
  allTitles: TitleEntry[];
  totalNotes: number;
  existingTags: string[];
}

/**
 * 从 frontmatter 和正文提取标签
 */
function extractTagsFromFile(app: App, file: TFile, cache: CachedMetadata | null): string[] {
  const tags: Set<string> = new Set();

  // frontmatter tags
  if (cache?.frontmatter?.tags) {
    const fmTags = cache.frontmatter.tags;
    if (Array.isArray(fmTags)) {
      fmTags.forEach((t: string) => tags.add(String(t).toLowerCase()));
    } else if (typeof fmTags === "string") {
      tags.add(fmTags.toLowerCase());
    }
  }

  // 内联 #tags
  if (cache?.tags) {
    cache.tags.forEach((t) => tags.add(t.tag.replace(/^#/, "").toLowerCase()));
  }

  // 从文件名推断标签
  const nameTag = file.basename.toLowerCase();
  if (nameTag) tags.add(nameTag);

  return Array.from(tags);
}

/**
 * 从 frontmatter 提取 aliases
 */
function extractAliases(cache: CachedMetadata | null): string[] {
  if (!cache?.frontmatter?.aliases) return [];
  const aliases = cache.frontmatter.aliases;
  if (Array.isArray(aliases)) return aliases.map(String);
  if (typeof aliases === "string") return [aliases];
  return [];
}

/**
 * 计算两个笔记的相似度 (0-1)
 * 基于：标签重叠 + 标题关键词重叠 + 同目录加分
 */
function computeSimilarity(
  aTags: string[],
  bTags: string[],
  aTitle: string,
  bTitle: string,
  sameDir: boolean
): number {
  let score = 0;

  // 标签重叠
  const aSet = new Set(aTags);
  const bSet = new Set(bTags);
  let overlap = 0;
  for (const t of aSet) {
    if (bSet.has(t)) overlap++;
  }
  const maxTags = Math.max(aSet.size, bSet.size, 1);
  score += (overlap / maxTags) * 0.5;

  // 标题关键词重叠
  const aWords = new Set(aTitle.toLowerCase().split(/[\s\-_]+/).filter((w) => w.length > 1));
  const bWords = new Set(bTitle.toLowerCase().split(/[\s\-_]+/).filter((w) => w.length > 1));
  let wordOverlap = 0;
  for (const w of aWords) {
    if (bWords.has(w)) wordOverlap++;
  }
  const maxWords = Math.max(aWords.size, bWords.size, 1);
  score += (wordOverlap / maxWords) * 0.3;

  // 同目录加分
  if (sameDir) score += 0.2;

  return Math.min(score, 1.0);
}

/**
 * 收集当前笔记的 Vault 上下文
 */
export function collectVaultContext(
  app: App,
  currentFile: TFile,
  currentContent: string,
  currentTags: string[]
): VaultContextResult {
  const allFiles = app.vault.getMarkdownFiles();

  const currentDir = currentFile.parent?.path || "";
  const currentTitle = currentFile.basename;
  const allTags: Set<string> = new Set();
  const allTitles: TitleEntry[] = [];
  const sameDir: TitleEntry[] = [];
  const similarItems: SimilarNote[] = [];

  // 提取当前笔记的已有链接
  const existingLinks = new Set<string>();
  const linkRegex = /\[\[([^\]|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(currentContent)) !== null) {
    existingLinks.add(match[1].toLowerCase());
  }

  for (const file of allFiles) {
    // 跳过当前文件
    if (file.path === currentFile.path) continue;

    const cache = app.metadataCache.getFileCache(file);
    const fileTags = extractTagsFromFile(app, file, cache);
    const aliases = extractAliases(cache);
    const title = file.basename;
    const dir = file.parent?.path || "";

    fileTags.forEach((t) => allTags.add(t));

    const entry: TitleEntry = {
      title,
      path: file.path,
      dir,
      tags: fileTags,
    };
    allTitles.push(entry);

    // 同目录
    if (dir === currentDir) {
      sameDir.push(entry);
    }

    // 计算相似度
    const sim = computeSimilarity(currentTags, fileTags, currentTitle, title, dir === currentDir);
    if (sim > 0.05 && !existingLinks.has(title.toLowerCase())) {
      similarItems.push({
        title,
        path: file.path,
        distance: 1.0 - sim,
        tags: fileTags,
      });
    }
  }

  // 排序：相似度高的在前
  similarItems.sort((a, b) => a.distance - b.distance);

  // 标题关键词匹配
  const titleWords = currentTitle.split(/[\s\-_]+/).filter((w) => w.length > 1);
  const matched: TitleEntry[] = [];
  for (const entry of allTitles) {
    const entryTitleLower = entry.title.toLowerCase();
    const isMatch = titleWords.some((w) => entryTitleLower.includes(w.toLowerCase()));
    if (isMatch && !sameDir.some((s) => s.path === entry.path)) {
      matched.push(entry);
    }
  }

  return {
    sameDir,
    matched: matched.slice(0, 10),
    similar: similarItems.slice(0, 10),
    allTitles: allTitles.sort((a, b) => a.title.localeCompare(b.title)),
    totalNotes: allFiles.length,
    existingTags: Array.from(allTags).slice(0, 100),
  };
}
