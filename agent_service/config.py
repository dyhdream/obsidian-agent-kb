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

    max_context_notes: int = 5
    max_note_chars: int = 3000

    embedding_provider: str = "deepseek"

    log_level: str = "INFO"
    reload: bool = False  # 开发模式，生产请设为 false

    # DeepSeek v4 Flash 定价 (RMB / 百万 tokens)
    price_prompt_per_million: float = 0.27
    price_completion_per_million: float = 1.10

    usage_db_path: str = "./usage.db"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
