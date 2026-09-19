# Waitlist-Navigator

## Database

Requires Docker. Copy `.env.example` to `.env`, then:

```bash
npm run db:up            # Postgres 16 and Redis 7
npm run migrate:up       # apply all migrations as the owner role
npm run migrate:down     # revert all migrations
npm run check:migrations # up/down/up on throwaway databases, plus every constraint check
```

If port 5432 or 6379 is already in use on your machine, set `POSTGRES_PORT` and `REDIS_PORT` in `.env` and point `DATABASE_URL` and `DATABASE_URL_MIGRATE` at the same Postgres port.
The API connects as `app_user`, which cannot update, delete or truncate `audit_log`.
Design: [docs/design/schema-migrations.md](docs/design/schema-migrations.md).