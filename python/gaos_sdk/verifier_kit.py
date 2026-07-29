"""RFC-016 verifier-kit manifest and replay-reference inspection."""

from __future__ import annotations

import hashlib
import json
import re
import tarfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
from typing import Any

VERIFIER_KIT_SCHEMA = "gaos.verifier-kit.v1"
VERIFIER_REFERENCE_SCHEMA = "gaos.verifier-reference.v1"
VERIFIER_KIT_MEDIA_TYPE = "application/vnd.gaos.verifier-kit.v1+tar"
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_MAX_BYTES = 64 * 1024 * 1024
_MAX_FILES = 512


@dataclass(frozen=True)
class InspectedVerifierKit:
    """Read-only facts from a validated verifier-kit archive."""

    digest: str
    manifest: dict[str, Any]


def _identity(value: Any, label: str, *, adapter: bool = False) -> None:
    expected = {"id", "version", *(("entrypoint",) if adapter else ())}
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} has unknown or missing properties")
    if not all(isinstance(value[field], str) and value[field] for field in ("id", "version")):
        raise ValueError(f"{label} id and version must be non-empty strings")
    if adapter and value["entrypoint"] != "adapter.bundle.mjs":
        raise ValueError("manifest.adapter.entrypoint must be adapter.bundle.mjs")


def _safe_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value or value.startswith("/"):
        raise ValueError("verifier-kit paths must be normalized relative POSIX paths")
    path = PurePosixPath(value)
    if str(path) != value or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("verifier-kit paths must not traverse outside the kit")
    if len(value.encode()) > 100:
        raise ValueError("verifier-kit paths must not exceed 100 bytes")
    return value


def parse_verifier_kit_manifest(value: Any) -> dict[str, Any]:
    """Validate and return a detached ``gaos.verifier-kit.v1`` manifest."""

    required = {"schema", "game", "adapter", "runtime", "replayFormats", "files"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("verifier manifest has unknown or missing properties")
    if value["schema"] != VERIFIER_KIT_SCHEMA:
        raise ValueError(f"verifier manifest schema must be {VERIFIER_KIT_SCHEMA}")
    _identity(value["game"], "manifest.game")
    _identity(value["adapter"], "manifest.adapter", adapter=True)
    runtime = value["runtime"]
    if not isinstance(runtime, dict) or set(runtime) != {"kind", "gaosVersion", "nodeRange"}:
        raise ValueError("manifest.runtime has unknown or missing properties")
    if runtime["kind"] != "node-esm" or not all(
        isinstance(runtime[field], str) and runtime[field]
        for field in ("gaosVersion", "nodeRange")
    ):
        raise ValueError("manifest.runtime is invalid")
    formats = value["replayFormats"]
    if (
        not isinstance(formats, list)
        or not formats
        or not all(isinstance(item, str) and item for item in formats)
        or len(set(formats)) != len(formats)
    ):
        raise ValueError("manifest.replayFormats must be a unique non-empty string array")
    files = value["files"]
    if not isinstance(files, list) or not files:
        raise ValueError("manifest.files must be a non-empty array")
    paths: list[str] = []
    for index, file in enumerate(files):
        if not isinstance(file, dict) or set(file) != {"path", "size", "digest"}:
            raise ValueError(f"manifest.files[{index}] has unknown or missing properties")
        path = _safe_path(file["path"])
        if path == "verifier-manifest.json":
            raise ValueError("manifest.files must not include its own manifest")
        if (
            isinstance(file["size"], bool)
            or not isinstance(file["size"], int)
            or file["size"] < 0
        ):
            raise ValueError(f"manifest.files[{index}].size is invalid")
        if not isinstance(file["digest"], str) or not _DIGEST.fullmatch(file["digest"]):
            raise ValueError(f"manifest.files[{index}].digest is invalid")
        paths.append(path)
    if paths != sorted(set(paths)) or "adapter.bundle.mjs" not in paths:
        raise ValueError("manifest.files paths must be ordered, unique, and include adapter.bundle.mjs")
    return json.loads(json.dumps(value))


def parse_verifier_reference(value: Any) -> dict[str, Any]:
    """Validate and return a detached ``gaos.verifier-reference.v1`` object."""

    required = {"schema", "digest", "mediaType", "size", "mirrors"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("verifier reference has unknown or missing properties")
    if value["schema"] != VERIFIER_REFERENCE_SCHEMA:
        raise ValueError(f"verifier reference schema must be {VERIFIER_REFERENCE_SCHEMA}")
    if not isinstance(value["digest"], str) or not _DIGEST.fullmatch(value["digest"]):
        raise ValueError("verifier reference digest is invalid")
    if value["mediaType"] != VERIFIER_KIT_MEDIA_TYPE:
        raise ValueError(f"verifier reference mediaType must be {VERIFIER_KIT_MEDIA_TYPE}")
    if (
        isinstance(value["size"], bool)
        or not isinstance(value["size"], int)
        or value["size"] < 0
    ):
        raise ValueError("verifier reference size is invalid")
    if not isinstance(value["mirrors"], list) or not all(
        isinstance(item, str) and item for item in value["mirrors"]
    ):
        raise ValueError("verifier reference mirrors must be a string array")
    return json.loads(json.dumps(value))


def verifier_reference_from_replay(artifact: Any) -> dict[str, Any] | None:
    """Read the optional namespaced verifier reference from a decoded replay."""

    if not isinstance(artifact, dict):
        raise ValueError("replay artifact must be an object")
    extensions = artifact.get("header", {}).get("extensions", {})
    if not isinstance(extensions, dict) or "gaos.verifier" not in extensions:
        return None
    return parse_verifier_reference(extensions["gaos.verifier"])


def inspect_verifier_kit(data: bytes) -> InspectedVerifierKit:
    """Inspect a canonical regular-file-only kit without extracting or executing it."""

    if len(data) > _MAX_BYTES:
        raise ValueError("verifier kit exceeds size limit")
    if len(data) < 1024 or len(data) % 512:
        raise ValueError("malformed verifier-kit tar length")
    files: dict[str, bytes] = {}
    try:
        with tarfile.open(fileobj=BytesIO(data), mode="r:") as archive:
            members = archive.getmembers()
            if len(members) > _MAX_FILES:
                raise ValueError("verifier kit exceeds file limit")
            paths = [_safe_path(member.name) for member in members]
            if paths != sorted(set(paths)):
                raise ValueError("verifier-kit entries must be unique and lexically ordered")
            for member in members:
                if not member.isfile() or member.issym() or member.islnk():
                    raise ValueError("verifier kit may contain regular files only")
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError(f"unable to inspect {member.name}")
                files[member.name] = source.read()
    except tarfile.TarError as error:
        raise ValueError(f"invalid verifier-kit tar: {error}") from error
    try:
        manifest = parse_verifier_kit_manifest(
            json.loads(files.pop("verifier-manifest.json").decode())
        )
    except KeyError as error:
        raise ValueError("verifier kit is missing verifier-manifest.json") from error
    if set(files) != {entry["path"] for entry in manifest["files"]}:
        raise ValueError("verifier manifest does not describe every kit file")
    for expected in manifest["files"]:
        contents = files[expected["path"]]
        digest = "sha256:" + hashlib.sha256(contents).hexdigest()
        if len(contents) != expected["size"] or digest != expected["digest"]:
            raise ValueError(f"verifier-kit integrity mismatch for {expected['path']}")
    return InspectedVerifierKit(
        digest="sha256:" + hashlib.sha256(data).hexdigest(),
        manifest=manifest,
    )
