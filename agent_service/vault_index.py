"""
VaultIndex — SQLite 索引库
只存标题/目录/标签/别名/修改时间，不读文件正文。
首次加载时全量扫描，之后增量更新（对比 mtime）。
"""

import os
import sqlite3
import yaml
import re
from .config import settings


class VaultIndex:
    def __init__(self):
        self.vault = settings.vault_path
        self.db_path = os.path.join(settings.chroma_db_path, "vault_index.db")
        os.makedirs(settings.chroma_db_path, exist_ok=True)
        self._init_db()
        self._sync()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS notes_index (
                    title TEXT NOT NULL,
                    path TEXT PRIMARY KEY,
                    dir TEXT,
                    tags TEXT,
                    aliases TEXT,
                    mtime REAL,
                    size INTEGER,
                    indexed_at REAL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_dir ON notes_index(dir)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tags ON notes_index(tags)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_title ON notes_index(title)")
            conn.commit()

    # ── 全量 / 增量同步 ──

    def _sync(self):
        if not self.vault or not os.path.isdir(self.vault):
            return

        known = self._get_known_paths()

        for root, dirs, files in os.walk(self.vault):
            dirs[:] = [d for d in dirs if d not in (".obsidian", ".trash", ".git")]
            for fname in files:
                if not fname.endswith(".md"):
                    continue
                fpath = os.path.join(root, fname)
                rel = os.path.relpath(fpath, self.vault).replace("\\", "/")
                mtime = os.path.getmtime(fpath)
                size = os.path.getsize(fpath)

                existing = known.get(rel)
                # 只有新文件或修改时间变化才读
                if existing and abs(existing["mtime"] - mtime) < 0.5:
                    continue

                title, tags, aliases = self._parse_frontmatter(fpath, fname)
                directory = os.path.dirname(rel) or "."

                self._upsert(rel, title, directory, tags, aliases, mtime, size)
                known.pop(rel, None)

        # 删除已不存在的文件
        for removed_path in known:
            self._delete(removed_path)

        self._on_change()

    def _on_change(self):
        with sqlite3.connect(self.db_path) as conn:
            self.total = conn.execute("SELECT COUNT(*) FROM notes_index").fetchone()[0]

    # ── 解析 frontmatter（只读前 30 行） ──

    def _parse_frontmatter(self, fpath: str, fname: str) -> tuple[str, list[str], list[str]]:
        title = os.path.splitext(fname)[0]
        tags = []
        aliases = []

        try:
            with open(fpath, "r", encoding="utf-8") as f:
                first_line = f.readline()
                if first_line.strip() == "---":
                    lines = []
                    for _ in range(30):
                        line = f.readline()
                        if not line or line.strip() == "---":
                            break
                        lines.append(line)
                    if lines:
                        try:
                            fm = yaml.safe_load("\n".join(lines))
                            if isinstance(fm, dict):
                                title = fm.get("title", title)
                                tags = fm.get("tags", [])
                                aliases = fm.get("aliases", [])
                        except yaml.YAMLError:
                            pass
        except Exception:
            pass

        if isinstance(tags, str):
            tags = [tags]
        tags = [str(t).strip().lower() for t in tags if t] if tags else []

        if isinstance(aliases, str):
            aliases = [aliases]
        elif aliases is None:
            aliases = []

        # 从文件名推断标签（如 Redis.md → #redis）
        name_tag = os.path.splitext(fname)[0].strip().lower()
        if name_tag and name_tag not in tags:
            tags.insert(0, name_tag)

        return title, tags, aliases

    # ── CRUD ──

    def _upsert(self, path: str, title: str, directory: str,
                 tags: list[str], aliases: list[str], mtime: float, size: int):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO notes_index (title, path, dir, tags, aliases, mtime, size, indexed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                title, path, directory,
                ",".join(sorted(set(tags))) if tags else "",
                ",".join(str(a) for a in aliases) if aliases else "",
                mtime, size, mtime,
            ))
            conn.commit()

    def _delete(self, path: str):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM notes_index WHERE path = ?", (path,))
            conn.commit()

    def _get_known_paths(self) -> dict[str, dict]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT path, mtime FROM notes_index").fetchall()
        return {r[0]: {"mtime": r[1]} for r in rows}

    # ── 查询（核心 — 不读文件） ──

    def same_dir(self, file_path: str, limit: int = 20) -> list[dict]:
        directory = os.path.dirname(file_path.replace("\\", "/")) or "."
        current = os.path.basename(file_path)
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT title, path, dir, tags FROM notes_index WHERE dir = ? AND path != ? LIMIT ?",
                (directory, file_path, limit),
            ).fetchall()
        return [{"title": r[0], "path": r[1], "dir": r[2], "tags": r[3].split(",") if r[3] else []} for r in rows]

    def search_title(self, query: str, limit: int = 5) -> list[dict]:
        words = [w.strip() for w in query.split() if len(w.strip()) > 1]
        if not words:
            return []

        clauses = " OR ".join(["title LIKE ?" for _ in words])
        params = [f"%{w}%" for w in words]
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                f"SELECT title, path, dir, tags FROM notes_index WHERE {clauses} LIMIT ?",
                params + [limit],
            ).fetchall()
        return [{"title": r[0], "path": r[1], "dir": r[2], "tags": r[3].split(",") if r[3] else []} for r in rows]

    def all_titles(self) -> list[dict]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT title, path, dir, tags FROM notes_index ORDER BY title"
            ).fetchall()
        return [{"title": r[0], "path": r[1], "dir": r[2], "tags": r[3].split(",") if r[3] else []} for r in rows]

    def count(self) -> int:
        return getattr(self, "total", 0)

    def get_tags_for_note(self, file_path: str) -> list[str]:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT tags FROM notes_index WHERE path = ?", (file_path,)
            ).fetchone()
        if row and row[0]:
            return row[0].split(",")
        return []


vault_index = VaultIndex()
