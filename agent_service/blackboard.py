"""
Blackboard — 所有 Agent 共享的读写黑板。
Agent 透过黑板看到彼此的输出，形成真正的协作而非独立管道。
"""


class Blackboard:
    def __init__(self):
        self._sections = {
            "current": {},       # 当前笔记元信息
            "vault": {},         # vault 全局信息
            "similar": [],       # 语义相近笔记
            "findings": {        # 各 Agent 的分析产出
                "links": [],     # LinkWeaver 产出
                "concepts": [],  # LinkWeaver 产出
                "orphans": [],   # LinkWeaver 产出
                "tags": [],      # StructureGuardian 产出
                "structure": {}, # StructureGuardian 产出
            },
            "review": {          # Reviewer 最终产出
                "suggestions": [],
                "summary": "",
            },
            "session": {         # 会话级信息
                "user_preferences": {},
                "rejected_this_session": [],
                "hook_points": {},  # 留给后续 Agent 之间插入消息
            },
        }

    def read(self, section: str) -> dict:
        return self._sections.get(section, {})

    def write(self, section: str, data):
        self._sections[section] = data

    def update(self, section: str, data: dict):
        target = self._sections.get(section, {})
        if isinstance(target, dict):
            target.update(data)
        elif isinstance(target, list):
            if isinstance(data, list):
                target.extend(data)
            else:
                target.append(data)

    def write_finding(self, agent: str, key: str, data):
        self._sections["findings"][key] = data

    def snapshot(self) -> dict:
        return self._sections

    def has(self, section: str) -> bool:
        return bool(self._sections.get(section))

    def clear_session(self):
        self._sections["session"] = {
            "user_preferences": {},
            "rejected_this_session": [],
            "hook_points": {},
        }
