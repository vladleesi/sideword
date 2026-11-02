"""Server configuration from environment variables."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SIDEWORD_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    secret_key: str = Field(
        default="dev-insecure-secret-change-me",
        min_length=32,
        description="Secret for signing JWTs and admin sessions.",
    )
    public_url: str = Field(
        default="http://localhost:8000",
        description="Public server URL (used when generating invite links).",
    )

    db_path: str = Field(
        default="./data/sideword.sqlite3",
        description="SQLite database file path.",
    )
    exports_dir: str = Field(
        default="./exports",
        description="Directory for JSON configuration exports.",
    )

    admin_session_ttl_hours: int = Field(default=12, ge=1)
    message_ttl_days: int = Field(default=7, ge=1, le=30)
    max_ciphertext_bytes: int = Field(default=2 * 1024 * 1024, ge=128, le=2 * 1024 * 1024)
    send_idempotency_days: int = Field(default=30, ge=1, le=365)
    max_users: int = Field(default=10000, ge=1)
    max_send_records: int = Field(default=100000, ge=1)
    max_pending_messages: int = Field(default=10000, ge=1)
    max_pending_bytes: int = Field(default=256 * 1024 * 1024, ge=1024)
    max_pending_per_sender: int = Field(default=1000, ge=1)
    max_pending_bytes_per_sender: int = Field(default=16 * 1024 * 1024, ge=1024)
    sends_per_minute: int = Field(default=60, ge=1)
    max_read_receipts: int = Field(default=10000, ge=1)
    max_pending_per_chat: int = Field(default=2000, ge=1)
    max_pending_bytes_per_chat: int = Field(default=32 * 1024 * 1024, ge=1024)
    max_send_request_bytes: int = Field(
        default=10 * 1024 * 1024, ge=1024, le=10 * 1024 * 1024,
    )
    max_http_concurrency: int = Field(default=4, ge=1)
    max_request_bytes: int = Field(default=2 * 1024 * 1024, ge=1024)
    max_ws_connections: int = Field(default=256, ge=1)
    max_ws_per_user: int = Field(default=4, ge=1)
    presence_enabled: bool = True
    requests_per_minute: int = Field(default=600, ge=1)
    login_attempts_per_minute: int = Field(default=10, ge=1)
    require_https: bool = True
    private_admin: bool = True
    trusted_proxy_ips: str = "127.0.0.1"
    client_access_minutes: int = Field(default=15, ge=1, le=60)
    client_session_days: int = Field(default=30, ge=1, le=365)
    refresh_retry_seconds: int = Field(default=30, ge=1, le=120)
    # Optional isolated preview service; previews stay unavailable unless both are set.
    link_preview_service_url: str | None = None
    link_preview_token: str | None = Field(default=None, min_length=32)
    link_previews_per_minute: int = Field(default=30, ge=1, le=120)
    link_preview_concurrency: int = Field(default=4, ge=1, le=8)

    admin_username: str | None = Field(default=None)
    admin_password: str | None = Field(default=None)

    @field_validator("trusted_proxy_ips")
    @classmethod
    def _trusted_proxies(cls, value: str) -> str:
        from ipaddress import ip_address
        for address in value.split(","):
            ip_address(address.strip())
        return value

    @field_validator("link_preview_service_url")
    @classmethod
    def _preview_service_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        from urllib.parse import urlsplit
        parts = urlsplit(value)
        if (parts.scheme != "http" or not parts.hostname or parts.username or parts.password
                or parts.path not in ("", "/") or parts.query or parts.fragment
                or parts.port is None):
            raise ValueError("SIDEWORD_LINK_PREVIEW_SERVICE_URL must be http://host:port")
        return value.rstrip("/")

    @property
    def link_previews_enabled(self) -> bool:
        return bool(self.link_preview_service_url and self.link_preview_token)

    @field_validator("secret_key")
    @classmethod
    def _reject_placeholder_secret(cls, value: str) -> str:
        insecure_values = {
            "dev-insecure-secret-change-me",
            "change-me-please-use-long-random-string",
            "replace-this-with-output-from-the-command-above",
        }
        if value in insecure_values:
            raise ValueError(
                "SIDEWORD_SECRET_KEY must be replaced with a random secret"
            )
        return value

    @model_validator(mode="after")
    def _link_preview_pair(self) -> "Settings":
        # A token alone leaves previews off; a service URL without a token is a misconfiguration.
        if self.link_preview_service_url and not self.link_preview_token:
            raise ValueError(
                "SIDEWORD_LINK_PREVIEW_SERVICE_URL requires SIDEWORD_LINK_PREVIEW_TOKEN")
        return self

    @model_validator(mode="after")
    def _reject_placeholder_admin_password(self) -> "Settings":
        if self.admin_username and self.admin_password == "change-me-too":
            raise ValueError(
                "SIDEWORD_ADMIN_PASSWORD must be replaced before creating an admin"
            )
        return self

    @property
    def db_url(self) -> str:
        path = Path(self.db_path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite+aiosqlite:///{path.as_posix()}"

    @property
    def exports_path(self) -> Path:
        path = Path(self.exports_dir).resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path


@lru_cache
def get_settings() -> Settings:
    return Settings()
