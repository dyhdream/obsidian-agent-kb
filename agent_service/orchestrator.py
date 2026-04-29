"""
新编排器 — Agent 协作工作流
情报员 → 链接师 → 架构师 → 品控官
黑板驱动，前一 Agent 的产出对后续 Agent 可见。
"""

from .blackboard import Blackboard
from .agents.context_scout import ContextScout
from .agents.link_weaver import LinkWeaver
from .agents.structure_guardian import StructureGuardian
from .agents.reviewer import Reviewer
from .agents.note_splitter import note_splitter
from .preference_learner import preference_learner
from .session_memory import session_memory


class Orchestrator:
    def __init__(self):
        self.blackboard = Blackboard()

    async def analyze(self, file_path: str, content: str, tags: list[str] = None) -> dict:
        """执行完整的 Agent 协作流程。"""
        tags = tags or []

        # 重设会话黑名单（每次分析复用同一会话记忆）
        self.blackboard.clear_session()

        # ── Phase 1: 情报员扫描 Vault ──
        ContextScout.scan_vault(file_path, content, tags, self.blackboard)

        # ── Phase 2: 情报员 LLM 分析（可选轻量分析） ──
        try:
            await ContextScout(self.blackboard).run()
        except Exception as e:
            # 情报员失败不算致命，继续
            pass

        # ── Phase 3: 链接师 ──
        link_result = await LinkWeaver(self.blackboard).run()

        # ── Phase 4: 架构师（能看到链接师产出） ──
        structure_result = await StructureGuardian(self.blackboard).run()

        # ── Phase 5: 品控官 ──
        review_result = await Reviewer(self.blackboard).run()

        review = self.blackboard.read("review")
        findings = self.blackboard.read("findings")

        return {
            "file_path": file_path,
            "title": self.blackboard.read("current").get("title", ""),
            "context": {
                "note_count": self.blackboard.read("vault").get("total_notes", 0),
                "similar_count": len(self.blackboard.read("similar")),
                "agent_status": {
                    "scout": "ok",
                    "link_weaver": link_result.get("status"),
                    "structure_guardian": structure_result.get("status"),
                    "reviewer": review_result.get("status"),
                },
            },
            "suggestions": {
                "link": {
                    "links": findings.get("links", []),
                    "orphans": findings.get("orphans", []),
                    "new_concepts": findings.get("concepts", []),
                },
                "structure": findings.get("structure", {}),
                "tags": findings.get("tags", []),
            },
            "review": {
                "suggestions": review.get("suggestions", []),
                "summary": review.get("summary", ""),
                "conflicts": review.get("conflicts", []),
            },
        }

    def record_feedback(self, action_type: str, suggestion: str, accepted: bool):
        preference_learner.record(action_type, suggestion, accepted)

        if not accepted:
            session_memory.record_rejection(action_type, suggestion)

    async def split_note(self, file_path: str, content: str, topics: list[str]) -> dict:
        return await note_splitter.split(file_path, content, topics)


orchestrator = Orchestrator()
