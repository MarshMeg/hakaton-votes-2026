"""Офлайн-снимок приложения: страницы, статика, словарь и медиа."""

# телефон отвечает на запросы webview из снимка, а на сервере он лежит в BUNDLE_DIR (/bundle/)
# по версии в манифесте телефон узнаёт об обновлении и докачивает только изменившиеся файлы
# manifest.json: {"version": "...", "built": мс, "files": {"/learn/": {"sha", "type", "size"}}}
# blobs/<sha256>: содержимое файлов, одинаковые файлы хранятся один раз

import hashlib
import json
import shutil
import time
from pathlib import Path

from django.conf import settings
from django.contrib.staticfiles import finders
from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand, CommandError
from django.test import Client, override_settings
from django.urls import reverse

from play.games import GAMES
from play.mime import guess_type
from vocab.models import Topic, Word, media_url

# статика, которая не нужна на телефоне
SKIP_STATIC_PREFIXES = ("admin/", "css/input.css")
SKIP_STATIC_SUFFIXES = (".gz", ".br")
VERSION_LENGTH = 16
KEEP_IN_BLOBS = ".gitkeep"  # чтобы git хранил пустую папку blobs


def page_urls() -> list[str]:
    # новый экран надо добавить сюда, иначе офлайн его не будет
    urls = [
        reverse("play:home"),
        reverse("vocab:topics"),
        reverse("vocab:content"),
        reverse("play:games"),
        reverse("play:profile"),
        reverse("play:settings"),
        reverse("play:report"),
    ]
    urls += [
        reverse("vocab:topic", args=[slug]) for slug in Topic.objects.values_list("slug", flat=True)
    ]
    urls += [reverse("play:game", args=[g.slug]) for g in GAMES]
    return urls


def static_files():
    # в проде шаблоны ссылаются на файлы с хэшем в имени, их берём из collectstatic
    # иначе берём исходники
    prefix = "/" + settings.STATIC_URL.strip("/") + "/"
    manifest = Path(settings.STATIC_ROOT) / "staticfiles.json"
    if manifest.exists() and not settings.DEBUG:
        files = _collected_static(manifest)
    else:
        files = _source_static()
    for rel, path in files:
        yield prefix + rel, path


def _collected_static(manifest: Path):
    static_root = manifest.parent
    paths = json.loads(manifest.read_text(encoding="utf-8"))["paths"]
    for rel, hashed in sorted(paths.items()):
        if _wanted(rel):
            yield hashed, static_root / hashed


def _source_static():
    # один файл могут найти несколько finder, берём первый
    seen = set()
    for finder in finders.get_finders():
        for rel, storage in finder.list([]):
            rel = rel.replace("\\", "/")
            if rel in seen or not _wanted(rel):
                continue
            seen.add(rel)
            yield rel, Path(storage.path(rel))


def _wanted(rel: str) -> bool:
    # пропускаем статику админки, исходник tailwind и сжатые копии whitenoise
    return not rel.startswith(SKIP_STATIC_PREFIXES) and not rel.endswith(SKIP_STATIC_SUFFIXES)


def pages():
    client = Client()
    for url in page_urls():
        # ALLOWED_HOSTS для тестового клиента может не подойти
        with override_settings(ALLOWED_HOSTS=["*"]):
            response = client.get(url)
        if response.status_code != 200:
            raise CommandError(f"{url}: HTTP {response.status_code}")
        yield url, response.content, response["Content-Type"]


def media_files():
    for word in Word.objects.all():
        for field in (word.image, word.audio):
            if field and default_storage.exists(field.name):
                with default_storage.open(field.name) as fh:
                    yield media_url(field), fh.read(), guess_type(field.name)


def bundle_version(files: dict[str, dict]) -> str:
    # версия меняется, только если поменялся какой-то файл
    lines = "\n".join(f"{url} {files[url]['sha']}" for url in sorted(files))
    return hashlib.sha256(lines.encode()).hexdigest()[:VERSION_LENGTH]


def remove_unused_blobs(blobs: Path, files: dict[str, dict]):
    used = {f["sha"] for f in files.values()}
    for blob in blobs.iterdir():
        if blob.name not in used and blob.name != KEEP_IN_BLOBS:
            blob.unlink()


def write_manifest(out: Path, manifest: dict):
    # через .tmp, чтобы сервер не отдал недописанный манифест
    tmp = out / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    shutil.move(tmp, out / "manifest.json")


class Command(BaseCommand):
    help = "Собирает офлайн-снимок приложения (страницы, статика, словарь, медиа)."

    def add_arguments(self, parser):
        parser.add_argument("--out", default=str(settings.BUNDLE_DIR), help="папка снимка")

    def handle(self, *args, **opts):
        out = Path(opts["out"])
        blobs = out / "blobs"
        blobs.mkdir(parents=True, exist_ok=True)
        files: dict[str, dict] = {}

        # кладёт файл в blobs, если его там ещё нет, и запоминает url
        def add(url: str, data: bytes, content_type: str):
            sha = hashlib.sha256(data).hexdigest()
            blob = blobs / sha
            if not blob.exists():
                blob.write_bytes(data)
            files[url] = {"sha": sha, "type": content_type, "size": len(data)}

        for url, data, content_type in pages():
            add(url, data, content_type)
        for url, path in static_files():
            add(url, path.read_bytes(), guess_type(path.name))
        for url, data, content_type in media_files():
            add(url, data, content_type)

        version = bundle_version(files)
        # по built приложение выбирает самый новый снимок
        manifest = {
            "version": version,
            "built": int(time.time() * 1000),
            "files": dict(sorted(files.items())),
        }
        # манифест пишем последним, пока идёт сборка сервер отдаёт старую целую версию
        remove_unused_blobs(blobs, files)
        write_manifest(out, manifest)

        size = sum(f["size"] for f in files.values()) / 1024 / 1024
        self.stdout.write(
            self.style.SUCCESS(f"Снимок {version}: {len(files)} файлов, {size:.1f} МБ → {out}")
        )
