"""API аккаунта: регистрация, вход и сохранение прогресса."""

# сохранение - один json на аккаунт, формат такой:
# {"v": 2, "updated": 1760500000000,
#  "profile": {"name": "Аня", "avatar": "🦊"},
#  "words": {"17": {"ok": 3, "bad": 1, "seen": 2, "streak": 2, "last": 1760500000000}},
#  "days": {"2026-10-15": {"ok": 12, "bad": 3, "seen": 5}},
#  "games": {"choose": {"ok": 20, "bad": 4, "played": 3, "best": 3}},
#  "settings": {"sound": true, "notifications": false, "geo": false}}
# updated - время в мс по часам телефона, по нему выигрывает более новое сохранение
# если на сервере сохранение новее, на PUT отвечаем 409 и отдаём серверное
# авторизация по токену в заголовке Authorization: Bearer, поэтому csrf не нужен

import json
from functools import wraps

from django.contrib.auth import authenticate, get_user_model
from django.core import signing
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods, require_POST

from accounts.models import Profile

TOKEN_SALT = "votes.api"
SAVE_VERSION = 2
MAX_SAVE_BYTES = 256 * 1024
SAVE_SECTIONS = ("words", "days", "games")
SETTINGS_DEFAULTS = {"sound": True, "notifications": False, "geo": False}
USERNAME_MAX = 150  # как у поля username в модели User
PASSWORD_MIN = 6  # как в AUTH_PASSWORD_VALIDATORS
NAME_MAX = 60
AVATAR_MAX = 16  # эмодзи бывает из нескольких символов
MAX_UPDATED = 2**63 - 1  # больше не влезет в BigIntegerField
BEARER = "Bearer "


def make_token(user) -> str:
    # срока действия у токена нет, при чтении max_age не передаётся
    return signing.dumps(user.pk, salt=TOKEN_SALT)


def _error(message, status=400):
    return JsonResponse({"error": message}, status=status)


def _json_body(request):
    # None значит, что тело не json-объект, тогда отвечаем 400
    try:
        data = json.loads(request.body or b"{}")
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def client_ip(request) -> str:
    # в проде перед django стоит caddy, он кладёт адрес клиента в конец X-Forwarded-For
    # то, что подделал клиент, остаётся левее, а REMOTE_ADDR - это адрес самого caddy
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.META.get("REMOTE_ADDR", "")


def _rate_key(scope, key) -> str:
    # по этому ключу login смотрит неудачные входы, не увеличивая счётчик
    return f"rl:{scope}:{key}"


def rate_limit(scope, key, limit, window) -> bool:
    """Засчитывает попытку, False если за окно в window секунд их стало больше limit."""
    # счётчики в кэше процесса, у каждого воркера свой, поэтому лимит приблизительный
    cache_key = _rate_key(scope, key)
    # add создаёт счётчик, только если его ещё нет, а incr срок жизни не продлевает
    # так окно считается от первой попытки
    cache.add(cache_key, 0, window)
    try:
        count = cache.incr(cache_key)
    except ValueError:  # ключ истёк между add и incr
        cache.set(cache_key, 1, window)
        count = 1
    return count <= limit


def _too_many():
    response = _error("Слишком много попыток. Подожди минуту и попробуй снова", status=429)
    response["Retry-After"] = "60"
    return response


# лимиты рассчитаны на класс за одним школьным ip, где 30 детей входят одновременно
LOGIN_PER_IP = (60, 60)  # попыток входа с одного IP в минуту
LOGIN_FAILS_PER_USER = (10, 300)  # неверных паролей к одному имени за 5 минут
SIGNUP_PER_IP = (40, 600)  # регистраций с одного IP за 10 минут


def json_post(view):
    # только POST без csrf, разобранное тело передаётся во view вторым аргументом

    @csrf_exempt
    @require_POST
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        data = _json_body(request)
        if data is None:
            return _error("Некорректный JSON")
        return view(request, data, *args, **kwargs)

    return wrapper


def _user_from_token(request):
    # пользователь или None, если нет заголовка, подпись не сошлась или аккаунт выключен
    header = request.headers.get("Authorization", "")
    if not header.startswith(BEARER):
        return None
    try:
        user_id = signing.loads(header.removeprefix(BEARER), salt=TOKEN_SALT)
    except signing.BadSignature:
        return None
    return get_user_model().objects.filter(pk=user_id, is_active=True).first()


def with_token(view):
    # GET и PUT по токену, размер тела PUT ограничен MAX_SAVE_BYTES

    @csrf_exempt
    @require_http_methods(["GET", "PUT"])
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        user = _user_from_token(request)
        if user is None:
            return _error("Нужно войти заново", status=401)
        if request.method != "PUT":
            return view(request, user, None, *args, **kwargs)
        if len(request.body) > MAX_SAVE_BYTES:
            return _error("Сохранение слишком большое", status=413)
        data = _json_body(request)
        if data is None:
            return _error("Некорректный JSON")
        return view(request, user, data, *args, **kwargs)

    return wrapper


def _int(value, default=0):
    # bool в python тоже int, поэтому True и False отсекаем отдельно
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):  # OverflowError - для Infinity из json
        return default


def clean_settings(raw) -> dict:
    # оставляем только известные булевы ключи, остальное заменяем значениями по умолчанию
    raw = raw if isinstance(raw, dict) else {}
    return {
        key: raw[key] if isinstance(raw.get(key), bool) else default
        for key, default in SETTINGS_DEFAULTS.items()
    }


