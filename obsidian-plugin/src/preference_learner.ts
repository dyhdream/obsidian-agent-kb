/**
 * 偏好学习器
 * 记录用户的采纳/拒绝行为，计算采纳率，管理阈值。
 * 使用 Obsidian Plugin 的 loadData/saveData 持久化。
 */

export interface PreferenceData {
  accepted: Record<string, string[]>;
  rejected: Record<string, string[]>;
  thresholds: {
    link_confidence_min: number;
    split_min_chars: number;
    merge_max_chars: number;
    moc_cluster_min: number;
    orphan_link_max: number;
  };
}

const DEFAULT_DATA: PreferenceData = {
  accepted: {},
  rejected: {},
  thresholds: {
    link_confidence_min: 0.3,
    split_min_chars: 800,
    merge_max_chars: 100,
    moc_cluster_min: 10,
    orphan_link_max: 2,
  },
};

export class PreferenceLearner {
  private data: PreferenceData;
  private saveFn: (data: PreferenceData) => void;

  constructor(
    saveFn: (data: PreferenceData) => void,
    initialData?: Partial<PreferenceData>
  ) {
    this.saveFn = saveFn;
    this.data = { ...DEFAULT_DATA, ...initialData };
    if (initialData?.thresholds) {
      this.data.thresholds = { ...DEFAULT_DATA.thresholds, ...initialData.thresholds };
    }
    if (initialData?.accepted) {
      this.data.accepted = initialData.accepted;
    }
    if (initialData?.rejected) {
      this.data.rejected = initialData.rejected;
    }
  }

  /**
   * 记录一次反馈
   */
  record(actionType: string, suggestion: string, accepted: boolean): void {
    const key = accepted ? "accepted" : "rejected";
    const bucket = this.data[key];

    if (!bucket[actionType]) {
      bucket[actionType] = [];
    }

    // 去重
    if (bucket[actionType].includes(suggestion)) return;

    bucket[actionType].push(suggestion);

    // 保留最近 100 条
    if (bucket[actionType].length > 100) {
      bucket[actionType] = bucket[actionType].slice(-100);
    }

    this.saveFn(this.data);
  }

  /**
   * 获取某类建议的历史采纳率
   */
  getAcceptRate(actionType: string): number | null {
    const accepted = this.data.accepted[actionType]?.length || 0;
    const rejected = this.data.rejected[actionType]?.length || 0;
    const total = accepted + rejected;
    if (total === 0) return null;
    return accepted / total;
  }

  getThresholds(): PreferenceData["thresholds"] {
    return this.data.thresholds;
  }

  updateThreshold(key: keyof PreferenceData["thresholds"], value: number): void {
    this.data.thresholds[key] = value;
    this.saveFn(this.data);
  }

  /**
   * 获取数据（用于注入到 Agent prompt）
   */
  getData(): PreferenceData {
    return this.data;
  }
}
