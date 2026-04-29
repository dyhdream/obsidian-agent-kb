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

interface Suggestion {
  id: string;
  type: "link" | "tag" | "moc" | "structure" | "orphan";
  title: string;
  description: string;
  action?: () => void;
}

class SuggestionModal extends Modal {
  private suggestions: Suggestion[];
  private plugin: AgentKBPlugin;

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
      });

      const rejectBtn = actions.createSpan({ cls: "agent-kb-btn-reject" });
      rejectBtn.setText("✗");
      rejectBtn.addEventListener("click", async () => {
        await this.plugin.sendFeedback(s.type, s.title, false);
        section.hide();
      });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export default class AgentKBPlugin extends Plugin {
  settings: AgentKBSettings;

  async onload() {
    await this.loadSettings();

    this.app.vault.on("modify", this.onFileSave.bind(this));

    this.addSettingTab(new AgentKBSettingTab(this.app, this));
  }

  async onFileSave(file: TFile) {
    if (!this.settings.autoAnalyzeOnSave) return;
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;

    try {
      const content = await this.app.vault.read(file);
      const tags = this.extractTags(content);

      const resp = await fetch(`${this.settings.agentUrl}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_path: file.path,
          content: content,
          tags: tags,
        }),
      });

      if (!resp.ok) return;

      const data = await resp.json();
      const suggestions = this.parseSuggestions(data);

      if (suggestions.length > 0) {
        new Notice(`Agent KB: 发现 ${suggestions.length} 条建议`, 5000);
        new SuggestionModal(this.app, this, suggestions).open();
      }
    } catch (e) {
      // Silent failure - don't disrupt user
    }
  }

  private parseSuggestions(data: any): Suggestion[] {
    const suggestions: Suggestion[] = [];

    const linkData = data.suggestions?.link || {};

    for (const link of linkData.links || []) {
      const confidence = link.confidence || 0;
      if (confidence < this.settings.minConfidence) continue;

      suggestions.push({
        id: `link-${link.target}`,
        type: "link",
        title: `链接到 [[${link.target}]]`,
        description: `锚点: "${link.anchor_text}" — ${link.reason}`,
        action: () => {
          const editor = this.app.workspace.activeEditor?.editor;
          if (editor) {
            const cursor = editor.getCursor();
            editor.replaceRange(`[[${link.target}|${link.anchor_text}]]`, cursor);
          }
        },
      });
    }

    for (const orphan of linkData.orphans || []) {
      suggestions.push({
        id: `orphan-${orphan.note_id}`,
        type: "orphan",
        title: `孤岛笔记提醒: ${orphan.note_id}`,
        description: `${orphan.reason} — 建议链接到: ${orphan.suggested_link}`,
      });
    }

    const structData = data.suggestions?.structure || {};

    if (structData.split_suggestion?.needs_split) {
      suggestions.push({
        id: "split",
        type: "structure",
        title: "建议拆分笔记",
        description: `${structData.split_suggestion.reason} — 主题: ${(structData.split_suggestion.suggested_topics || []).join(", ")}`,
      });
    }

    if (structData.merge_suggestion?.needs_merge) {
      suggestions.push({
        id: "merge",
        type: "structure",
        title: "建议合并笔记",
        description: `${structData.merge_suggestion.reason} — 候选: ${(structData.merge_suggestion.candidates || []).join(", ")}`,
      });
    }

    for (const tagSugg of structData.tag_suggestions || []) {
      suggestions.push({
        id: `tag-${tagSugg.current}`,
        type: "tag",
        title: `标签归一化: #${tagSugg.current} → #${tagSugg.suggested}`,
        description: tagSugg.reason,
        action: () => {
          const editor = this.app.workspace.activeEditor?.editor;
          if (editor) {
            const doc = editor.getValue();
            const updated = doc.replace(
              new RegExp(`#${tagSugg.current}\\b`, "g"),
              `#${tagSugg.suggested}`
            );
            editor.setValue(updated);
          }
        },
      });
    }

    if (structData.moc_suggestion?.needs_moc) {
      suggestions.push({
        id: "moc",
        type: "moc",
        title: `建议创建 MOC: ${structData.moc_suggestion.topic}`,
        description: structData.moc_suggestion.reason,
      });
    }

    return suggestions;
  }

  private extractTags(content: string): string[] {
    const regex = /#([a-zA-Z\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5_-]*)/g;
    const matches = content.match(regex);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
  }

  async sendFeedback(actionType: string, suggestion: string, accepted: boolean) {
    try {
      await fetch(`${this.settings.agentUrl}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action_type: actionType,
          suggestion: suggestion,
          accepted: accepted,
        }),
      });
    } catch (e) {
      // Silent
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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

    new Setting(containerEl)
      .setName("Agent 服务地址")
      .setDesc("本地 Agent 服务的 HTTP 地址")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.agentUrl)
          .onChange(async (value) => {
            this.plugin.settings.agentUrl = value;
            await this.plugin.saveSettings();
          })
      );

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
  }
}
