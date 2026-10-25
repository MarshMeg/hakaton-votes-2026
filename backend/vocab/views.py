from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render

from .content import build_content
from .models import Topic


def topics(request):
    # сколько слов выучено, дорисовывает alpine
    return render(request, "vocab/topics.html", {"topics": Topic.objects.all()})


def topic(request, slug):
    item = get_object_or_404(Topic, slug=slug)
    return render(request, "vocab/topic.html", {"topic": item, "words": item.words.all()})


def content_json(request):
    # ensure_ascii=False, чтобы удмуртские буквы не экранировались
    return JsonResponse(build_content(), json_dumps_params={"ensure_ascii": False})
