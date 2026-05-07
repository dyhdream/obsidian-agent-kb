import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { AgentKBSettings, DEFAULT_SETTINGS } from "./settings";
import { initClient, getClient } from "./src/deepseek_client";
import { Orchestrator, AnalysisCallbacks } from "./src/orchestrator";
import { PreferenceLearner } from "./src/preference_learner";
import { FinalSuggestion } from "./src/blackboard";
import { parseJson } from "./src/utils";
import { SemanticLibrary, LibraryData, NoteProfile } from "./src/semantic_library";

interface Suggestion {
  id: string;
  type: "link" | "tag" | "moc" | "structure" | "orphan" | "concept";
  title: string;
  description: string;
  action?: () => void;
}

class SuggestionModal extends Modal {
  private suggestions: Suggestion[];
  private plugin: AgentKBPlugin;
  private itemSections: HTMLElement[] = [];

  constructor(app: App, plugin: AgentKBPlugin, suggestions: Suggestion[]) {
    super(app);
    this.plugin = plugin;
    this.suggestions = suggestions;
  }

  onOpen() {
    this.plugin.setModalOpen(true);
    const { contentEl } = this;
    contentEl.addClass("agent-kb-modal");

    contentEl.createEl("h3", { text: "Agent KB 分析建议" });
    contentEl.createEl("p", {
      text: `共 ${this.suggestions.length} 条建议`,
      cls: "agent-kb-summary",
    });

    for (const s of this.suggestions) {
      const section = contentEl.createDiv({ cls: "agent-kb-item" });
      this.itemSections.push(section);

      const itemContent = section.createDiv({ cls: "agent-kb-item-content" });

      const titleEl = itemContent.createDiv({});
      const badge = titleEl.createSpan({ cls: `agent-kb-badge agent-kb-badge-${s.type}` });
      badge.setText(s.type);
      titleEl.createSpan({ text: s.title });

      itemContent.createDiv({
        text: s.description,
        cls: "agent-kb-item-reason",
      });

      const actions = section.createDiv({ cls: "agent-kb-item-actions" });

      const acceptBtn = actions.createSpan({ cls: "agent-kb-btn-accept" });
      acceptBtn.setText("✓");
      acceptBtn.addEventListener("click", async () => {
        if (s.action) await s.action();
        await this.plugin.sendFeedback(s.type, s.title, true);
        section.hide();
        this.checkAllProcessed();
      });

      const rejectBtn = actions.createSpan({ cls: "agent-kb-btn-reject" });
      rejectBtn.setText("✗");
      rejectBtn.addEventListener("click", async () => {
        await this.plugin.sendFeedback(s.type, s.title, false);
        section.hide();
        this.checkAllProcessed();
      });
    }
  }

  private checkAllProcessed() {
    const allHidden = this.itemSections.every(
      (el) => el.style.display === "none" || el.isHidden()
    );
    if (allHidden) {
      this.close();
    }
  }

  onClose() {
    this.plugin.setModalOpen(false);
    this.contentEl.empty();
  }
}

export default class AgentKBPlugin extends Plugin {
  settings: AgentKBSettings;
  private orchestrator: Orchestrator | null = null;
  private preferenceLearner: PreferenceLearner | null = null;
  private semanticLibrary: SemanticLibrary | null = null;
  private debounceTimer: number | null = null;
  private isAnalyzing = false;
  private modalOpen = false;
  private lastAnalyzed: Map<string, { hash: string; time: number }> = new Map();

  /** 供 SuggestionModal 调用，标记弹窗状态 */
  setModalOpen(open: boolean): void {
    this.modalOpen = open;
  }

