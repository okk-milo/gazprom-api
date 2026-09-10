# Deployment

The server keeps the four task repositories under one parent directory so that
`compose.yml` can build `gazprom-api` and `gazprome` without publishing images.

1. Copy `.env.example` to `gazprom-api/.env` on the server and fill only server-local secrets.
2. Set `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` in that file.
3. Start the public demo with `docker compose --env-file ../.env -f compose.yml up -d --build` from this folder.

The initial demo uses `MOCK_PROCESSING_ENABLED=true` until the separately tested
ASR and LLM task branches are reachable through `ASR_INTERNAL_URL` and
`LLM_INTERNAL_URL`. Neither internal service is exposed by the public Nginx
container.
