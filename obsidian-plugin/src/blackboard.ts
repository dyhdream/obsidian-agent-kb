/**
 * Blackboard — 所有 Agent 共享的读写黑板。
 * Agent 透过黑板看到彼此的输出，形成真正的协作而非独立管道。
 */

export interface NoteContext {
  noteId: string;
  filePath: string;
  title: string;
  content: string;
  tags: string[];
}

export interface VaultInfo {
  totalNotes: number;
  allTitles: TitleEntry[];
  existingTags: string[];
}

export interface TitleEntry {
  title: string;
  path: string;
  dir: string;
  tags: string[];
}

export interface SimilarNote {
  title: string;
  path: string;
  distance: number;
  tags: string[];
}

export interface Findings {
  // 情报员产出
  contextSummary?: string;
  keyEntities?: string[];
  dataQuality?: string;
  scoutNotes?: string;
  // 链接师产出
  links?: LinkSuggestion[];
  concepts?: string[];
  orphans?: OrphanNote[];
  linkNotes?: string;
  // 架构师产出
  tags?: TagSuggestion[];
  structure?: StructureAnalysis;
  structureNotes?: string;
}

export interface LinkSuggestion {
  target: string;
  anchor_text: string;
  reason: string;
  confidence: number;
}

export interface OrphanNote {
  note_title: string;
  reason: string;
}

export interface TagSuggestion {
  current: string;
  suggested: string;
  reason: string;
}

export interface StructureAnalysis {
  frontmatter?: {
    is_present?: boolean;
    missing_fields?: string[];
    issues?: string[];
  };
  split?: {
    needs_split?: boolean;
    reason?: string;
    suggested_topics?: string[];
  };
  merge?: {
    needs_merge?: boolean;
    reason?: string;
    candidates?: string[];
  };
  moc?: {
    needs_moc?: boolean;
    topic?: string;
    reason?: string;
  };
}

export interface ReviewResult {
  suggestions: FinalSuggestion[];
  summary: string;
  conflicts?: ConflictNote[];
  notes?: string;
}

export interface FinalSuggestion {
  type: string;
  priority: number;
  title: string;
  description: string;
  confidence?: number;
  source_agent?: string;
  is_conflicted?: boolean;
  conflict_note?: string;
}

export interface ConflictNote {
  suggestion_a: string;
  suggestion_b: string;
  resolution: string;
}

interface SessionInfo {
  userPreferences: Record<string, unknown>;
  rejectedThisSession: string[];
  hookPoints: Record<string, unknown>;
}

interface BlackboardData {
  current: Partial<NoteContext>;
  vault: VaultInfo;
  similar: SimilarNote[];
  related: RelatedNoteProfile[];   // 语义库返回的相近笔记
  context: {
    sameDir: TitleEntry[];
    matched: TitleEntry[];
  };
  findings: Findings;
  review: ReviewResult;
  session: SessionInfo;
}

export interface RelatedNoteProfile {
  path: string;
  title: string;
  summary: string;
  keyTopics: string[];
  score: number;
  reason: string;
}

export class Blackboard {
  private data: BlackboardData = {
    current: {},
    vault: { totalNotes: 0, allTitles: [], existingTags: [] },
    similar: [],
    related: [],
    context: { sameDir: [], matched: [] },
    findings: {},
    review: { suggestions: [], summary: "" },
    session: {
      userPreferences: {},
      rejectedThisSession: [],
      hookPoints: {},
    },
  };

  read<K extends keyof BlackboardData>(section: K): BlackboardData[K] {
    return this.data[section];
  }

  write<K extends keyof BlackboardData>(section: K, value: BlackboardData[K]): void {
    this.data[section] = value;
  }

  updateFindings(partial: Partial<Findings>): void {
    Object.assign(this.data.findings, partial);
  }

  has<K extends keyof BlackboardData>(section: K): boolean {
    const val = this.data[section];
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === "object") return Object.keys(val).length > 0;
    return Boolean(val);
  }

  clearSession(): void {
    this.data.session = {
      userPreferences: {},
      rejectedThisSession: [],
      hookPoints: {},
    };
  }
}
