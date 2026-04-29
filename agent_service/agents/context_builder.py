import os
import hashlib
from ..config import settings
from ..vector_store import vector_store


class ContextBuilder:
    async def build(self, file_path: str, content: str, tags: list[str] = None) -> dict:
        note_id = hashlib.md5(file_path.encode()).hexdigest()

        similar_notes = vector_store.search_similar(content, n=settings.max_context_notes)

        linked_notes = self._read_linked_notes(file_path, tags or [])
        all_titles = self._list_all_titles(file_path)

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
            "linked_notes": linked_notes,
            "all_titles": all_titles,
            "total_notes": vector_store.count(),
        }

    def _list_all_titles(self, current_path: str) -> list[dict]:
        vault = settings.vault_path
        if not vault or not os.path.isdir(vault):
            return []
        current_basename = os.path.basename(current_path)
        titles = []
        for root, _, files in os.walk(vault):
            if ".obsidian" in root or ".trash" in root:
                continue
            for fname in files:
                if not fname.endswith(".md") or fname == current_basename:
                    continue
                rel = os.path.relpath(os.path.join(root, fname), vault)
                title = os.path.splitext(fname)[0]
                titles.append({"title": title, "path": rel})
        return titles

    def _read_linked_notes(self, file_path: str, tags: list[str]) -> list[str]:
        vault = settings.vault_path
        if not vault or not os.path.isdir(vault):
            return []

        related = []
        note_basename = os.path.basename(file_path)

        for root, _, files in os.walk(vault):
            if ".obsidian" in root or ".trash" in root:
                continue
            for fname in files:
                if not fname.endswith(".md") or fname == note_basename:
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        fcontent = f.read()
                except Exception:
                    continue
                has_tag = any(tag.lower() in fcontent.lower() for tag in tags)
                if has_tag:
                    related.append(os.path.relpath(fpath, vault))
                if len(related) >= 10:
                    break

        return related


context_builder = ContextBuilder()
