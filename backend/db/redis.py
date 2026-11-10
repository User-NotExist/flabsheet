import redis

from config import settings

# Sync client to match the sync SQLAlchemy stack; redis-py pools connections
# and is safe to share across FastAPI's worker threads.
redis_client = redis.Redis.from_url(
    settings.redis_url,
    decode_responses=True,
    socket_connect_timeout=2,
    socket_timeout=2,
)


def get_redis() -> redis.Redis:
    return redis_client
