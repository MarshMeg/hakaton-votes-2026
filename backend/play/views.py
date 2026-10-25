# страницы одинаковы для всех игроков, имя и статистику подставляет js из локального хранилища
# поэтому их можно положить в офлайн-снимок (см. build_bundle.py)

import re

from django.conf import settings
from django.core.exceptions import SuspiciousFileOperation
from django.core.files.storage import default_storage
from django.http import FileResponse, Http404
from django.shortcuts import render
from django.views.decorators.http import require_GET

from vocab.models import Fact, Topic

from .games import GAMES, GAMES_BY_SLUG
from .mime import guess_type


def home(request):
    return render(request, "play/home.html")


def games(request):
    return render(request, "play/games.html", {"games": GAMES})


def game(request, slug):
    item = GAMES_BY_SLUG.get(slug)
    if item is None:
        raise Http404
    return render(
        request,
        "play/game.html",
        {"game": item, "topics": Topic.objects.all(), "template": f"play/games/{slug}.html"},
    )


def profile(request):
    # с сервера берём только факты, остальное считает js
    return render(request, "play/profile.html", {"facts": Fact.objects.all()})


def settings_page(request):
    return render(request, "play/settings.html")


def report(request):
    return render(request, "play/report.html")


@require_GET
def media(request, path):
    # картинки и аудио из хранилища (папка или minio) отдаём со своего адреса
    try:
        exists = default_storage.exists(path)
    except SuspiciousFileOperation:  # путь вышел за папку медиа
        exists = False
    if not exists:
        raise Http404
    return FileResponse(default_storage.open(path), content_type=guess_type(path))


_SHA = re.compile(r"^[0-9a-f]{64}$")


@require_GET
def bundle_file(request, name):
    # отдаём только manifest.json и blobs/<sha256>, остальное из BUNDLE_DIR не раздаём
    if name != "manifest.json" and not (name.startswith("blobs/") and _SHA.fullmatch(name[6:])):
        raise Http404
    path = settings.BUNDLE_DIR / name
    if not path.is_file():
        raise Http404
    response = FileResponse(path.open("rb"))
    # манифест всегда свежий, а блобы не меняются, потому что имя - хэш содержимого
    response["Cache-Control"] = (
        "no-cache" if name == "manifest.json" else "public, max-age=31536000, immutable"
    )
    return response
