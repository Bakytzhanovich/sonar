# Воркер Sonar на VPS

Воркер — отдельный процесс, который монтирует видео (Smart Cut, субтитры,
шумодав) и разбирает рилсы. Сайт, API и база живут в другом месте
(Render + Neon), файлы видео — в Cloudflare R2. На этом сервере крутится
только воркер: он сам ходит в базу за задачами, скачивает исходник из R2,
рендерит и кладёт результат обратно. Входящих портов не открывает.

## Требования к серверу

- x86_64 (не ARM — шумодав DeepFilterNet скачивается бинарником под x86)
- 2 vCPU, 4 ГБ RAM, 30 ГБ свободного диска
- Docker

Проверка одной командой:

```sh
nproc; free -h; df -h /; uname -m; docker --version
```

## Запуск

```sh
git clone https://github.com/Bakytzhanovich/sonar.git
cd sonar

# Секреты: владелец проекта передаст значения отдельно
cp deploy/worker/worker.env.example .env.worker
nano .env.worker
chmod 600 .env.worker

docker build -t sonar-worker .
docker run -d --name sonar-worker --restart always \
  --cpus=2 --memory=3g \
  --env-file .env.worker \
  sonar-worker
```

- `--restart always` — поднимается сам после перезагрузки сервера и падений
- `--cpus=2 --memory=3g` — рендер занимает процессор на минуты; лимит не даёт
  ему отнять ресурсы у остального на сервере

Файл `.env.worker` в git не попадает (см. `.gitignore`) — не коммитить его.

## Проверка

```sh
docker logs -f sonar-worker
```

Должно быть:

```
[worker] хранилище: R2/S3
[worker] smart-cut worker started, polling every 5000ms, concurrency 1
```

Если контейнер сразу падает с `SESSION_SECRET must be set` — эта строка в
`.env.worker` пустая.

Предупреждение `SECURITY WARNING: The SSL modes ...` от библиотеки `pg` —
безвредно. Если вместо `R2/S3` написано `локальная ФС` — в `.env.worker` не
заданы переменные `STORAGE_*`.

На сайте у ролика в очереди должна пропасть надпись «Обработчик не на связи».

## Обновление

```sh
cd sonar
git pull
docker build -t sonar-worker .
docker rm -f sonar-worker
docker run -d --name sonar-worker --restart always \
  --cpus=2 --memory=3g \
  --env-file .env.worker \
  sonar-worker
```

Остановка посреди рендера безопасна: задача вернётся в очередь и
доделается после перезапуска.