  async onload() {
    await this.loadSettings();
    initClient(this.settings);

    const savedPrefs = (await this.loadData())?.preferences || {};
    this.preferenceLearner = new PreferenceLearner(
      (data) => {
        this.saveData({ ...this.data, preferences: data });
      },
      savedPrefs
    );

    // 初始化语义库
    const savedLibrary = (await this.loadData())?.semanticLibrary;
    this.semanticLibrary = new SemanticLibrary(
      (data) => {
        this.saveData({ ...this.data, semanticLibrary: data });
      },
      savedLibrary
    );

    // 初始化编排器（注入语义库）
    this.orchestrator = new Orchestrator(
      this.settings,
      this.preferenceLearner,
      this.semanticLibrary
    );

    // 注册事件和命令
    this.app.vault.on("modify", this.onFileSave.bind(this));
    this.addSettingTab(new AgentKBSettingTab(this.app, this));

    this.addCommand({
      id: "rebuild-semantic-library",
      name: "重建语义库",
      callback: () => this.rebuildSemanticLibrary(),
    });

    this.addCommand({
      id: "batch-analyze",
      name: "一键分析全部笔记",
      callback: () => this.batchAnalyze(),
    });
  }

  async onFileSave(file: TFile) {
    if (!this.settings.autoAnalyzeOnSave) return;
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;
    if (this.isAnalyzing) return;
    // 弹窗打开期间禁止新分析（防止连锁触发）
    if (this.modalOpen) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(
      () => this.doAnalyze(file),
      this.settings.debounceMs
    );
  }

  private async doAnalyze(file: TFile) {
    if (!this.orchestrator) return;

    try {
      this.isAnalyzing = true;
      const content = await this.app.vault.read(file);
      const tags = this.extractTags(content);
      const contentHash = await this.calculateHash(content);

      const last = this.lastAnalyzed.get(file.path);
      if (last && last.hash === contentHash && Date.now() - last.time < 30000) {
        return;
      }

      this.lastAnalyzed.set(file.path, { hash: contentHash, time: Date.now() });

      const notice = new Notice("Agent KB 分析中...", 0);
      let modal: SuggestionModal | null = null;

      const callbacks: AnalysisCallbacks = {
        onPhase: (_phase, label) => {
          notice.setMessage(`Agent KB: ${label}`);
        },
        onReviewerComplete: (refined) => {
          if (modal && refined.length > 0) {
            const updated = this.convertSuggestions(refined);
            if (updated.length > 0) {
              modal.close();
              modal = new SuggestionModal(this.app, this, updated);
              modal.open();
            }
          }
        },
      };

      const phase2Suggestions = await this.orchestrator.analyze(
        this.app,
        file,
        content,
        tags,
        callbacks
      );

      notice.hide();

      const suggestions = this.convertSuggestions(phase2Suggestions);

      if (suggestions.length > 0) {
        new Notice(`Agent KB: 发现 ${suggestions.length} 条建议`, 5000);
        modal = new SuggestionModal(this.app, this, suggestions);
        modal.open();
      }
    } catch (e) {
      console.error("Agent KB 分析失败:", e);
    } finally {
      this.isAnalyzing = false;
    }
  }

  private convertSuggestions(items: FinalSuggestion[]): Suggestion[] {
    return items
      .filter((s) => (s.confidence || 1) >= this.settings.minConfidence)
      .map((s) => ({
        id: `${s.type}-${s.title}`,
        type: s.type as Suggestion["type"],
        title: s.title,
        description: s.description,
        action: this.getSuggestionAction(s),
      }));
  }

  // ──────────────────────────────────────────
  // 建议动作：链接插入 / 创建笔记
  // ──────────────────────────────────────────

