export interface AgentKBSettings {
  // DeepSeek API 配置
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekModel: string;

  // 分析行为
  autoAnalyzeOnSave: boolean;
  minConfidence: number;
  debounceMs: number;

  // LLM 参数
  agentTemperature: number;
  agentMaxTokens: number;
  agentMaxRetries: number;
}

export const DEFAULT_SETTINGS: AgentKBSettings = {
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com/v1",
  deepseekModel: "deepseek-v4-flash",

  autoAnalyzeOnSave: true,
  minConfidence: 0.3,
  debounceMs: 2000,

  agentTemperature: 0.3,
  agentMaxTokens: 2048,
  agentMaxRetries: 2,
};
