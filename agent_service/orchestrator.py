"""
新编排器 — Agent 协作工作流
情报员 → 链接师 → 架构师 → 品控官
黑板驱动，前一 Agent 的产出对后续 Agent 可见。
支持异步后台分析 + 轮询获取增量结果。
"""

import json
import time
import asyncio
from .blackboard import Blackboard
from .agents.context_scout import ContextScout
from .agents.link_weaver import LinkWeaver
from .agents.structure_guardian import StructureGuardian
from .agents.reviewer import Reviewer
from .agents.note_splitter import note_splitter
from .preference_learner import preference_learner
from .session_memory import session_memory

# 全局结果存储: session_id → {status, phase, results, ...}
result_store: dict[str, dict] = {}

# TTL 默认: 300 秒，定期清理
_SESSION_TTL = 300
_last_cleanup = 0

def _cleanup_stale_store():
    global _last_cleanup
    now = time.time()
    if now - _last_cleanup < 60:
        return
    _last_cleanup = now
    stale = [sid for sid, v in result_store.items()
              if v.get("done") and now - v.get("updated_at", 0) > _SESSION_TTL]
    for sid in stale:
        result_store.pop(sid, None)


class Orchestrator:
    async def analyze(self, file_path: str, content: str, tags: list[str] = None, session_id: str = "") -> dict:
        """同步版（向后兼容），返回完整结果。"""
        tags = tags or []
        sid = session_id or str(int(time.time() * 1000))

        bb = Blackboard()
        bb.clear_session()
        ContextScout.scan_vault(file_path, content, tags, bb)

        try:
            await ContextScout(bb).run()
        except Exception:
            pass

        link_result = await LinkWeaver(bb).run()
        structure_result = await StructureGuardian(bb).run()
        review_result = await Reviewer(bb).run()

        return self._build_response(sid, file_path, bb, link_result, structure_result, review_result)

    def start_analyze(self, file_path: str, content: str, tags: list[str] = None) -> str:
        _cleanup_stale_store()

        sid = str(int(time.time() * 1000))
        tags = tags or []

        result_store[sid] = {
            "status": "running",
            "phase": "queued",
            "label": "排队中...",
            "suggestions": [],
            "done": False,
            "updated_at": time.time(),
        }

        asyncio.create_task(self._run_analysis(sid, file_path, content, tags))
        return sid

    async def _run_analysis(self, sid: str, file_path: str, content: str, tags: list[str]):
        import asyncio as _asyncio
        try:
            bb = Blackboard()
            bb.clear_session()

            def update(phase: str, label: str, suggestions: list = None):
                store = result_store.get(sid, {})
                store.update({"phase": phase, "label": label, "updated_at": time.time()})
                if suggestions:
                    store["suggestions"] = list(store.get("suggestions", []))
                    store["suggestions"].extend(suggestions)
                result_store[sid] = store

            # Phase 1: 情报员扫描 (无 LLM，< 0.5s)
            update("scout", "扫描知识库...")
            ContextScout.scan_vault(file_path, content, tags, bb)

            # Phase 2: 链接师 + 架构师 并行 (~12s，而非串行 24s)
            update("agents", "链接师 & 架构师分析中...")
            link_task = LinkWeaver(bb).run()
            struct_task = StructureGuardian(bb).run()
            link_result, struct_result = await _asyncio.gather(link_task, struct_task)

            # 合并产出，立刻写入 result_store（不等 reviewer）
            findings = bb.read("findings")
            all_sugs = (
                self._format_link_findings(findings, file_path) +
                self._format_structure_findings(findings, file_path)
            )
            update("agents", "产出建议中...", all_sugs)

            # Phase 3: 品控官 后台静默，完成后自动追加精化建议
            update("reviewer", "品控官审核中...")
            review_task = _asyncio.create_task(Reviewer(bb).run())

            async def apply_review():
                try:
                    await review_task
                    review = bb.read("review")
                    final = review.get("suggestions", [])
                    if final:
                        # 品控官产出覆盖之前未精化的建议
                        result_store[sid]["suggestions"] = final
                        result_store[sid]["phase"] = "done"
                        result_store[sid]["label"] = "完成"
                except Exception:
                    pass
                result_store[sid]["done"] = True
                result_store[sid]["status"] = "done"

            _asyncio.create_task(apply_review())

        except Exception as e:
            result_store[sid] = {
                "status": "error", "phase": "error",
                "label": str(e)[:200], "suggestions": [], "done": True,
            }

    def get_results(self, session_id: str) -> dict:
        """获取当前进度和已有结果。"""
        return result_store.get(session_id, {
            "status": "not_found",
            "phase": "unknown",
            "suggestions": [],
            "done": True,
        })

    def _format_link_findings(self, findings: dict, file_path: str) -> list[dict]:
        sugs = []
        for l in findings.get("links", []):
            sugs.append({
                "type": "link", "priority": 1,
                "title": "链接到 [[" + l.get("target", "") + "]]",
                "description": "锚点: \"" + l.get("anchor_text", "") + "\" — " + l.get("reason", ""),
            })
        for c in findings.get("concepts", []):
            sugs.append({
                "type": "concept", "priority": 2,
                "title": "可新建: " + str(c),
                "description": "知识库中暂无此概念对应笔记",
            })
        for o in findings.get("orphans", []):
            sugs.append({
                "type": "orphan", "priority": 3,
                "title": "孤岛笔记: " + str(o.get("note_title", o.get("note_id", ""))),
                "description": o.get("reason", ""),
            })
        return sugs

    def _format_structure_findings(self, findings: dict, file_path: str) -> list[dict]:
        sugs = []
        for t in findings.get("tags", []):
            sugs.append({
                "type": "tag", "priority": 3,
                "title": "#" + t.get("current", "") + " → #" + t.get("suggested", ""),
                "description": t.get("reason", ""),
            })

        struct = findings.get("structure", {})
        split = struct.get("split", {})
        if split.get("needs_split"):
            sugs.append({
                "type": "structure", "priority": 2,
                "title": "建议拆分笔记",
                "description": split.get("reason", "") + " → 主题: " + "、".join(split.get("suggested_topics", [])),
            })

        fm = struct.get("frontmatter", {})
        missing = fm.get("missing_fields", [])
        if missing:
            sugs.append({
                "type": "structure", "priority": 1,
                "title": "前言字段缺失",
                "description": "缺少: " + "、".join(missing),
            })

        moc = struct.get("moc", {})
        if moc.get("needs_moc"):
            sugs.append({
                "type": "moc", "priority": 3,
                "title": "建议创建 MOC: " + moc.get("topic", ""),
                "description": moc.get("reason", ""),
            })
        return sugs

    def _build_response(self, sid, file_path, bb, link_result, structure_result, review_result):
        review = bb.read("review")
        findings = bb.read("findings")
        return {
            "session_id": sid,
            "file_path": file_path,
            "title": bb.read("current").get("title", ""),
            "context": {
                "note_count": bb.read("vault").get("total_notes", 0),
                "agent_status": {
                    "link_weaver": link_result.get("status"),
                    "structure_guardian": structure_result.get("status"),
                    "reviewer": review_result.get("status"),
                },
            },
            "suggestions": {
                "link": {"links": findings.get("links", []), "orphans": findings.get("orphans", []), "new_concepts": findings.get("concepts", [])},
                "structure": findings.get("structure", {}),
                "tags": findings.get("tags", []),
            },
            "review": {"suggestions": review.get("suggestions", []), "summary": review.get("summary", "")},
        }

    def record_feedback(self, action_type: str, suggestion: str, accepted: bool):
        preference_learner.record(action_type, suggestion, accepted)
        if not accepted:
            session_memory.record_rejection(action_type, suggestion)

    async def split_note(self, file_path: str, content: str, topics: list[str]) -> dict:
        return await note_splitter.split(file_path, content, topics)


orchestrator = Orchestrator()
