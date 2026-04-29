import os
import json
from typing import Optional


class PreferenceLearner:
    def __init__(self, save_path: str = "./preferences.json"):
        self.save_path = save_path
        self.data = self._load()

    def _load(self) -> dict:
        if os.path.exists(self.save_path):
            with open(self.save_path, "r", encoding="utf-8") as f:
                return json.load(f)
        return {
            "accepted": {},
            "rejected": {},
            "thresholds": {
                "link_confidence_min": 0.3,
                "split_min_chars": 800,
                "merge_max_chars": 100,
                "moc_cluster_min": 10,
                "orphan_link_max": 2,
            },
        }

    def _save(self):
        with open(self.save_path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    def record(self, action_type: str, suggestion: str, accepted: bool):
        key = "accepted" if accepted else "rejected"
        bucket = self.data[key]
        if action_type not in bucket:
            bucket[action_type] = []
        # 去重：同一条 suggestion 不重复记录
        if suggestion in bucket[action_type]:
            return
        bucket[action_type].append(suggestion)
        if len(bucket[action_type]) > 100:
            bucket[action_type] = bucket[action_type][-100:]
        self._save()

    def get_accept_rate(self, action_type: str) -> Optional[float]:
        accepted = len(self.data["accepted"].get(action_type, []))
        rejected = len(self.data["rejected"].get(action_type, []))
        total = accepted + rejected
        if total == 0:
            return None
        return accepted / total

    def get_thresholds(self) -> dict:
        return self.data["thresholds"]

    def update_threshold(self, key: str, value: float):
        self.data["thresholds"][key] = value
        self._save()


preference_learner = PreferenceLearner()
