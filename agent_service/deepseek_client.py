import httpx
from .config import settings
from .usage_tracker import usage_tracker


class DeepSeekClient:
    def __init__(self):
        self.api_key = settings.deepseek_api_key
        self.base_url = settings.deepseek_base_url.rstrip("/")
        self.model = settings.deepseek_model

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def chat(
        self,
        messages: list[dict],
        temperature: float = None,
        max_tokens: int = None,
    ) -> str:
        temp = temperature if temperature is not None else settings.agent_temperature
        mt = max_tokens if max_tokens is not None else settings.agent_max_tokens
        async with httpx.AsyncClient(timeout=settings.agent_api_timeout) as client:
            resp = await client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json={
                    "model": self.model,
                    "messages": messages,
                    "temperature": temp,
                    "max_tokens": mt,
                },
            )
            resp.raise_for_status()
            data = resp.json()

            usage = data.get("usage", {})
            prompt_tokens = usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("completion_tokens", 0)

            if prompt_tokens or completion_tokens:
                usage_tracker.record(
                    model=data.get("model", self.model),
                    endpoint="chat/completions",
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                )

            return data["choices"][0]["message"]["content"]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if settings.embedding_provider != "deepseek":
            raise NotImplementedError("只有 deepseek embedding 目前支持")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{self.base_url}/embeddings",
                headers=self._headers(),
                json={
                    "model": "deepseek-embed",
                    "input": texts,
                },
            )
            resp.raise_for_status()
            data = resp.json()

            usage = data.get("usage", {})
            prompt_tokens = usage.get("prompt_tokens", 0) if isinstance(usage, dict) else 0

            if prompt_tokens:
                usage_tracker.record(
                    model=data.get("model", "deepseek-embed"),
                    endpoint="embeddings",
                    prompt_tokens=prompt_tokens,
                    completion_tokens=0,
                )

            return [item["embedding"] for item in data["data"]]


client = DeepSeekClient()
