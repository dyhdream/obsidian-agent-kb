"""
SessionMemory — 第一层即时调整
当前会话内，用户拒绝某个建议后，该 Session 内不再提示同类内容。
服务重启或用户手动清除后重置。
"""


class SessionMemory:
    def __init__(self):
        self._rejected = set()           # 被拒绝的建议 ID
        self._rejected_targets = set()   # 被拒绝的目标（如 [[PostgreSQL]]）
        self._threshold_overrides = {}   # 会话内临时阈值调整

    def record_rejection(self, suggestion_type: str, title: str):
        self._rejected.add(f"{suggestion_type}:{title}")

        # 提取被拒绝的链接目标: [[xxx]] → xxx
        import re
        match = re.search(r"\[\[([^\]]+)\]\]", title)
        if match:
            self._rejected_targets.add(match.group(1))

    def is_rejected(self, suggestion_type: str, title: str) -> bool:
        return f"{suggestion_type}:{title}" in self._rejected

    def get_rejected_in_session(self) -> list[str]:
        return list(self._rejected)[-20:]

    def get_rejected_targets(self) -> list[str]:
        return list(self._rejected_targets)

    def should_skip(self, suggestion_type: str, target: str) -> bool:
        return f"{suggestion_type}:{target}" in self._rejected or target in self._rejected_targets

    def override_threshold(self, key: str, value):
        self._threshold_overrides[key] = value

    def get_threshold_override(self, key: str, default=None):
        return self._threshold_overrides.get(key, default)

    def clear(self):
        self._rejected.clear()
        self._rejected_targets.clear()
        self._threshold_overrides.clear()

    def snapshot(self) -> dict:
        return {
            "rejected": list(self._rejected),
            "rejected_targets": list(self._rejected_targets),
            "thresholds": dict(self._threshold_overrides),
        }


session_memory = SessionMemory()
