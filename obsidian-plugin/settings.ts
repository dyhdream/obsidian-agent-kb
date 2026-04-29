export interface AgentKBSettings {
  agentUrl: string;
  autoAnalyzeOnSave: boolean;
  minConfidence: number;
}

export const DEFAULT_SETTINGS: AgentKBSettings = {
  agentUrl: "http://127.0.0.1:9527",
  autoAnalyzeOnSave: true,
  minConfidence: 0.3,
};
