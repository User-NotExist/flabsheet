"""Failed-login rate limiting backed by Redis counters.

Only failures count, and they are counted twice: once per login id and once
per client IP. When either counter reaches ``login_rate_limit_attempts`` within
``login_rate_limit_window_seconds``, further attempts are rejected until that
window expires. Two separate counters are needed because a single
(login id, IP) counter is bypassed by guessing one account from many IPs, or
many accounts from one IP.

A successful login clears only the login id counter. The IP counter is left to
expire, otherwise an attacker could reset it by signing in to an account of
their own between guesses.

If Redis is unreachable the limiter fails open (logins keep working,
unthrottled) and logs a warning.

    retry_after = login_retry_after(login_id, client_ip)   # 0 = allowed
    ...
    record_login_failure(login_id, client_ip)               # on a bad attempt
    clear_login_failures(login_id)                          # on success
"""

from __future__ import annotations

import logging

import redis

from config import settings
from db.redis import redis_client

logger = logging.getLogger(__name__)


def _keys(login_id: str, client_ip: str) -> tuple[str, str]:
    # login ids are case-insensitive (CITEXT), so count "Alice" and "alice" together
    return f"login_fail:id:{login_id.lower()}", f"login_fail:ip:{client_ip}"


def login_retry_after(login_id: str, client_ip: str) -> int:
    """Seconds the caller must wait before trying again; 0 if not limited."""
    keys = _keys(login_id, client_ip)
    try:
        pipe = redis_client.pipeline()
        for key in keys:
            pipe.get(key)
            pipe.ttl(key)
        results = pipe.execute()
    except redis.RedisError:
        logger.warning("login rate limit check failed; allowing attempt", exc_info=True)
        return 0

    retry_after = 0
    for count, ttl in zip(results[0::2], results[1::2]):
        if count is not None and int(count) >= settings.login_rate_limit_attempts:
            # Wait for the longer window when both counters are over the limit
            retry_after = max(retry_after, ttl, 1)
    return retry_after


def record_login_failure(login_id: str, client_ip: str) -> None:
    try:
        pipe = redis_client.pipeline()
        for key in _keys(login_id, client_ip):
            pipe.incr(key)
            # NX: the window starts at the first failure and is not extended by later ones
            pipe.expire(key, settings.login_rate_limit_window_seconds, nx=True)
        pipe.execute()
    except redis.RedisError:
        logger.warning("recording login failure failed", exc_info=True)


def clear_login_failures(login_id: str) -> None:
    """Forget the failures of ``login_id`` after it signed in successfully."""
    try:
        redis_client.delete(f"login_fail:id:{login_id.lower()}")
    except redis.RedisError:
        logger.warning("clearing login failures failed", exc_info=True)
