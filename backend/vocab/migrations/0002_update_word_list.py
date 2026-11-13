# Правки словаря от носителя языка (Kommentarii_Pirozhki.docx).
# Слова переименовываются на месте: id — ключ в сохранениях игроков, терять его нельзя.
# Удалённые слова тоже убираются миграцией: seed без --update не удаляет лишнее.
# Новые слова (коӵыш, ӟазег, ӵӧж, такъя, кут, ката, эрезь, кускерттон, нылпи, Ӵужанай,
# Ӵужатай, эмезь, палэзь, сутэр) создаёт seed из seeds/vocab.yaml.
# id удалённых слов в сохранениях останутся неиспользуемыми ключами — это безопасно.

from django.db import migrations


def forwards(apps, schema_editor):
    Word = apps.get_model("vocab", "Word")
    Fact = apps.get_model("vocab", "Fact")

    for slug, udm in [
        ("greetings", "салам"),
        ("farm-animals", "курка"),
        ("family", "кузпал"),
        ("family", "кышно"),
        ("berries", "лызмульы"),
    ]:
        Word.objects.filter(topic__slug=slug, udm=udm).delete()

    # (тема, старое udm) → новые поля; ru/alt правим, только если они менялись
    renames = [
        ("food", "кукей", "курегпуз", None, "кукей",
         "звук под старое слово «кукей» — перезаписать"),
        ("clothes", "азькышет", "айшет", None, None,
         "звук под старое слово «азькышет» — перезаписать"),
        ("family", "атай-анай", "анай-атай", None, None,
         "звук под старое слово «атай-анай» — перезаписать"),
        ("family", "нылы", "нил", "дочь, девочка", None,
         "звук под старое слово «нылы» — перезаписать"),
        ("family", "пие", "пи", "сын, мальчик", None,
         "звук под старое слово «пие» — перезаписать"),
        ("berries", "шупу", "шу", None, None,
         "звук под старое слово «шупу» — перезаписать"),
        ("berries", "ягмульыпу", "ягмульы", None, None,
         "звук под старое слово «ягмульыпу» — перезаписать"),
    ]
    for slug, old, new, ru, alt, check in renames:
        updates = {"udm": new, "needs_check": check}
        if ru is not None:
            updates["ru"] = ru
        if alt is not None:
            updates["alt"] = alt
        Word.objects.filter(topic__slug=slug, udm=old).update(**updates)

    # новая картинка для «дэрем» пока не готова, помечаем
    Word.objects.filter(topic__slug="clothes", udm="дэрем").update(
        needs_check="поменять картинку: новый файл пока не готов"
    )

    # порядок в «Моя семья»: нылпи после анай-атай, апай перед агай, песятай перед песянай,
    # Ӵужанай/Ӵужатай после песяянай — позиции совпадают с seeds/vocab.yaml
    family_order = [
        "анай", "атай", "анай-атай", "нилпи", "апай", "агай",
        "песятай", "песянай", "Ӵужанай", "Ӵужатай", "нил", "пи",
    ]
    for order, udm in enumerate(family_order):
        Word.objects.filter(topic__slug="family", udm=udm).update(order=order)

    # факты без источников не пересоздаём (seed без --update их не трогает), меняем текст на месте
    for old, new in {
        "Удмуртский язык — финно-угорский. Самый близкий родственник — коми язык, "
        "а дальние — финский, эстонский и венгерский.":
        "Удмуртский язык относится к финно-угорским языкам. Самый близкий — коми язык, "
        "дальние — марийский, финский, эстонский и венгерский.",
        "В удмуртском алфавите 38 букв — все русские и ещё пять своих: Ӝ, Ӟ, Ӥ, Ӧ, Ӵ.":
        "Удмуртский алфавит использует кириллицу — 33 буквы, как и в русском языке, "
        "и ещё 5 своих: Ӝ Ӧ Ӵ Ӥ Ӟ.",
    }.items():
        Fact.objects.filter(text=old).update(text=new)


def backwards(apps, schema_editor):
    Word = apps.get_model("vocab", "Word")
    Fact = apps.get_model("vocab", "Fact")

    for slug, old, new, ru, alt in [
        ("food", "кукей", "курегпуз", None, "курегпуз"),
        ("clothes", "азькышет", "айшет", None, None),
        ("family", "атай-анай", "анай-атай", None, None),
        ("family", "нылы", "нил", "дочь", None),
        ("family", "пие", "пи", "сын", None),
        ("berries", "шупу", "шу", None, None),
        ("berries", "ягмульыпу", "ягмульы", None, None),
    ]:
        updates = {"udm": old, "needs_check": ""}
        if ru is not None:
            updates["ru"] = ru
        if alt is not None:
            updates["alt"] = alt
        Word.objects.filter(topic__slug=slug, udm=new).update(**updates)

    Word.objects.filter(topic__slug="clothes", udm="дэрем").update(needs_check="")

    # слова, удалённые в этом изменении. id им уже не вернуть — они уйдут в сохранениях
    # игроков, поэтому откат только для разработки, на работающей базе его делать не надо.
    Topic = apps.get_model("vocab", "Topic")
    topics = {t.slug: t for t in Topic.objects.all()}
    recreated = [
        ("greetings", 3, "салам", "привет", "", "words/hi.webp", "🖐️", "audio/hi-2.mp3"),
        ("farm-animals", 10, "курка", "индейка", "", "words/turkey.webp", "🦃", "audio/turkey.mp3"),
        ("family", 7, "кузпал", "супруг", "супруга", "words/spouse.webp", "💑", "audio/spouse.mp3"),
        ("family", 8, "кышно", "жена", "", "words/wife.webp", "👰", "audio/wife.mp3"),
        ("berries", 5, "лызмульы", "голубика", "", "words/blueberry.webp", "🫐", "audio/blueberry.mp3"),
    ]
    for slug, order, udm, ru, alt, image, emoji, audio in recreated:
        Word.objects.update_or_create(
            topic=topics[slug], udm=udm,
            defaults={"ru": ru, "alt": alt, "order": order,
                      "emoji": emoji, "image": image, "audio": audio},
        )

    # старый порядок: агай перед апай, песянай перед песятай, ныл/пи в конце;
    # новые слова (нилпи, Ӵужанай, Ӵужатай) откат не трогает
    old_family_order = [
        "анай", "атай", "атай-анай", "агай", "апай", "песянай",
        "песятай", "кузпал", "кышно", "нылы", "пие",
    ]
    for order, udm in enumerate(old_family_order):
        Word.objects.filter(topic__slug="family", udm=udm).update(order=order)

    for old, new in {
        "Удмуртский язык относится к финно-угорским языкам. Самый близкий — коми язык, "
        "дальние — марийский, финский, эстонский и венгерский.":
        "Удмуртский язык — финно-угорский. Самый близкий родственник — коми язык, "
        "а дальние — финский, эстонский и венгерский.",
        "Удмуртский алфавит использует кириллицу — 33 буквы, как и в русском языке, "
        "и ещё 5 своих: Ӝ Ӧ Ӵ Ӥ Ӟ.":
        "В удмуртском алфавите 38 букв — все русские и ещё пять своих: Ӝ, Ӟ, Ӥ, Ӧ, Ӵ.",
    }.items():
        Fact.objects.filter(text=old).update(text=new)


class Migration(migrations.Migration):
    dependencies = [("vocab", "0001_initial")]
    operations = [migrations.RunPython(forwards, backwards)]
