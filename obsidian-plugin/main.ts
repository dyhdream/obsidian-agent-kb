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
import { initClient } from "./src/deepseek_client";
import { Orchestrator, AnalysisCallbacks } from "./src/orchestrator";
import { PreferenceLearner } from "./src/preference_learner";
import { FinalSuggestion } from "./src/blackboard";

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
        s.action?.();
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
    const allHidden = this.itemSections.every((el) => el.style.display === "none" || el.isHidden());
    if (allHidden) {
      this.close();
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export default class AgentKBPlugin extends Plugin {
  settings: AgentKBSettings;
  private orchestrator: Orchestrator | null = null;
  private preferenceLearner: PreferenceLearner | null = null;
  private debounceTimer: number | null = null;
  private isAnalyzing = false;
  private analysisCooldownUntil = 0;
  private lastAnalyzed: Map<string, { hash: string; time: number }> = new Map();

  async onload() {
    await this.loadSettings();

    // 初始化 DeepSeek 客户端
    initClient(this.settings);

    // 初始化偏好学习器（持久化到 Obsidian data）
    const savedPrefs = (await this.loadData())?.preferences || {};
    this.preferenceLearner = new PreferenceLearner(
      (data) => {
        this.saveData({ ...this.data, preferences: data });
      },
      savedPrefs
    );

    // 初始化编排器
    this.orchestrator = new Orchestrator(this.settings, this.preferenceLearner);

    // 注册保存事件
    this.app.vault.on("modify", this.onFileSave.bind(this));

    // 注册设置面板
    this.addSettingTab(new AgentKBSettingTab(this.app, this));
  }

  async onFileSave(file: TFile) {
    if (!this.settings.autoAnalyzeOnSave) return;
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;
    if (this.isAnalyzing) return;

    // 冷却期内跳过（防止插件自身修改文件触发重复分析）
    if (Date.now() < this.analysisCooldownUntil) return;

    // 清除之前的防抖定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // 设置新的防抖定时器
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

      // 检查是否已分析过（30 秒内同内容跳过）
      const last = this.lastAnalyzed.get(file.path);
      if (last && last.hash === contentHash && Date.now() - last.time < 30000) {
        return;
      }

      this.lastAnalyzed.set(file.path, { hash: contentHash, time: Date.now() });

      // 显示进度提示
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
      // 冷却期：分析完成后 10 秒内不触发新分析
      this.analysisCooldownUntil = Date.now() + 10000;
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

  private getSuggestionAction(s: FinalSuggestion): (() => void) | undefined {
    if (s.type === "link") {
      const match = s.title.match(/\[\[(.*?)\]\]/);
      if (!match) return undefined;
      const target = match[1];
      return () => {
        const editor = this.app.workspace.activeEditor?.editor;
        if (editor) {
          const cursor = editor.getCursor();
          editor.replaceRange(`[[${target}]]`, cursor);
        }
      };
    }

    if (s.type === "concept") {
      // 从 "可新建: XXX" 中提取概念名
      const conceptName = s.title.replace(/^可新建:\s*/, "").trim();
      if (!conceptName) return undefined;
      return () => this.createNoteAndOpen(conceptName, "concept");
    }

    if (s.type === "moc") {
      // 从 "建议创建 MOC: XXX" 中提取主题名
      const topic = s.title.replace(/^建议创建\s*MOC:\s*/, "").trim();
      if (!topic) return undefined;
      return () => this.createNoteAndOpen(`${topic} MOC`, "moc", topic);
    }

    return undefined;
  }

  /**
   * 创建新笔记并打开
   */
  private async createNoteAndOpen(title: string, type: "concept" | "moc", topic?: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const tags = type === "moc" ? ["moc"] : [];

    let content = "---\n";
    content += `created: ${today}\n`;
    if (tags.length > 0) {
      content += `tags: [${tags.join(", ")}]\n`;
    }
    content += "---\n\n";

    if (type === "moc" && topic) {
      content += `## ${title}\n\n`;
      content += `> [!note] MOC（Map of Content）\n> ${topic} 相关笔记的导航页。\n\n`;
      content += `### 相关笔记\n\n`;
      content += `<!-- 在此添加相关笔记的链接 -->\n`;
    } else {
      content += `## ${title}\n\n`;
      content += `<!-- 在此开始写作 -->\n`;
    }

    const fileName = `${title}.md`;

    // 检查是否已存在
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
