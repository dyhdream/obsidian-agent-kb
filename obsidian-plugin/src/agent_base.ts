/**
 * Agent 基类 — 统一接口
 * 每个 Agent 拥有：身份(role) + 黑板读写 + 偏好注入
 */

import { Blackboard } from "./blackboard";
import { getClient } from "./deepseek_client";
import { PreferenceLearner } from "./preference_learner";
import { sessionMemory } from "./session_memory";
import { parseJson, parseJsonList } from "./utils";
import { AgentKBSettings } from "../settings";

export abstract class Agent {
  abstract role: string;
  abstract persona: string;
  protected blackboard: Blackboard;
  protected settings: AgentKBSettings;
  private preferenceLearner: PreferenceLearner;

  constructor(
    blackboard: Blackboard,
    settings: AgentKBSettings,
    preferenceLearner: PreferenceLearner
  ) {
    this.blackboard = blackboard;
    this.settings = settings;
    this.preferenceLearner = preferenceLearner;
  }

  abstract systemPrompt(): string;
  abstract userPrompt(): string;
  abstract handleResponse(raw: string): boolean;

  /**
   * Agent 执行入口。一次 LLM 调用 → 写入黑板。
   */
  async run(): Promise<{ role: string; status: string; error?: string }> {
    const system = this.systemPrompt();
    const user = this.userPrompt();

    const maxRetries = this.settings.agentMaxRetries;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const raw = await getClient().chat(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          {
            temperature: this.settings.agentTemperature,
            maxTokens: this.settings.agentMaxTokens,
          }
        );

        const ok = this.handleResponse(raw);
        if (ok) {
          return { role: this.role, status: "ok" };
        }
      } catch (e) {
        if (attempt < maxRetries - 1) continue;
        return { role: this.role, status: "error", error: String(e) };
      }
    }

    return { role: this.role, status: "error", error: "max_retries_exceeded" };
  }

  /**
   * 注入偏好信息到 system prompt
   */
  protected injectPreferences(): string {
    const rejected = sessionMemory.getRejectedInSession();
    const data = this.preferenceLearner.getData();
    const lines: string[] = ["\n## 用户偏好（动态注入）\n"];

    if (rejected.length > 0) {
      const rejectedStr = rejected.slice(0, 10).join("、");
      lines.push(`- 本次会话中已被拒绝的建议: ${rejectedStr}`);
      lines.push("- 如果涉及上述内容，请降低置信度或直接跳过");
    }

    const rates: Record<string, number | null> = {
      link: this.preferenceLearner.getAcceptRate("link"),
      tag: this.preferenceLearner.getAcceptRate("tag"),
      structure: this.preferenceLearner.getAcceptRate("structure"),
    };

    for (const [key, rate] of Object.entries(rates)) {
      if (rate !== null) {
        const label = { link: "链接", tag: "标签", structure: "结构" }[key] || key;
        lines.push(`- ${label}建议的历史采纳率: ${(rate * 100).toFixed(0)}%`);
      }
    }

    return lines.join("\n");
  }

  protected static parseJson(raw: string): Record<string, unknown> {
    return parseJson(raw);
  }

  protected static parseJsonList(raw: string): unknown[] {
    return parseJsonList(raw);
  }
}
