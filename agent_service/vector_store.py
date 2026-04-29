import os
import json
import sqlite3
import numpy as np
from .config import settings


class VectorStore:
    def __init__(self):
        os.makedirs(settings.chroma_db_path, exist_ok=True)
        self.db_path = os.path.join(settings.chroma_db_path, "vectors.db")
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    content TEXT,
                    content_preview TEXT,
                    embedding BLOB,
                    metadata TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

    def _embed_to_bytes(self, embedding: list[float]) -> bytes:
        return np.array(embedding, dtype=np.float32).tobytes()

    def _bytes_to_embed(self, data: bytes) -> np.ndarray:
        return np.frombuffer(data, dtype=np.float32)

    def _cosine_similarity(self, query: np.ndarray, vectors: list[np.ndarray]) -> np.ndarray:
        query_norm = query / (np.linalg.norm(query) + 1e-10)
        vecs_matrix = np.stack(vectors)
        vecs_norm = vecs_matrix / (np.linalg.norm(vecs_matrix, axis=1, keepdims=True) + 1e-10)
        return np.dot(vecs_norm, query_norm)

    def add_or_update(self, note_id: str, title: str, content: str, embedding: list[float], metadata: dict = None):
        meta = json.dumps(metadata or {}, ensure_ascii=False)
        embed_bytes = self._embed_to_bytes(embedding)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """INSERT OR REPLACE INTO notes (id, title, content, content_preview, embedding, metadata, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                (note_id, title, content, content[:500], embed_bytes, meta),
            )
            conn.commit()

    def search_similar(self, query_embedding: list[float], n: int = 5) -> list[dict]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT id, title, content, embedding, metadata FROM notes").fetchall()
            if not rows:
                return []

            query_vec = np.array(query_embedding, dtype=np.float32)
            stored_vecs = [self._bytes_to_embed(row[3]) for row in rows]

            similarities = self._cosine_similarity(query_vec, stored_vecs)

            top_n = min(n, len(rows))
            top_indices = np.argsort(similarities)[::-1][:top_n]

            items = []
            for idx in top_indices:
                row = rows[idx]
                items.append({
                    "id": row[0],
                    "distance": float(1.0 - similarities[idx]),
                    "title": row[1],
                    "content": row[2],
                })
            return items

    def delete(self, note_id: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            conn.commit()

    def count(self) -> int:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM notes").fetchone()
            return row[0] if row else 0


vector_store = VectorStore()
