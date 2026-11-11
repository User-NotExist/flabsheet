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

    # --- sessions / auth ---
    session_cookie_name: str = "flabsheet_session"
    session_ttl_days: int = 7
    # None = derive from frontend_url (Secure only when the site is served over https)
    session_cookie_secure: bool | None = None
    # Failed logins allowed per login id, and separately per client IP, inside
    # the window before 429
    login_rate_limit_attempts: int = 10
    login_rate_limit_window_seconds: int = 900

    @property
    def cookie_secure(self) -> bool:
        if self.session_cookie_secure is not None:
            return self.session_cookie_secure
        return self.frontend_url.startswith("https://")


@lru_cache
def get_settings() -> Settings:
    return Settings() # type: ignore


settings = get_settings()
