from config import settings
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from db.postgres import Base, engine
from sqlalchemy import text

import db.models.user
import db.models.operation_log
import db.models.student_import
import db.models.problem
import db.models.submission
import db.models.instance_settings
from routers import auth, images, internal, problems, students
from services.errors import ApiError, api_error_handler
from services.storage import StorageError, storage_error_handler

app = FastAPI()
app.add_exception_handler(ApiError, api_error_handler)
app.add_exception_handler(StorageError, storage_error_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

with engine.begin() as conn:
    conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))

Base.metadata.create_all(engine)

app.include_router(auth.router)
app.include_router(students.router)
app.include_router(problems.router)
app.include_router(images.router)
app.include_router(internal.router)


@app.get("/healthz", include_in_schema=False)
def healthz():
    """Liveness probe for the Docker HEALTHCHECK. Does not touch Postgres or Redis."""
    return {"status": "ok"}
