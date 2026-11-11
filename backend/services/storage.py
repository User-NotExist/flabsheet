"""Object storage (RustFS through the S3 API): uploads, reads and presigned URLs.

Two buckets, ``ASSETS`` (statement images) and ``PROBLEMS`` (test data,
reference solutions, packages, answers); keys are listed in
``docs/data-and-storage.md``. Objects are written once and never overwritten.

Every failure is raised as :class:`StorageError`, which ``main.py`` turns into
a 503, so callers only catch it when they have something better to do.

    from services import storage

    storage.put_bytes(storage.PROBLEMS, "testdata/ab12.in", data, "application/octet-stream")
    size = storage.size(storage.PROBLEMS, "testdata/ab12.in")   # None when missing
    url = storage.presign_get(storage.PROBLEMS, "reference/7/main.cpp")
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any, BinaryIO, Iterator, Optional

import boto3
from fastapi import Request
from fastapi.responses import JSONResponse
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from config import settings

logger = logging.getLogger(__name__)

ASSETS = settings.s3_bucket_assets
PROBLEMS = settings.s3_bucket_problems

# The judge asks for fresh URLs (job refresh) once a job is 25 minutes old
PRESIGN_TTL_SECONDS = 30 * 60


class StorageError(Exception):
    """Object storage could not be reached or refused the request."""


def storage_error_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error("storage error on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(
        {"detail": "File storage is unavailable. Please try again."},
        status_code=503,
    )


def _make_client(endpoint_url: str) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},  # RustFS has no per-bucket host names
            connect_timeout=3,
            read_timeout=30,
            retries={"max_attempts": 2},
            # Newer botocore adds CRC trailers to every upload by default,
            # which S3-compatible servers may reject.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


# boto3 clients are thread-safe, so one of each is shared by all handler threads.
@lru_cache
def _client() -> Any:
    return _make_client(settings.s3_endpoint_url)


# Presigning is local arithmetic, but the signature covers the host name, so
# URLs for the judge are signed for the address the judge uses.
@lru_cache
def _presign_client() -> Any:
    return _make_client(settings.s3_public_endpoint_url or settings.s3_endpoint_url)


def _is_missing(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound")


def put_bytes(bucket: str, key: str, data: bytes, content_type: str) -> None:
    try:
        _client().put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
    except (BotoCoreError, ClientError) as exc:
        raise StorageError(f"put {bucket}/{key} failed") from exc


def put_file(bucket: str, key: str, fileobj: BinaryIO, content_type: str) -> None:
    """Upload a seekable file (multipart for large ones) from its current position."""
    try:
        _client().upload_fileobj(
            fileobj, bucket, key, ExtraArgs={"ContentType": content_type}
        )
    except (BotoCoreError, ClientError) as exc:
        raise StorageError(f"put {bucket}/{key} failed") from exc


def size(bucket: str, key: str) -> Optional[int]:
    """Size of the object in bytes, or None when it does not exist."""
    try:
        return int(_client().head_object(Bucket=bucket, Key=key)["ContentLength"])
    except ClientError as exc:
        if _is_missing(exc):
            return None
        raise StorageError(f"head {bucket}/{key} failed") from exc
    except BotoCoreError as exc:
        raise StorageError(f"head {bucket}/{key} failed") from exc


def get_bytes(bucket: str, key: str, limit: Optional[int] = None) -> bytes:
    """The whole object, or only its first ``limit`` bytes.

    Do not pass ``limit`` for an empty object: S3 answers a range request on
    zero bytes with an error.
    """
    extra = {"Range": f"bytes=0-{limit - 1}"} if limit else {}
    try:
        return _client().get_object(Bucket=bucket, Key=key, **extra)["Body"].read()
    except (BotoCoreError, ClientError) as exc:
        raise StorageError(f"get {bucket}/{key} failed") from exc


def stream(bucket: str, key: str) -> Iterator[bytes]:
    """Chunks of the object, for streaming it to a client without buffering."""
    try:
        body = _client().get_object(Bucket=bucket, Key=key)["Body"]
    except (BotoCoreError, ClientError) as exc:
        raise StorageError(f"get {bucket}/{key} failed") from exc
    return body.iter_chunks(64 * 1024)


def presign_get(bucket: str, key: str) -> str:
    return _presign("get_object", bucket, key)


def presign_put(bucket: str, key: str) -> str:
    return _presign("put_object", bucket, key)


def _presign(operation: str, bucket: str, key: str) -> str:
    try:
        return _presign_client().generate_presigned_url(
            operation,
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=PRESIGN_TTL_SECONDS,
        )
    except (BotoCoreError, ClientError) as exc:
        raise StorageError(f"presign {bucket}/{key} failed") from exc
