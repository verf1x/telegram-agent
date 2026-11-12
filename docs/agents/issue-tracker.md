# Трекер задач: GitHub Issues

Задачи и спецификации проекта хранятся в GitHub Issues репозитория `verf1x/verfix-telegram-agent`. Для всех операций используй CLI `gh` из корня репозитория.

## Основные операции

- Создать задачу: `gh issue create --repo verf1x/verfix-telegram-agent --title "..." --body "..."`.
- Прочитать задачу: `gh issue view <номер> --repo verf1x/verfix-telegram-agent`.
- Список открытых задач: `gh issue list --repo verf1x/verfix-telegram-agent --state open`.
- Добавить или убрать метку: `gh issue edit <номер> --repo verf1x/verfix-telegram-agent --add-label "..."` / `--remove-label "..."`.
- Закрыть задачу: сначала добавь комментарий с результатом, затем выполни `gh issue close <номер> --repo verf1x/verfix-telegram-agent`.

Перед первой записью в GitHub в сессии проверь целевой репозиторий командой `gh repo view --json nameWithOwner`.

## Связи задач

Используй нативные GitHub sub-issues для дочерних задач и нативные зависимости issue для блокировок, если команда `gh` их поддерживает. Если операция недоступна, укажи родительскую задачу или блокирующие задачи в тексте issue.

## Pull requests

**PR как очередь запросов: нет.** Внешние PR не проходят через triage как задачи.

## Когда навык просит опубликовать

Создай GitHub Issue в `verf1x/verfix-telegram-agent`. Перед чтением задачи используй `gh issue view`.

## Wayfinder

- Карта решений — issue с меткой `wayfinder:map`.
- Дочерние решения — sub-issues с одной из меток `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` или `wayfinder:task`.
- Назначай себе задачу перед началом работы над ней. Закрывая задачу, добавь комментарий с решением и обнови индекс решений в карте.
