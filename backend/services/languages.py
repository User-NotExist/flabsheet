"""The languages problems may allow: a copy of the judge's language registry.

The judge owns the registry (``judge-worker-go``'s ``languages.yaml``); the ids
and ``source_name`` values here must match it, because build and judge jobs
name the language by id and the source file by ``source_name``. Add a language
there first, then here.

    from services.languages import LANGUAGES

    LANGUAGES["py312"].source_name   # "main.py"
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    id: str
    display: str
    source_name: str  # name the judge saves the primary source file as


LANGUAGES: dict[str, Language] = {
    lang.id: lang
    for lang in (
        Language("cpp20-gcc13", "C++20 (g++ 13)", "main.cpp"),
        Language("py312", "Python 3.12", "main.py"),
    )
}
