import os
import sqlite3
from datetime import datetime
from .config import settings


class UsageTracker:
    def __init__(self):
        self.db_path = settings.usage_db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    model TEXT,
                    endpoint TEXT,
                    prompt_tokens INTEGER DEFAULT 0,
                    completion_tokens INTEGER DEFAULT 0,
                    prompt_cost REAL DEFAULT 0,
                    completion_cost REAL DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now', 'localtime'))
                )
            """)
            conn.commit()

    def record(self, model: str, endpoint: str, prompt_tokens: int, completion_tokens: int):
        prompt_cost = (prompt_tokens / 1_000_000) * settings.price_prompt_per_million
        completion_cost = (completion_tokens / 1_000_000) * settings.price_completion_per_million

        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO usage (model, endpoint, prompt_tokens, completion_tokens, prompt_cost, completion_cost) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (model, endpoint, prompt_tokens, completion_tokens, prompt_cost, completion_cost),
            )
            conn.commit()

    def today(self) -> dict:
        today = datetime.now().strftime("%Y-%m-%d")
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT "
                "  COUNT(*) as calls, "
                "  COALESCE(SUM(prompt_tokens), 0) as prompt_tokens, "
                "  COALESCE(SUM(completion_tokens), 0) as completion_tokens, "
                "  COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens, "
                "  COALESCE(SUM(prompt_cost + completion_cost), 0) as total_cost "
                "FROM usage WHERE created_at >= ?",
                (today,),
            ).fetchone()

        return {
            "date": today,
            "calls": row[0],
            "prompt_tokens": row[1],
            "completion_tokens": row[2],
            "total_tokens": row[3],
            "total_cost_rmb": round(row[4], 6),
        }

    def summary(self) -> dict:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT "
                "  COUNT(*) as calls, "
                "  COALESCE(SUM(prompt_tokens), 0) as prompt_tokens, "
                "  COALESCE(SUM(completion_tokens), 0) as completion_tokens, "
                "  COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens, "
                "  COALESCE(SUM(prompt_cost + completion_cost), 0) as total_cost, "
                "  MIN(created_at) as first_call, "
                "  MAX(created_at) as last_call "
                "FROM usage"
            ).fetchone()

        return {
            "calls": row[0],
            "prompt_tokens": row[1],
            "completion_tokens": row[2],
            "total_tokens": row[3],
            "total_cost_rmb": round(row[4], 6),
            "first_call": row[5],
            "last_call": row[6],
        }

    def recent(self, limit: int = 20) -> list[dict]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT model, endpoint, prompt_tokens, completion_tokens, "
                "prompt_cost, completion_cost, created_at "
                "FROM usage ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()

        return [
            {
                "model": r[0],
                "endpoint": r[1],
                "prompt_tokens": r[2],
                "completion_tokens": r[3],
                "prompt_cost_rmb": round(r[4], 6),
                "completion_cost_rmb": round(r[5], 6),
                "total_cost_rmb": round(r[4] + r[5], 6),
                "created_at": r[6],
            }
            for r in rows
        ]


usage_tracker = UsageTracker()
