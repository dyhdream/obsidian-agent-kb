"""
新编排器 — Agent 协作工作流
情报员 → 链接师 → 架构师 → 品控官
黑板驱动，前一 Agent 的产出对后续 Agent 可见。
支持进度追踪 + SSE 流式输出。
"""

import json
import time
from .blackboard import Blackboard
from .agents.context_scout import ContextScout
from .agents.link_weaver import LinkWeaver
from .agents.structure_guardian import StructureGuardian
from .agents.reviewer import Reviewer
from .agents.note_splitter import note_splitter
from .preference_learner import preference_learner
from .session_memory import session_memory

# 全局进度追踪
progress_registry: dict[str, dict] = {}


class Orchestrator:
    def __init__(self):
        self.blackboard = Blackboard()

    async def analyze(self, file_path: str, content: str, tags: list[str] = None, session_id: str = "") -> dict:
        """执行完整的 Agent 协作流程。"""
        tags = tags or []
        sid = session_id or str(int(time.time() * 1000))

        def set_progress(phase: str, label: str):
            progress_registry[sid] = {
                "phase": phase,
                "label": label,
                "session_id": sid,
                "timestamp": time.time(),
            }

        # 重设会话黑名单
        self.blackboard.clear_session()

        # ── Phase 1: 情报员扫描 Vault ──
        set_progress("scout", "扫描知识库...")
        ContextScout.scan_vault(file_path, content, tags, self.blackboard)

        # ── Phase 2: 情报员 LLM 分析 ──
        set_progress("scout_llm", "情报员分析中...")
        try:
            await ContextScout(self.blackboard).run()
        except Exception:
            pass

        # ── Phase 3: 链接师 ──
        set_progress("link_weaver", "链接师分析中...")
        link_result = await LinkWeaver(self.blackboard).run()

        # ── Phase 4: 架构师 ──
        set_progress("structure_guardian", "架构师分析中...")
        structure_result = await StructureGuardian(self.blackboard).run()

        # ── Phase 5: 品控官 ──
        set_progress("reviewer", "品控官审核中...")
        review_result = await Reviewer(self.blackboard).run()

        set_progress("done", "完成")

        review = self.blackboard.read("review")
        findings = self.blackboard.read("findings")

        return {
            "session_id": sid,
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

    async def analyze_stream(self, file_path: str, content: str, tags: list[str] = None):
        """SSE 流式分析。每个 Agent 产出立刻 yield 给前端。"""
        tags = tags or []
        self.blackboard.clear_session()

        def sse(event: str, data: dict) -> str:
            return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

        # Phase 1: 情报员扫描
        yield sse("progress", {"phase": "scout", "label": "扫描知识库..."})
        ContextScout.scan_vault(file_path, content, tags, self.blackboard)

        # Phase 2: 情报员 LLM
        yield sse("progress", {"phase": "scout_llm", "label": "情报员分析中..."})
        try:
            await ContextScout(self.blackboard).run()
        except Exception:
            pass

        # Phase 3: 链接师
        yield sse("progress", {"phase": "link_weaver", "label": "链接师分析中..."})
        link_result = await LinkWeaver(self.blackboard).run()

        # ── 链接师产出立刻推送 ──
        findings = self.blackboard.read("findings")
        yield sse("links", {
            "phase": "links",
            "links": findings.get("links", []),
            "concepts": findings.get("concepts", []),
            "orphans": findings.get("orphans", []),
        })

        # Phase 4: 架构师
        yield sse("progress", {"phase": "structure_guardian", "label": "架构师分析中..."})
        structure_result = await StructureGuardian(self.blackboard).run()

        # ── 架构师产出立刻推送 ──
        findings = self.blackboard.read("findings")
        yield sse("structure", {
            "phase": "structure",
            "tags": findings.get("tags", []),
            "structure": findings.get("structure", {}),
        })

        # Phase 5: 品控官
        yield sse("progress", {"phase": "reviewer", "label": "品控官审核中..."})
        review_result = await Reviewer(self.blackboard).run()

        # ── 最终品控结果 ──
        review = self.blackboard.read("review")
        yield sse("done", {
            "phase": "done",
            "suggestions": review.get("suggestions", []),
            "summary": review.get("summary", ""),
            "agent_status": {
                "scout": "ok",
                "link_weaver": link_result.get("status"),
                "structure_guardian": structure_result.get("status"),
                "reviewer": review_result.get("status"),
            },
        })


orchestrator = Orchestrator()
