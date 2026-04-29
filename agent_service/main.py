import uvicorn
from fastapi import FastAPI
from .config import settings

app = FastAPI(title="Obsidian Agent KB", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok"}


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
