/**
 * SessionMemory — 会话级即时调整
 * 当前会话内，用户拒绝某个建议后，不再提示同类内容。
 * Obsidian 重启后重置。
 */

export class SessionMemory {
  private rejected: Set<string> = new Set();
  private rejectedTargets: Set<string> = new Set();

  recordRejection(suggestionType: string, title: string): void {
    this.rejected.add(`${suggestionType}:${title}`);

    // 提取被拒绝的链接目标: [[xxx]] → xxx
    const match = title.match(/\[\[([^\]]+)\]\]/);
    if (match) {
      this.rejectedTargets.add(match[1]);
    }
  }

  isRejected(suggestionType: string, title: string): boolean {
    return this.rejected.has(`${suggestionType}:${title}`);
  }

  getRejectedInSession(): string[] {
    return Array.from(this.rejected).slice(-20);
  }

  shouldSkip(suggestionType: string, target: string): boolean {
    return (
      this.rejected.has(`${suggestionType}:${target}`) ||
      this.rejectedTargets.has(target)
    );
  }

  clear(): void {
    this.rejected.clear();
    this.rejectedTargets.clear();
  }
}

export const sessionMemory = new SessionMemory();
