import asyncio
from .agents.context_builder import context_builder
from .agents.link_analyzer import link_analyzer
from .agents.structure_optimizer import structure_optimizer
from .agents.note_splitter import note_splitter
from .preference_learner import preference_learner


class Orchestrator:
    async def analyze(self, file_path: str, content: str, tags: list[str] = None) -> dict:
        context = await context_builder.build(file_path, content, tags)

        results = {}

        async def run_link_analysis():
            try:
                results["link"] = await link_analyzer.analyze(context)
            except Exception as e:
                results["link"] = {"error": str(e), "links": [], "orphans": [], "new_concepts": []}

        async def run_structure_analysis():
            try:
                results["structure"] = await structure_optimizer.analyze(context)
            except Exception as e:
                results["structure"] = {"error": str(e)}

        await asyncio.gather(run_link_analysis(), run_structure_analysis())

        return {
            "file_path": file_path,
            "title": context["title"],
            "context": {
                "note_count": context["total_notes"],
                "similar_count": len(context["similar_notes"]),
            },
            "suggestions": results,
        }

    def record_feedback(self, action_type: str, suggestion: str, accepted: bool):
        preference_learner.record(action_type, suggestion, accepted)

    async def split_note(self, file_path: str, content: str, topics: list[str]) -> dict:
        return await note_splitter.split(file_path, content, topics)


orchestrator = Orchestrator()
