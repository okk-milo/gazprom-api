#!/bin/sh
set -eu
# Run after copying the compiled DEV-615 dist into this task-only directory.
test -f /opt/gazprom/dev615/gazprom-api/dist/burnout/preview.js
if sudo -n docker container inspect dev615-api-preview >/dev/null 2>&1 || sudo -n docker container inspect dev615-db-preview >/dev/null 2>&1; then
  echo 'Preview already exists; preserve it and inspect before updating.' >&2
  exit 1
fi
sudo -n docker network create dev615-preview >/dev/null
sudo -n docker volume create dev615-preview-pg >/dev/null
DEV615_DB_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
export POSTGRES_PASSWORD="$DEV615_DB_PASSWORD"
sudo -n --preserve-env=POSTGRES_PASSWORD docker run -d --name dev615-db-preview --network dev615-preview \
  --restart unless-stopped --memory 256m --cpus 0.5 \
  --env POSTGRES_USER=dev615 --env POSTGRES_DB=dev615 --env POSTGRES_PASSWORD \
  --mount type=volume,source=dev615-preview-pg,target=/var/lib/postgresql/data postgres:17-alpine >/dev/null
unset POSTGRES_PASSWORD
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if sudo -n docker exec dev615-db-preview pg_isready -U dev615 -d dev615 >/dev/null; then break; fi
  sleep 1
done
sudo -n docker exec dev615-db-preview pg_isready -U dev615 -d dev615 >/dev/null
export DATABASE_URL="postgres://dev615:$DEV615_DB_PASSWORD@dev615-db-preview:5432/dev615"
DEV615_API_IMAGE=$(sudo -n docker inspect deploy-api-1 --format '{{.Image}}')
sudo -n --preserve-env=DATABASE_URL docker run -d --name dev615-api-preview --network dev615-preview \
  --restart unless-stopped --memory 512m --cpus 1 --publish 127.0.0.1:3185:3000 \
  --env DATABASE_URL --env CORS_ORIGINS=http://127.0.0.1:5177 \
  --mount type=bind,source=/opt/gazprom/dev615/gazprom-api/dist,target=/app/dist,readonly \
  "$DEV615_API_IMAGE" node dist/burnout/preview.js >/dev/null
unset DATABASE_URL DEV615_DB_PASSWORD
echo 'DEV-615 preview started on host loopback port 3185; antifraud was not changed.'
