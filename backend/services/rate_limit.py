"""Rate limits backed by Redis: failed logins, submissions and clarifications.

Failed logins
-------------

Only failures count, and they are counted twice: once per login id and once
per client IP. When the login id counter reaches ``login_rate_limit_attempts``
or the IP counter reaches ``login_rate_limit_ip_attempts`` within
``login_rate_limit_window_seconds``, further attempts are rejected until that
window expires. Two separate counters are needed because a single
(login id, IP) counter is bypassed by guessing one account from many IPs, or
many accounts from one IP.

The IP limit is much higher than the login id limit: a whole classroom behind
one NAT shares the IP counter, and it only has to slow down guessing across
many accounts, while each account keeps its own strict limit.

A successful login clears only the login id counter. The IP counter is left to
expire, otherwise an attacker could reset it by signing in to an account of
their own between guesses.

If Redis is unreachable the limiter fails open (logins keep working,
unthrottled) and logs a warning.

    retry_after = login_retry_after(login_id, client_ip)   # 0 = allowed
    ...
    record_login_failure(login_id, client_ip)               # on a bad attempt
    clear_login_failures(login_id)                          # on success

Submissions
-----------
One submission per user every ``SUBMIT_INTERVAL_SECONDS`` (FR-STD-06). The
check and the claim are one ``SET NX``, so two requests at the same moment
cannot both pass. It fails open like the login limiter.

    retry_after = submit_retry_after(user_id)               # 0 = allowed, slot taken

Clarifications
--------------
One new question per ``QUESTION_INTERVAL_SECONDS`` and one reply per
``REPLY_INTERVAL_SECONDS`` per user, the same ``SET NX`` slot as submissions,
failing open the same way. Staff are limited too: the reply interval is short
enough for working through the queue and still stops a script.

    retry_after = question_retry_after(user_id)
    retry_after = reply_retry_after(user_id)
"""

from __future__ import annotations

import logging

import redis

from config import settings
from db.redis import redis_client

logger = logging.getLogger(__name__)

SUBMIT_INTERVAL_SECONDS = 10  # FR-STD-06
QUESTION_INTERVAL_SECONDS = 30  # a question takes longer than that to write
REPLY_INTERVAL_SECONDS = 5  # a conversation, not a flood


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

    # Same order as _keys(): login id, then IP
    limits = (settings.login_rate_limit_attempts, settings.login_rate_limit_ip_attempts)
    retry_after = 0
    for count, ttl, limit in zip(results[0::2], results[1::2], limits):
        if count is not None and int(count) >= limit:
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


def _claim_slot(key: str, seconds: int, what: str) -> int:
    """Claim ``key`` for ``seconds``. Returns 0 when claimed, else the seconds to wait."""
    try:
        if redis_client.set(key, "1", nx=True, ex=seconds):
            return 0
        return max(int(redis_client.ttl(key)), 1)
    except redis.RedisError:
        logger.warning("%s rate limit check failed; allowing it", what, exc_info=True)
        return 0


def submit_retry_after(user_id: int) -> int:
    """Claim the user's submit slot. Returns 0 when claimed, else the seconds to wait."""
    return _claim_slot(f"rl:submit:{user_id}", SUBMIT_INTERVAL_SECONDS, "submit")


def question_retry_after(user_id: int) -> int:
    """Claim the user's slot for a new question or announcement."""
    return _claim_slot(f"rl:question:{user_id}", QUESTION_INTERVAL_SECONDS, "question")


def reply_retry_after(user_id: int) -> int:
    """Claim the user's slot for a new reply."""
    return _claim_slot(f"rl:reply:{user_id}", REPLY_INTERVAL_SECONDS, "reply")
