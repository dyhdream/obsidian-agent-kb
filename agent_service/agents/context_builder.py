import os
import hashlib
import time
from ..config import settings
from ..vector_store import vector_store


class ContextBuilder:
    def __init__(self):
        self._vault_cache = None
        self._vault_cache_time = 0
        self._cache_ttl = 10  # 10 秒缓存

    async def build(self, file_path: str, content: str, tags: list[str] = None) -> dict:
        note_id = hashlib.md5(file_path.encode()).hexdigest()

        similar_notes = vector_store.search_similar(content, n=settings.max_context_notes)

        vault_data = self._scan_vault(file_path, tags or [])

        vector_store.add_or_update(
            note_id=note_id,
            title=os.path.basename(file_path).replace(".md", ""),
            content=content,
            metadata={"path": file_path, "tags": ",".join(tags or [])},
        )

        return {
            "note_id": note_id,
            "file_path": file_path,
            "title": os.path.basename(file_path).replace(".md", ""),
            "content": content[:settings.max_note_chars],
            "tags": tags or [],
            "similar_notes": similar_notes,
            "linked_notes": vault_data["linked"],
            "all_titles": vault_data["titles"],
            "total_notes": vector_store.count(),
        }

    def _scan_vault(self, current_path: str, tags: list[str]) -> dict:
        vault = settings.vault_path
        if not vault or not os.path.isdir(vault):
            return {"titles": [], "linked": []}

        now = time.time()
        if self._vault_cache and (now - self._vault_cache_time) < self._cache_ttl:
            return self._filter_cache(current_path, tags)

        current_basename = os.path.basename(current_path)
        titles = []
        linked = []

        for root, _, files in os.walk(vault):
            if ".obsidian" in root or ".trash" in root:
                continue
            for fname in files:
                if not fname.endswith(".md") or fname == current_basename:
                    continue
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, vault)
                title = os.path.splitext(fname)[0]
                titles.append({"title": title, "path": rel})

                if tags and len(linked) < 10:
                    try:
                        with open(fpath, "r", encoding="utf-8") as f:
                            fcontent = f.read()
                        if any(tag.lower() in fcontent.lower() for tag in tags):
                            linked.append(rel)
                    except Exception:
                        pass

        self._vault_cache = {"titles": titles, "linked_all": linked}
        self._vault_cache_time = now

        return {"titles": titles, "linked": linked}

    def _filter_cache(self, current_path: str, tags: list[str]) -> dict:
        current_basename = os.path.basename(current_path)
        titles = [t for t in self._vault_cache["titles"] if not t["path"].endswith(current_basename)]
        linked = self._vault_cache.get("linked_all", []) if tags else []
        return {"titles": titles, "linked": linked}


context_builder = ContextBuilder()