  private getSuggestionAction(s: FinalSuggestion): (() => Promise<void>) | undefined {
    if (s.type === "link") {
      const match = s.title.match(/\[\[(.*?)\]\]/);
      if (!match) return undefined;
      const target = match[1];

      const anchorMatch = s.description.match(/锚点:\s*"([^"]+)"/);
      const anchorText = anchorMatch ? anchorMatch[1] : "";

      return async () => {
        const editor = this.app.workspace.activeEditor?.editor;
        if (!editor) return;

        // 优先：在正文中查找锚点文本并替换为链接
        if (anchorText) {
          const content = editor.getValue();
          const idx = content.indexOf(anchorText);
          if (idx !== -1) {
            const from = editor.offsetToPos(idx);
            const to = editor.offsetToPos(idx + anchorText.length);
            const linkText =
              anchorText === target
                ? `[[${target}]]`
                : `[[${target}|${anchorText}]]`;
            editor.replaceRange(linkText, from, to);
            return;
          }
        }

        // 兜底：锚点未找到，在当前段落末尾追加（不影响阅读）
        this.appendLinkAtParagraphEnd(editor, target);
      };
    }

    if (s.type === "concept") {
      const conceptName = s.title.replace(/^可新建:\s*/, "").trim();
      if (!conceptName) return undefined;
      return async () => this.createNoteAndOpen(conceptName, "concept");
    }

    if (s.type === "moc") {
      const topic = s.title.replace(/^建议创建\s*MOC:\s*/, "").trim();
      if (!topic) return undefined;
      return async () => this.createNoteAndOpen(`${topic} MOC`, "moc", topic);
    }

