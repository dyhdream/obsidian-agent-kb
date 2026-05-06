"""
VectorStore — 轻量 TF-IDF 向量库
只索引标题 + 首段（<200 字），无需全量读取每个文件。
"""

import os
import sqlite3
import numpy as np
import json
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from .config import settings


class VectorStore:
    def __init__(self):
        os.makedirs(settings.data_db_path, exist_ok=True)
        self.db_path = os.path.join(settings.data_db_path, "vectors.db")
        self._init_db()
        # 只索引短文本 (标题 + 前 200 字)
        self.vectorizer = TfidfVectorizer(max_features=256, analyzer="char_wb", ngram_range=(2, 4))
        self._cached_matrix = None     # 预计算的 TF-IDF 矩阵 (numpy array)
        self._cached_data = []         # 对应的 [{id, title, content}, ...]
        self._dirty = True             # 脏标记，add 后置为 True
        self._rebuild_count = 0
        self._ensure_cache()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    content TEXT,
                    short_text TEXT,
                    metadata TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_updated ON notes(updated_at)")
            conn.commit()

    def _ensure_cache(self):
        """按需重建缓存"""
        if not self._dirty and self._cached_matrix is not None:
            return
            
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT id, title, content, short_text FROM notes ORDER BY updated_at DESC").fetchall()
            
        self._cached_data = [{"id": r[0], "title": r[1], "content": r[2]} for r in rows]
        docs = [r[3] or "" for r in rows]
        
        if docs:
            self.vectorizer.fit(docs)
            self._cached_matrix = self.vectorizer.transform(docs)
        else:
            self._cached_matrix = None
            
        self._dirty = False

    def add_or_update(self, note_id: str, title: str, content: str, metadata: dict = None):
        short = f"{title} {content[:200]}"
        meta_json = json.dumps(metadata or {}, ensure_ascii=False)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """INSERT OR REPLACE INTO notes (id, title, content, short_text, metadata, updated_at)
                   VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
                (note_id, title, content[:500], short, meta_json),
            )
            conn.commit()

        # 增量重建（只在新笔记 > 50 时触发全量）
        self._rebuild_count += 1
        if self._rebuild_count > 50:
            self._ensure_cache()
            self._rebuild_count = 0
        else:
            self._dirty = True

    def search_similar(self, text: str, n: int = 5) -> list[dict]:
        """使用缓存的矩阵进行检索"""
        self._ensure_cache()  # 仅在首次或脏时重建
        
        if self._cached_matrix is None:
            return []
            
        short = text[:200]
        try:
            query_vec = self.vectorizer.transform([short])
            similarities = cosine_similarity(query_vec, self._cached_matrix)[0]
        except Exception:
            return []

        indices = np.argsort(similarities)[::-1]
        items = []
        for idx in indices:
            data = self._cached_data[idx]
            sim = float(similarities[idx])
            if sim < 0.05:
                continue
            items.append({
                "id": data["id"],
                "distance": float(1.0 - sim),
                "title": data["title"],
                "content": data["content"],
            })
            if len(items) >= n:
                break

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
