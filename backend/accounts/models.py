from django.conf import settings
from django.db import models


class Profile(models.Model):
    # создаётся при регистрации, а для аккаунтов из админки при первом обращении к api

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile"
    )
    # копия save.profile, чтобы имя и зверёк были видны в админке
    display_name = models.CharField("имя ребёнка", max_length=60, blank=True)
    avatar = models.CharField("аватар (эмодзи)", max_length=16, blank=True)
    # копия save.updated, по ней сравниваются версии
    updated = models.BigIntegerField("изменён", default=0)
    # не save, чтобы не перекрыть метод Model.save()
    save_data = models.JSONField("сохранение", default=dict, blank=True)

    class Meta:
        verbose_name = "профиль"
        verbose_name_plural = "профили"

    def __str__(self):
        return self.display_name or self.user.get_username()
