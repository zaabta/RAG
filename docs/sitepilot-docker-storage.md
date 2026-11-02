# SitePilot Docker upload storage

## Existing PostgreSQL

This Compose project intentionally does not define PostgreSQL. The inspected existing container is `sitepilot-postgres`, with `sitepilot_pgdata` mounted at `/var/lib/postgresql/data` and host port `127.0.0.1:5433`. It was attached only to Docker's default `bridge` network. The other existing user-defined networks belong to unrelated projects, so `sitepilot-network` was created and the running PostgreSQL container was attached to it without recreation. The host port and PostgreSQL volume were left intact. The existing `sitepilot_uploads` is a named Docker volume, not a container or storage service; it was preserved and reused. No API or worker containers existed at inspection time.

The API and worker use Docker DNS name `sitepilot-postgres` and internal port `5432`. Set `DATABASE_URL_DOCKER` to the same database credentials but change the host and port to `sitepilot-postgres:5432`; keep `DATABASE_URL` with `localhost:5433` for local Mac commands. This Docker DNS hostname resolves because all three containers are attached to `sitepilot-network`.

The current `.env` contains `DATABASE_URL` and `OPENAI_API_KEY`; it has no container URL or upload JWT secret. Keep that file unchanged for host development. Create `.env.docker` from `.env.docker.example`, set the same database credentials and the issuer's existing JWT secret, then start the application:

```sh
cp .env.docker.example .env.docker
# Edit .env.docker with the existing DB credentials and JWT signing secret.
docker compose --env-file .env.docker -f compose.yaml up -d --build
```

On a fresh machine, create the external network and connect the existing PostgreSQL container once before Compose startup. Skip commands for resources already present/attached:

```sh
docker network create sitepilot-network
docker network connect sitepilot-network sitepilot-postgres
```

`storage-init` runs once as root to set ownership and mode on the upload and model cache volumes without deleting files. The API then runs migrations and serves authenticated routes; the worker starts after the API health check and runs one PostgreSQL queue consumer. Both application services use the same multi-stage image, database, UID/GID `10001:10001`, private `sitepilot-network`, and named `sitepilot_uploads` volume mounted at `/app/storage/uploads`. The API is published only on `127.0.0.1:3210` by default; set `SITEPILOT_API_PORT` to change the host port. The worker and PostgreSQL have no new host port mappings. Both application services have health checks. The worker has a 30-minute Docker stop grace period and waits for in-flight work before exiting; if Docker must force-stop it after that, its lease expires and the queued file remains for recovery. PostgreSQL startup ordering remains the operator's responsibility because PostgreSQL is external to this Compose file.

The existing `SITEPILOT_UPLOAD_STORAGE_DIR` setting remains a backward-compatible alias. `FILE_STORAGE_ROOT` takes precedence and defaults to `/app/storage/uploads` in the image. New database job rows store a random relative storage key, not the original filename or a host absolute path. Existing absolute-path rows remain readable when their files are under the configured root. To preserve a queued file previously stored elsewhere, copy its complete `sitepilot-upload-<random>/source.xlsx` directory under the named volume; the worker safely rebases that generated suffix and validates the stored checksum.

The API writes to a unique `0700` directory, writes the file with mode `0600` to a `.part` path, then atomically renames it before enqueueing the job. The original filename is metadata only. Worker reads verify path containment and SHA-256. Terminal files are retained for `SITEPILOT_UPLOAD_RETENTION_HOURS` (default 24, allowed 1–8760) so support and recovery can access originals; queued and retrying files remain until terminal state. The expired-file cleanup clears the database reference before deleting the file. Orphaned unreferenced upload directories are removed after one hour. The local multilingual embedding model cache is stored on `sitepilot_model_cache` and survives container recreation.

The separate named `sitepilot_model_cache` volume is mounted at `/app/storage/model-cache` in both application services. This avoids repeated model downloads after container recreation; it can be rebuilt from the model registry if lost. The named upload volume preserves source files through application container restarts and recreation. Neither volume is a backup or protects against host disk failure. Do not run `docker compose down -v` for routine deploys: it removes named volumes, including upload and model-cache data.

## Backup and restore

Take coordinated backups so PostgreSQL job metadata and the uploaded originals describe the same point in time. Stop the API first to stop new uploads, then stop the worker gracefully; it finishes its in-flight job before exiting. Do not stop or replace PostgreSQL. Run `pg_dump` using the existing host-reachable PostgreSQL URL, and copy the upload volume while both application services are stopped. The model cache is reconstructible and does not need to be included:

```sh
docker compose --env-file .env.docker -f compose.yaml stop api
docker compose --env-file .env.docker -f compose.yaml stop worker
mkdir -p backups
pg_dump --format=custom "$DATABASE_URL" --file "backups/sitepilot-db-$(date +%Y%m%d-%H%M%S).dump"
docker run --rm \
  -v sitepilot_uploads:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.20 sh -c 'set -eu; stamp=$(date -u +%Y%m%d-%H%M%S); tar -C /source -czf "/backup/sitepilot_uploads-$stamp.tar.gz" .; cd /source; find . -type f -exec sha256sum {} + > "/backup/sitepilot_uploads-$stamp.sha256"'
docker compose --env-file .env.docker -f compose.yaml start api worker
```

For a non-destructive restore check, use a new test volume name and never mount it at the production storage path. Set `BACKUP_ARCHIVE` and `CHECKSUM_FILE` to the selected backup files:

```sh
export BACKUP_ARCHIVE=sitepilot_uploads-20261101-120000.tar.gz
export CHECKSUM_FILE=sitepilot_uploads-20261101-120000.sha256
docker volume create sitepilot_uploads_restore_test_20261101
docker run --rm \
  -e BACKUP_ARCHIVE \
  -e CHECKSUM_FILE \
  -v sitepilot_uploads_restore_test_20261101:/target \
  -v "$PWD/backups:/backup:ro" \
  alpine:3.20 sh -c 'set -eu; tar -C /target -xzf "/backup/$BACKUP_ARCHIVE"; cd /target; sha256sum -c "/backup/$CHECKSUM_FILE"'
```

The restore command only writes to the explicitly named test volume. Do not point it at `sitepilot_uploads`. Keep the PostgreSQL dump and volume archive together with their timestamps, restrict access to both, and restore the database into a separate test database if validating the pair. This document does not run a restore against production.

## Configuration and operations

`DATABASE_URL_DOCKER` is deliberately separate from `DATABASE_URL` so local host development can continue to use `localhost:5433`. It must use `sitepilot-postgres:5432` on the shared Docker network. `SITEPILOT_JWT_SECRET` must match the authentication issuer. Compose defaults to one worker, with an API budget of 1 CPU/1536 MiB and a worker budget of 2 CPUs/2 GiB, based on the measured ~1 GiB single-job peak RSS. Increase limits only after measuring concurrent jobs. Other optional settings include `SITEPILOT_API_PORT`, lease and heartbeat intervals, queue capacity, disk reserve, and retention hours.

Use `docker compose --env-file .env.docker -f compose.yaml ps` and `docker compose --env-file .env.docker -f compose.yaml logs api worker` to inspect service health. File backup is still required: Docker named volumes provide persistence, not replication or backup.
