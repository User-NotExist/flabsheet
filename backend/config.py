from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    postgres_url: str
    redis_url: str
    frontend_url: str = "http://localhost:3000"
    database_echo: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
