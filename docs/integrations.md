# Контракт скриптов интеграции v1

Harness запускает скрипт из корня текущего Git-репозитория, передаёт JSON на stdin и ждёт до 60 секунд.
Переменные окружения наследуются. stdout — один JSON-объект, stderr — диагностика.
Успешный ответ обязательно содержит `ok: true`. Ошибка — ненулевой exit code или
ответ без `ok: true`; сообщение попадает в состояние запуска.

## трекер задач: task.report

```json
{
  "version": 1,
  "operation": "task.report",
  "payload": {
    "idempotencyKey": "run-id:1:WAITING_REVIEW",
    "taskId": "FRONT-123",
    "runId": "run-id",
    "status": "WAITING_REVIEW",
    "summary": "Реализация одобрена, PR ожидает ревью и merge",
    "report": "Markdown-отчёт о выполнении",
    "pullRequestUrl": "https://your-bitbucket/pr/1"
  }
}
```

`returnToRole` и `pullRequestUrl` могут отсутствовать. Дополнительно передаётся
`openspec: {"name":"task-...","directory":"openspec/changes/task-..."}` — ссылка
на change в рабочем checkout (или отсутствует у старого запуска). Ответ: `{"ok":true}`.
Для `NEEDS_CLARIFICATION` также вызывается `task.report`: адаптер публикует
вопросы в комментарии к задаче. Передаются `returnToRole=analyst` и массив
`questions: [{id, question, context, blocks}]`; `report` содержит подробный контекст.
Аналитик сначала исследует ТЗ и проект, в том числе через Codebase MCP, и задаёт
только оставшиеся блокирующие вопросы. В остальных отчётах `questions` — массив
вопросов последнего результата роли либо пустой массив.
Без настроенного адаптера вопросы сохраняются локально. Получение ответов из
комментариев пока не реализовано: ответ передаётся через `resume`.
Статус Harness сопоставляется со статусом рабочего процесса. При повторном
idempotencyKey адаптер обновляет уже созданный комментарий
или возвращает прежний результат, не дублирует уведомления.
Протокол не предполагает, что у всех установок трекера задач одинаковые API/поля.
Автор реального комментария определяется авторизацией скрипта. Личный токен означает
действия от владельца токена, сервисная учётка — от её имени. Сам Harness не выдаёт
LLM отдельную учётную запись и не передаёт ей токены интеграций в запросах.

При исчерпании доработок передаются `status=BLOCKED`, `returnToRole=developer`,
`escalation: {to, phase, reason, artifact}` и `verification.retries` со счётчиками
plan/implementation. Адаптер назначает реального разработчика по вашей конфигурации
и публикует переданный отчёт с замечаниями. Без адаптера остаётся локальный
`escalation.md`; Harness не отправляет сообщения в другие каналы.

## Bitbucket: pull-request.create

Вызывается после двух одобрений верификатора, успешных проверок и push. Запрос:

```json
{
  "version": 1,
  "operation": "pull-request.create",
  "payload": {
    "idempotencyKey": "run-id",
    "taskId": "FRONT-123",
    "branch": "codex/FRONT-123-run-id",
    "baseRef": "origin/main",
    "title": "FRONT-123: Форма обращения",
    "description": "Сводка результатов ролей",
    "commit": "commit-sha"
  }
}
```

Ответ: `{"ok":true,"url":"https://your-bitbucket/path/to/pr"}`.
Адаптер настраивает репозиторий/проект, преобразует baseRef в целевую ветку и
проверяет существование PR по исходной ветке/idempotencyKey до создания нового.
Это необходимо при retry после потери ответа API. Форматы Bitbucket Cloud и
Server/Data Center не предполагаются взаимозаменяемыми; реализацию добавьте
под установленную у вас версию. Адреса и токены в пример не зашиты.


## Bitbucket: pull-request.get

```json
{"version":1,"operation":"pull-request.get","payload":{"url":"https://your-bitbucket/pr/1","runId":"run-id","branch":"codex/task-run-id"}}
```

Ответ (нормализуйте API вашей версии Bitbucket в эту форму):

```json
{
  "ok": true,
  "state": "OPEN",
  "sourceCommit": "0123456789012345678901234567890123456789",
  "threads": [{
    "id": "thread-1",
    "resolved": false,
    "path": "src/example.ts",
    "line": 10,
    "comments": [{"id":"comment-1","author":"Reviewer","body":"Проверьте обработку ошибки","own":false}]
  }]
}
```

`state` — OPEN/MERGED/CLOSED (declined/закрытый без merge нормализуйте в CLOSED).
`sourceCommit` — актуальный SHA исходной ветки, включая для MERGED/CLOSED.
`path` и `line` необязательны: поддерживаются общие и построчные обсуждения.
Возвращайте все страницы тредов и все сообщения в хронологическом порядке;
не отдавайте неполный тред как полный. Id должны быть стабильны при редактировании.
`own=true` только для сообщений учётной записи автоматизации; если используется
личная учётка разработчика, её ручные комментарии тоже будут исключены. Для
надёжного различения используйте выделенную сервисную учётку.

## Bitbucket: pull-request.reply

```json
{
  "version": 1,
  "operation": "pull-request.reply",
  "payload": {
    "url": "https://your-bitbucket/pr/1",
    "runId": "run-id",
    "branch": "codex/task-run-id",
    "threadId": "thread-1",
    "idempotencyKey": "run-id:review:thread-content-hash:source-sha",
    "expectedSourceCommit": "0123456789012345678901234567890123456789",
    "expectedThreadFingerprint": "sha256-of-normalized-human-discussion",
    "body": "Ответ с обоснованием или описанием проверенного исправления"
  }
}
```

Ответ: `{"ok":true}`. Перед публикацией проверьте, что PR открыт, источник
соответствует expectedSourceCommit, тред открыт и его fingerprint соответствует
expectedThreadFingerprint. Нормализация и SHA-256 реализованы в
`src/review/identity.ts`: фиксированный порядок полей, только человеческие
комментарии, их исходный порядок сохраняется. Поле fingerprint добавлено к
контракту v1 как дополнительная предусловная проверка; старый адаптер сможет
работать без неё, но для защиты от гонки при публикации реализуйте эту проверку. При повторном idempotencyKey
верните прежний успех без дублирования сообщения. Ключ нужно сохранить/отыскать
в вашей интеграции, включая случай, когда сервер принял комментарий, но клиент
потерял ответ. Не отмечайте тред resolved и не выполняйте merge.

Заглушка `scripts/mock-integration.ts` читает HARNESS_BITBUCKET_FIXTURE и пишет
ответы в соседний `.replies.jsonl`. В ней явно выделены операции для замены вашим API.
Полный цикл и пример проверки без сети: [pr-review.md](pr-review.md).
