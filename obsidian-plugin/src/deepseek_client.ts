/**
 * DeepSeek API 客户端
 * 使用 Obsidian 的 requestUrl 进行 HTTP 调用
 */

import { requestUrl, RequestUrlResponse } from "obsidian";
import { AgentKBSettings } from "../settings";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  model?: string;
}

interface UsageRecord {
  model: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  timestamp: number;
}

export class DeepSeekClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private usageLog: UsageRecord[] = [];

  constructor(settings: AgentKBSettings) {
    this.apiKey = settings.deepseekApiKey;
    this.baseUrl = settings.deepseekBaseUrl.replace(/\/$/, "");
    this.model = settings.deepseekModel;
  }

  updateSettings(settings: AgentKBSettings): void {
    this.apiKey = settings.deepseekApiKey;
    this.baseUrl = settings.deepseekBaseUrl.replace(/\/$/, "");
    this.model = settings.deepseekModel;
  }

  /**
   * 调用 Chat Completions API
   */
  async chat(
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const temperature = options?.temperature ?? 0.3;
    const maxTokens = options?.maxTokens ?? 2048;

    const resp: RequestUrlResponse = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (resp.status !== 200) {
      throw new Error(`DeepSeek API error: ${resp.status} ${resp.text}`);
    }

    const data: ChatResponse = resp.json;
    const usage = data.usage;

    if (usage?.prompt_tokens || usage?.completion_tokens) {
      this.usageLog.push({
        model: data.model || this.model,
        endpoint: "chat/completions",
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        timestamp: Date.now(),
      });
    }

    return data.choices[0].message.content;
  }

  /**
   * 获取最近的用量记录
   */
  getUsage(): UsageRecord[] {
    return [...this.usageLog];
  }

  /**
   * 获取今日用量统计
   */
  getTodayUsage(): { calls: number; promptTokens: number; completionTokens: number } {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();

    const todayRecords = this.usageLog.filter((r) => r.timestamp >= todayTs);
    return {
      calls: todayRecords.length,
      promptTokens: todayRecords.reduce((s, r) => s + r.promptTokens, 0),
      completionTokens: todayRecords.reduce((s, r) => s + r.completionTokens, 0),
    };
  }
}

// 全局单例，由 main.ts 初始化
let _client: DeepSeekClient | null = null;

export function initClient(settings: AgentKBSettings): void {
  _client = new DeepSeekClient(settings);
}

export function getClient(): DeepSeekClient {
  if (!_client) throw new Error("DeepSeekClient not initialized");
  return _client;
}
