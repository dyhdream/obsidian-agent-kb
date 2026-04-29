import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    deepseek_model: str = "deepseek-v4-flash"

    agent_host: str = "127.0.0.1"
    agent_port: int = 9527

    vault_path: str = ""
    data_db_path: str = "./data"

    # 上下文
    max_context_notes: int = 5
    max_note_chars: int = 3000

    # Agent LLM 调用参数
    agent_temperature: float = 0.3
    agent_max_tokens: int = 2048
    agent_max_retries: int = 2
    agent_api_timeout: int = 60

    # 会话管理
    session_ttl_seconds: int = 300  # result_store 过期时间
    session_cleanup_interval: int = 60  # 清理检查间隔

    # Vault 索引
    vault_mtime_tolerance: float = 0.5  # 修改时间容差(秒)
    frontmatter_parse_lines: int = 30  # 前端解析行数

    log_level: str = "INFO"
    reload: bool = False

    # DeepSeek v4 Flash 定价 (RMB / 百万 tokens)
    price_prompt_per_million: float = 0.27
    price_completion_per_million: float = 1.10

    usage_db_path: str = "./usage.db"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
