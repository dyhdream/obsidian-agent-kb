import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .config import settings
from .orchestrator import orchestrator
from .vector_store import vector_store
from .usage_tracker import usage_tracker

app = FastAPI(title="Obsidian Agent KB", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    file_path: str
    content: str
    tags: list[str] = []
    session_id: str = ""


class FeedbackRequest(BaseModel):
    action_type: str
    suggestion: str
    accepted: bool


class SplitRequest(BaseModel):
    file_path: str
    content: str
    topics: list[str]


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "note_count": vector_store.count(),
    }


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    result = await orchestrator.analyze(req.file_path, req.content, req.tags, req.session_id)
    return result


@app.post("/api/analyze/start")
async def analyze_start(req: AnalyzeRequest):
    """启动异步分析，立即返回 session_id。"""
    sid = orchestrator.start_analyze(req.file_path, req.content, req.tags)
    return {"session_id": sid}


@app.get("/api/analyze/results/{session_id}")
async def get_results(session_id: str):
    """轮询获取当前进度和已有结果。"""
    return orchestrator.get_results(session_id)


@app.post("/api/feedback")
async def feedback(req: FeedbackRequest):
    orchestrator.record_feedback(req.action_type, req.suggestion, req.accepted)
    return {"status": "ok"}


@app.post("/api/split")
async def split_note(req: SplitRequest):
    result = await orchestrator.split_note(req.file_path, req.content, req.topics)
    return result


@app.get("/api/usage")
async def get_usage():
    """获取今日用量和累计用量"""
    return {
        "today": usage_tracker.today(),
        "total": usage_tracker.summary(),
        "recent": usage_tracker.recent(10),
        "pricing": {
            "prompt_per_million": settings.price_prompt_per_million,
            "completion_per_million": settings.price_completion_per_million,
            "currency": "RMB",
        },
    }


def main():
    uvicorn.run(
        "agent_service.main:app",
        host=settings.agent_host,
        port=settings.agent_port,
        reload=settings.reload,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