    return undefined;
  }

  /**
   * 在当前段落末尾追加链接（不打断用户阅读）
   * 找到光标所在行的内容末尾，追加 ` [[target]]`
   */
  private appendLinkAtParagraphEnd(editor: any, target: string): void {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);

    // 找到当前段落的最后一行（连续非空行的末尾）
    let endLine = cursor.line;
    for (let i = cursor.line + 1; i < editor.lineCount(); i++) {
      if (editor.getLine(i).trim() === "") break;
      endLine = i;
    }

    const endContent = editor.getLine(endLine);
    const insertPos = { line: endLine, ch: endContent.length };
    editor.replaceRange(` [[${target}]]`, insertPos);
  }

  // ──────────────────────────────────────────
  // 创建新笔记（支持 AI 生成内容）
  // ──────────────────────────────────────────

  private async createNoteAndOpen(
    title: string,
    type: "concept" | "moc",
    topic?: string
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    let content: string;

    if (type === "moc" && topic) {
      // MOC 笔记：固定模板
      content = [
        "---",
        `created: ${today}`,
        "tags: [moc]",
        "---",
        "",
        `## ${title}`,
        "",
        `> [!note] MOC（Map of Content）`,
        `> ${topic} 相关笔记的导航页。`,
        "",
        "### 相关笔记",
        "",
        "<!-- 在此添加相关笔记的 [[链接]] -->",
        "",
      ].join("\n");
    } else if (this.settings.autoGenerateConceptContent) {
      // concept 笔记：AI 生成内容
      content = await this.generateConceptContent(title, today);
    } else {
      // concept 笔记：空白模板
      content = [
        "---",
        `created: ${today}`,
        `tags: [${title.toLowerCase().replace(/\s+/g, "-")}]`,
        "---",
        "",
        `## ${title}`,
        "",
        "<!-- 在此开始写作 -->",
        "",
      ].join("\n");
    }

    const fileName = `${title}.md`;

    const existing = this.app.vault.getAbstractFileByPath(fileName);
    if (existing) {
      new Notice(`笔记 "${fileName}" 已存在`);
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(existing as TFile);
      return;
    }

    const file = await this.app.vault.create(fileName, content);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    new Notice(`已创建笔记: ${title}`);
  }

  /**
   * 调用 DeepSeek 生成新概念笔记内容（严格 Obsidian 格式）
   */
  private async generateConceptContent(
    conceptName: string,
    date: string
  ): Promise<string> {
    try {
      const raw = await getClient().chat(
        [
          {
            role: "system",
            content: `你是一个 Obsidian 知识库写作专家。根据给定的概念名，生成一篇简洁的笔记。

## 强制格式规范
1. YAML frontmatter 放在文件最顶部（--- 包裹）
2. frontmatter 必须包含 created 和 tags 字段
3. 内容从 ## 开始（文件名即一级标题）
4. 内部链接使用 [[笔记标题]] 格式
5. 不要使用外部链接 [text](url)
6. 要点使用列表，关键概念加粗
7. 内容简洁，150-300 字即可
8. 不要输出 JSON 以外的任何说明文字`,
          },
          {
            role: "user",
            content: `为概念 "${conceptName}" 生成一篇 Obsidian 笔记。日期: ${date}

严格按以下 JSON 输出：
{
  "content": "完整的 Obsidian 格式笔记内容（含 YAML frontmatter）"
}`,
          },
        ],
        { temperature: 0.4, maxTokens: 800 }
      );

      const parsed = parseJson(raw);
      if (parsed.content && typeof parsed.content === "string") {
        return parsed.content;
      }
    } catch (e) {
      console.error("AI 生成笔记内容失败:", e);
    }

    // 兜底：AI 失败时返回基本模板
    return [
      "---",
      `created: ${date}`,
      `tags: [${conceptName.toLowerCase().replace(/\s+/g, "-")}]`,
      "---",
      "",
      `## ${conceptName}`,
      "",
      "<!-- AI 生成失败，在此开始写作 -->",
      "",
    ].join("\n");
  }

  // ──────────────────────────────────────────
  // 工具方法
  // ──────────────────────────────────────────

  private extractTags(content: string): string[] {
    const regex = /#([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5_-]*)/g;
    const matches = content.match(regex);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
  }

  private async calculateHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ──────────────────────────────────────────
  // 语义库：重建 / 一键分析
  // ──────────────────────────────────────────

  /**
   * 命令：重建语义库
   * 全量处理所有笔记，生成 NoteProfile，发现连接，聚类
   */
  private async rebuildSemanticLibrary(): Promise<void> {
    if (!this.semanticLibrary) return;

    const notice = new Notice("Agent KB: 正在构建语义库...", 0);

    try {
      const result = await this.semanticLibrary.buildAll(
        this.app,
        (current, total, title) => {
          notice.setMessage(`Agent KB: 分析中 (${current}/${total}) ${title}`);
        }
      );

      notice.hide();
      new Notice(
        `Agent KB: 语义库已重建（${result.updated} 篇更新，${result.skipped} 篇跳过）`,
        5000
      );
    } catch (e) {
      notice.hide();
      new Notice("Agent KB: 语义库重建失败，请检查 API Key", 5000);
      console.error("语义库重建失败:", e);
    }
  }

  /**
   * 命令：一键分析全部笔记
   * 静默运行：发现连接 + 目录分类 + MOC 建议 → 通知 → 报告弹窗
   */
  private async batchAnalyze(): Promise<void> {
    if (!this.semanticLibrary) return;

    const notice = new Notice("Agent KB: 一键分析中...", 0);

    try {
      // Phase 1: 确保语义库是最新的
      notice.setMessage("Agent KB: 更新语义库...");
      await this.semanticLibrary.buildAll(this.app, (cur, total) => {
        notice.setMessage(`Agent KB: 更新语义库 (${cur}/${total})`);
      });

      // Phase 2: 发现连接（算法，瞬间完成）
      notice.setMessage("Agent KB: 发现笔记连接...");
      const connections = this.semanticLibrary.discoverConnections();

      // Phase 3: 聚类建议
      const folderSuggestions = this.semanticLibrary.getFolderSuggestions();
      const mocSuggestions = this.semanticLibrary.getMocSuggestions();

      notice.hide();

      // 构建报告
      const totalSuggestions =
        connections.length + folderSuggestions.length + mocSuggestions.length;

      if (totalSuggestions === 0) {
        new Notice("Agent KB: 分析完成，暂无优化建议", 3000);
        return;
      }

      new Notice(
        `Agent KB: 发现 ${connections.length} 条链接 + ${folderSuggestions.length} 个文件夹 + ${mocSuggestions.length} 个 MOC 建议`,
        5000
      );

      // 打开报告弹窗
      new BatchReportModal(
        this.app,
        this,
        connections,
        folderSuggestions,
        mocSuggestions
      ).open();
    } catch (e) {
      notice.hide();
      new Notice("Agent KB: 一键分析失败，请检查 API Key", 5000);
      console.error("一键分析失败:", e);
    }
  }

  async sendFeedback(actionType: string, suggestion: string, accepted: boolean) {
    this.orchestrator?.recordFeedback(actionType, suggestion, accepted);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    initClient(this.settings);
    this.orchestrator?.updateSettings(this.settings);
  }
}

