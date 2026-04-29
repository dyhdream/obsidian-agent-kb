import os
import json
import sqlite3
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from .config import settings


class VectorStore:
    def __init__(self):
        os.makedirs(settings.chroma_db_path, exist_ok=True)
        self.db_path = os.path.join(settings.chroma_db_path, "vectors.db")
        self._init_db()
        self.vectorizer = TfidfVectorizer(max_features=512)
        self._rebuild_index()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    content TEXT,
                    content_preview TEXT,
                    metadata TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

    def _rebuild_index(self):
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT id, content FROM notes").fetchall()
            if rows:
                docs = [row[1] for row in rows]
                self.vectorizer.fit(docs)

    def add_or_update(self, note_id: str, title: str, content: str, metadata: dict = None):
        meta = json.dumps(metadata or {}, ensure_ascii=False)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """INSERT OR REPLACE INTO notes (id, title, content, content_preview, metadata, updated_at)
                   VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                (note_id, title, content, content[:500], meta),
            )
            conn.commit()
        self._rebuild_index()

    def search_similar(self, content: str, n: int = 5) -> list[dict]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT id, title, content FROM notes ORDER BY updated_at DESC").fetchall()
            if not rows:
                return []

            docs = [row[2] for row in rows]

            try:
                tfidf_matrix = self.vectorizer.transform(docs)
                query_vec = self.vectorizer.transform([content])
                similarities = cosine_similarity(query_vec, tfidf_matrix)[0]
            except Exception:
                return []

            indices = np.argsort(similarities)[::-1]
            items = []
            for idx in indices:
                row = rows[idx]
                sim = float(similarities[idx])
                if sim < 0.05:
                    continue
                items.append({
                    "id": row[0],
                    "distance": float(1.0 - sim),
                    "title": row[1],
                    "content": row[2],
                })
                if len(items) >= n:
                    break

            return items

    def delete(self, note_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            conn.commit()
        self._rebuild_index()

    def count(self) -> int:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM notes").fetchone()
            return row[0] if row else 0


vector_store = VectorStore()
