"""
Agent 基类 — 统一扮演者接口。
每个 Agent 拥有：身份(role) + 工具(tools) + 黑板读写权限 + 偏好注入。
"""

import json
import re
import time
from abc import ABC, abstractmethod
from .deepseek_client import client as ds
from .preference_learner import preference_learner
from .session_memory import session_memory


class Agent(ABC):
    """Agent 基类，定义统一接口。"""

    role: str = "base"           # 角色标识
    persona: str = ""            # 系统提示词（角色设定）
    tools: list[dict] = []       # 可用工具（JSON Schema 格式）

    def __init__(self, blackboard):
        self.blackboard = blackboard
        self._call_count = 0
        self._start_time = time.time()

    # ── 抽象方法 ──

    @abstractmethod
    def system_prompt(self) -> str:
        """返回注入偏好后的完整系统 prompt。"""

    @abstractmethod
    def user_prompt(self) -> str:
        """从黑板构建本次调用的用户 prompt。"""

    @abstractmethod
    def handle_response(self, raw: str) -> bool:
        """解析 LLM 返回，写入黑板。返回 True 表示完成。"""

    # ── 通用方法 ──

    async def run(self) -> dict:
        """Agent 执行入口。一次 LLM 调用 → 写入黑板。"""
        self._call_count += 1

        system = self.system_prompt()
        user = self.user_prompt()

        max_retries = 2
        for attempt in range(max_retries):
            try:
                raw = await ds.chat(
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    temperature=0.3,
                    max_tokens=2048,
                )
                ok = self.handle_response(raw)
                if ok:
                    return {"role": self.role, "status": "ok"}
            except Exception as e:
                if attempt < max_retries - 1:
                    continue
                return {"role": self.role, "status": "error", "error": str(e)}

        return {"role": self.role, "status": "error", "error": "max_retries_exceeded"}

    def inject_preferences(self) -> str:
        """根据偏好学习器数据生成偏好注入片段，附在 system prompt 尾部。"""
        thresholds = preference_learner.data.get("thresholds", {})
        rejected = session_memory.get_rejected_in_session()

        # 永久忽略列表
        perm = preference_learner.data.get("rejected", {}).get("permanent_ignore", [])
        seen = set()
        permanent_ignores = []
        for p in perm[:-30:-1]:  # 最近 30 条
            if p not in seen:
                permanent_ignores.append(p)
                seen.add(p)

        lines = ["\n## 用户偏好（动态注入）\n"]
        if rejected:
            rejected_str = "、".join(rejected[:10])
            lines.append(f"- 本次会话中已被拒绝的建议: {rejected_str}")
            lines.append(f"- 如果涉及上述内容，请降低置信度或直接跳过")

        if permanent_ignores:
            lines.append(f"- 用户永久忽略的主题（不要再建议）: {'、'.join(permanent_ignores[:10])}")

        rates = {
            "link": preference_learner.get_accept_rate("link"),
            "tag": preference_learner.get_accept_rate("tag"),
            "structure": preference_learner.get_accept_rate("structure"),
        }
        for key, rate in (rates or {}).items():
            if rate is not None:
                label = {"link": "链接", "tag": "标签", "structure": "结构"}.get(key, key)
                lines.append(f"- {label}建议的历史采纳率: {rate:.0%}")

        return "\n".join(lines)

    @staticmethod
    def parse_json(raw: str) -> dict:
        match = re.search(r"\{[\s\S]*\}", raw)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return {}

    @staticmethod
    def parse_json_list(raw: str) -> list:
        match = re.search(r"\[[\s\S]*\]", raw)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        return []