// ──────────────────────────────────────────
// 批量分析报告弹窗
// ──────────────────────────────────────────

class BatchReportModal extends Modal {
  private plugin: AgentKBPlugin;
  private connections: Array<{
    source: string;
    target: string;
    reason: string;
    confidence: number;
  }>;
  private folderSuggestions: Array<{
    category: string;
    notes: NoteProfile[];
    suggestedFolder: string;
  }>;
  private mocSuggestions: Array<{
    topic: string;
    notes: NoteProfile[];
    reason: string;
  }>;

  constructor(
    app: App,
    plugin: AgentKBPlugin,
    connections: Array<{
      source: string;
      target: string;
      reason: string;
      confidence: number;
    }>,
    folderSuggestions: Array<{
      category: string;
      notes: NoteProfile[];
      suggestedFolder: string;
    }>,
    mocSuggestions: Array<{
      topic: string;
      notes: NoteProfile[];
      reason: string;
    }>
  ) {
    super(app);
    this.plugin = plugin;
    this.connections = connections;
    this.folderSuggestions = folderSuggestions;
    this.mocSuggestions = mocSuggestions;
  }

  onOpen() {
    this.plugin.setModalOpen(true);
    const { contentEl } = this;
    contentEl.addClass("agent-kb-modal");

    contentEl.createEl("h3", { text: "Agent KB 一键分析报告" });

    // ── 链接建议 ──
    if (this.connections.length > 0) {
      const section = contentEl.createDiv({ cls: "agent-kb-section" });
      section.createEl("h4", {
        text: `🔗 链接建议 (${this.connections.length} 条)`,
      });

      for (const conn of this.connections.slice(0, 30)) {
        const item = section.createDiv({ cls: "agent-kb-item" });
        const content = item.createDiv({ cls: "agent-kb-item-content" });
        const sourceName = conn.source.replace(/\.md$/, "");
        const targetName = conn.target.replace(/\.md$/, "");
        content.createDiv({
          text: `${sourceName} → ${targetName} (${(conn.confidence * 100).toFixed(0)}%)`,
        });
        content.createDiv({
          text: conn.reason,
          cls: "agent-kb-item-reason",
        });
      }
      if (this.connections.length > 30) {
        section.createEl("p", {
          text: `... 还有 ${this.connections.length - 30} 条`,
          cls: "agent-kb-item-reason",
        });
      }
    }

    // ── 文件夹分类 ──
    if (this.folderSuggestions.length > 0) {
      const section = contentEl.createDiv({ cls: "agent-kb-section" });
      section.createEl("h4", {
        text: `📁 目录分类建议 (${this.folderSuggestions.length} 个文件夹)`,
      });

      for (const folder of this.folderSuggestions) {
        const item = section.createDiv({ cls: "agent-kb-item" });
        const content = item.createDiv({ cls: "agent-kb-item-content" });
        content.createDiv({
          text: `${folder.suggestedFolder}/ (${folder.notes.length} 篇)`,
        });
        content.createDiv({
          text: folder.notes
            .slice(0, 5)
            .map((n) => n.title)
            .join(", ") + (folder.notes.length > 5 ? "..." : ""),
          cls: "agent-kb-item-reason",
        });
      }
    }

    // ── MOC 建议 ──
    if (this.mocSuggestions.length > 0) {
      const section = contentEl.createDiv({ cls: "agent-kb-section" });
      section.createEl("h4", {
        text: `🗂 MOC 建议 (${this.mocSuggestions.length} 个)`,
      });

      for (const moc of this.mocSuggestions) {
        const item = section.createDiv({ cls: "agent-kb-item" });
        const content = item.createDiv({ cls: "agent-kb-item-content" });
        content.createDiv({
          text: `${moc.topic} MOC (${moc.notes.length} 篇相关)`,
        });
        content.createDiv({
          text: moc.reason,
          cls: "agent-kb-item-reason",
        });
      }
    }
  }

