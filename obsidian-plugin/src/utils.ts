/**
 * 共享工具函数
 */

/**
 * 从 LLM 原始输出中提取 JSON 对象
 * @param raw LLM 返回的原始字符串
 * @returns 解析后的对象，失败返回空对象
 */
export function parseJson(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // JSON 解析失败
    }
  }
  return {};
}

/**
 * 从 LLM 原始输出中提取 JSON 数组
 * @param raw LLM 返回的原始字符串
 * @returns 解析后的数组，失败返回空数组
 */
export function parseJsonList(raw: string): unknown[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // JSON 解析失败
    }
  }
  return [];
}
