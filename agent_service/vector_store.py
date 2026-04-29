import os
import json
import chromadb
from chromadb.config import Settings as ChromaSettings
from .config import settings


class VectorStore:
    def __init__(self):
        os.makedirs(settings.chroma_db_path, exist_ok=True)
        self.client = chromadb.PersistentClient(
            path=settings.chroma_db_path,
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self.collection = self.client.get_or_create_collection(
            name="obsidian_notes",
            metadata={"hnsw:space": "cosine"},
        )

    def add_or_update(self, note_id: str, title: str, content: str, embedding: list[float], metadata: dict = None):
        meta = metadata or {}
        meta["title"] = title
        meta["content_preview"] = content[:500]
        self.collection.upsert(
            ids=[note_id],
            embeddings=[embedding],
            documents=[content],
            metadatas=[meta],
        )

    def search_similar(self, query_embedding: list[float], n: int = 5) -> list[dict]:
        if self.collection.count() == 0:
            return []
        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=min(n, self.collection.count()),
            include=["documents", "metadatas", "distances"],
        )
        items = []
        for i in range(len(results["ids"][0])):
            items.append({
                "id": results["ids"][0][i],
                "distance": results["distances"][0][i],
                "title": results["metadatas"][0][i].get("title", ""),
                "content": results["documents"][0][i],
            })
        return items

    def delete(self, note_id: str):
        self.collection.delete(ids=[note_id])

    def count(self) -> int:
        return self.collection.count()


vector_store = VectorStore()