def empty_save(name="", avatar="", updated=0) -> dict:
    return {
        "v": SAVE_VERSION,
        "updated": updated,
        "profile": {"name": name, "avatar": avatar},
        "words": {},
        "days": {},
        "games": {},
        "settings": dict(SETTINGS_DEFAULTS),
    }


def clean_profile(raw: dict) -> dict:
    return {
        "name": str(raw.get("name", "")).strip()[:NAME_MAX],
        "avatar": str(raw.get("avatar", ""))[:AVATAR_MAX],
    }


def _is_timestamp(value) -> bool:
    # updated - целое число мс, bool отсекаем, потому что он тоже int
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_UPDATED


def _is_section(value) -> bool:
    # words, days и games - словарь словарей, внутрь записей не смотрим
    return isinstance(value, dict) and all(isinstance(v, dict) for v in value.values())


def clean_save(raw):
    # очищенная копия сохранения с телефона или None, если структура неверная
    if not isinstance(raw, dict) or raw.get("v") != SAVE_VERSION:
        return None
    updated = raw.get("updated")
    profile = raw.get("profile", {})
    if not _is_timestamp(updated) or not isinstance(profile, dict):
        return None
    sections = {section: raw.get(section, {}) for section in SAVE_SECTIONS}
    if not all(_is_section(value) for value in sections.values()):
        return None
    return {
        "v": SAVE_VERSION,
        "updated": updated,
        "profile": clean_profile(profile),
        **sections,
        "settings": clean_settings(raw.get("settings")),
    }


def _profile(user) -> Profile:
    profile, _ = Profile.objects.get_or_create(user=user)
    return profile


def _stored_save(profile) -> dict:
    # у аккаунтов из админки сохранения ещё нет
    # в старых сохранениях нет блока settings, его достраиваем на лету
    if profile.save_data:
        return {**profile.save_data, "settings": clean_settings(profile.save_data.get("settings"))}
    return empty_save(profile.display_name, profile.avatar, profile.updated)


def _store(profile, save):
    # updated, display_name и avatar дублируем в поля профиля, чтобы они были видны в админке
    profile.save_data = save
    profile.updated = save["updated"]
    profile.display_name = save["profile"]["name"]
    profile.avatar = save["profile"]["avatar"]
    if profile.pk is None:
        profile.save()
    else:
        profile.save(update_fields=["save_data", "updated", "display_name", "avatar"])


def _account(user, profile) -> dict:
    return {
        "token": make_token(user),
        "username": user.get_username(),
        "save": _stored_save(profile),
    }


def _signup_error(username, password):
    # текст ошибки для ребёнка или None, если имя и пароль подходят
    if not username or len(username) > USERNAME_MAX:
        return "Придумай имя для входа"
    if any(ch.isspace() for ch in username):
        return "В имени для входа не должно быть пробелов"
    if len(password) < PASSWORD_MIN:
        return f"Пароль должен быть не короче {PASSWORD_MIN} символов"
    if get_user_model().objects.filter(username__iexact=username).exists():
        return "Такое имя уже занято"
    return None


@json_post
def signup(request, data):
    # POST /api/signup, в ответ 201 {token, username, save}
    if not rate_limit("signup", client_ip(request), *SIGNUP_PER_IP):
        return _too_many()
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    error = _signup_error(username, password)
    if error:
        return _error(error)
    profile = clean_profile(data)
    updated = min(max(_int(data.get("updated")), 0), MAX_UPDATED)
    save = empty_save(profile["name"], profile["avatar"], updated)
    try:
        with transaction.atomic():
            user = get_user_model().objects.create_user(username=username, password=password)
            profile = Profile(user=user)
            _store(profile, save)
    except IntegrityError:
        # два запроса с одним именем одновременно: проверка выше обоих пропустила
        return _error("Такое имя уже занято")
    return JsonResponse(_account(user, profile), status=201)


@json_post
def login(request, data):
    # POST /api/login, в ответ {token, username, save} или 401
    username = str(data.get("username", "")).strip()
    # два лимита: на ip (считается каждая попытка) и на неверные пароли к одному имени
    # второй тут только проверяется, а растёт после неудачного входа
    fails_key = _rate_key("login-fail", username.lower())
    if not rate_limit("login", client_ip(request), *LOGIN_PER_IP):
        return _too_many()
    if cache.get(fails_key, 0) >= LOGIN_FAILS_PER_USER[0]:
        return _too_many()
    user = authenticate(request, username=username, password=str(data.get("password", "")))
    if user is None:
        rate_limit("login-fail", username.lower(), *LOGIN_FAILS_PER_USER)
        return _error("Неверное имя или пароль", status=401)
    return JsonResponse(_account(user, _profile(user)))


@with_token
def save(request, user, data):
    # GET /api/save отдаёт {save}, PUT принимает {save} и при конфликте отвечает 409
    if request.method == "GET":
        return JsonResponse({"save": _stored_save(_profile(user))})

    incoming = clean_save(data.get("save"))
    if incoming is None:
        return _error("Некорректное сохранение")
    # select_for_update держит строку профиля, пока идёт транзакция
    # так два PUT с разных телефонов сравнивают updated по очереди
    # равный updated принимаем, это повтор той же отправки
    with transaction.atomic():
        profile, _ = Profile.objects.select_for_update().get_or_create(user=user)
        stored = _stored_save(profile)
        if incoming["updated"] < stored["updated"]:
            # на сервере новее, телефон примет серверное
            return JsonResponse({"save": stored}, status=409)
        _store(profile, incoming)
    return JsonResponse({"save": incoming})