  onClose() {
    this.plugin.setModalOpen(false);
    this.contentEl.empty();
  }
}

// ──────────────────────────────────────────
// 设置面板
// ──────────────────────────────────────────

class AgentKBSettingTab extends PluginSettingTab {
  plugin: AgentKBPlugin;

  constructor(app: App, plugin: AgentKBPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Agent KB 设置" });

    // ── API 配置 ──
    containerEl.createEl("h4", { text: "API 配置" });

    new Setting(containerEl)
      .setName("DeepSeek API Key")
      .setDesc("在 platform.deepseek.com 获取")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.style.width = "300px";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("API 地址")
      .setDesc("DeepSeek API 的 base URL")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.deepseekBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.deepseekBaseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("模型")
      .setDesc("使用的模型名称")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("deepseek-v4-flash", "deepseek-v4-flash (推荐，便宜)")
          .addOption("deepseek-chat", "deepseek-chat (更强，更贵)")
          .setValue(this.plugin.settings.deepseekModel)
          .onChange(async (value) => {
            this.plugin.settings.deepseekModel = value;
            await this.plugin.saveSettings();
          })
      );

    // ── 分析行为 ──
    containerEl.createEl("h4", { text: "分析行为" });

    new Setting(containerEl)
      .setName("保存时自动分析")
      .setDesc("笔记保存时自动触发分析")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoAnalyzeOnSave)
          .onChange(async (value) => {
            this.plugin.settings.autoAnalyzeOnSave = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AI 自动生成新笔记内容")
      .setDesc("接受「可新建」建议时，用 AI 自动生成笔记初稿（关闭则创建空白笔记）")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoGenerateConceptContent)
          .onChange(async (value) => {
            this.plugin.settings.autoGenerateConceptContent = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("最低置信度")
      .setDesc("低于此值的建议将被过滤")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.minConfidence)
          .onChange(async (value) => {
            this.plugin.settings.minConfidence = value;
            await this.plugin.saveSettings();
          })
          .setDynamicTooltip()
      );

    new Setting(containerEl)
      .setName("防抖间隔")
      .setDesc("保存后等待多久再触发分析（毫秒）")
      .addSlider((slider) =>
        slider
          .setLimits(500, 5000, 100)
          .setValue(this.plugin.settings.debounceMs)
          .onChange(async (value) => {
            this.plugin.settings.debounceMs = value;
            await this.plugin.saveSettings();
          })
          .setDynamicTooltip()
      );

    // ── LLM 参数 ──
    containerEl.createEl("h4", { text: "LLM 参数" });

    new Setting(containerEl)
      .setName("温度")
      .setDesc("越低越确定，越高越有创意 (0-1)")
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.agentTemperature)
          .onChange(async (value) => {
            this.plugin.settings.agentTemperature = value;
            await this.plugin.saveSettings();
          })
          .setDynamicTooltip()
      );

    new Setting(containerEl)
      .setName("最大 Token")
      .setDesc("单次 LLM 调用的最大输出 Token 数")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.agentMaxTokens))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.agentMaxTokens = num;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
