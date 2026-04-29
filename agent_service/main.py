import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import settings
from .orchestrator import orchestrator
from .vector_store import vector_store

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
    result = await orchestrator.analyze(req.file_path, req.content, req.tags)
    return result


@app.post("/api/feedback")
async def feedback(req: FeedbackRequest):
    orchestrator.record_feedback(req.action_type, req.suggestion, req.accepted)
    return {"status": "ok"}


@app.post("/api/split")
async def split_note(req: SplitRequest):
    result = await orchestrator.split_note(req.file_path, req.content, req.topics)
    return result


def main():
    uvicorn.run(
        "agent_service.main:app",
        host=settings.agent_host,
        port=settings.agent_port,
        reload=True,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
