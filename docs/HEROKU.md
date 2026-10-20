# Django / Heroku deployment

This branch uses Django 5.2 LTS, Django REST Framework, PostgreSQL, Gunicorn,
WhiteNoise and Cloudinary. The map is still plain JavaScript: no React rewrite
or Node production build is necessary. The Django project serves both the map
and `/api/` on **one origin** so browser sessions do not depend on third-party
cookies. Original GitHub Pages and `dist/tree.html` remain read-only viewers.

## What was reused from Spoodle Space

The owner's [DRF project](https://github.com/SamOBrienOlinger/drf-spoodle-space)
provided the familiar models/serializers/views structure, environment-configured
PostgreSQL, Cloudinary and Gunicorn conventions. The paired
[React frontend](https://github.com/SamOBrienOlinger/spoodle-space-pp5) was reviewed
as a reference, not modified or deployed. This implementation does **not** copy
its Django 3.2 pins, old cross-site JWT cookies, databases, API keys or application
names. All active invited contributors have equal record-editing rights; it is
not an `IsOwnerOrReadOnly` social-post permission model.

## Local development

```bash
git fetch origin
git switch family-map-explorer
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export DEBUG=true
python manage.py migrate
python manage.py import_family
python manage.py createsuperuser
python manage.py runserver
```

PowerShell: create with `py -3.13 -m venv .venv`, activate with
`.venv\Scripts\Activate.ps1`, and set `$env:DEBUG = "true"`.
Django reads **process environment variables**, not `.env` or `env.py` automatically.
`.env.example` documents names only. The development-only signing-key fallback
is refused in production. Local SQLite and `local-media/` are ignored by Git.
Install `ffprobe` for local MP4/MOV validation, or configure a separate development
Cloudinary account with `MEDIA_BACKEND=cloudinary`.

Visit `/`, select **Contribute**, and sign in. A superuser/staff maintainer can
issue invitations using **Edit family → Create invitation**. An invite is single
use, expires after seven days and may be bound to an email address. Send it
privately to the intended contributor; it is never placed in a public URL.
There is no anonymous signup or anonymous write route. Accounts can be disabled
by a superuser through Django admin; existing sessions then lose access.

## Deploy to your own Heroku account

**No Heroku app, database, paid plan or Cloudinary account is provisioned by this
repository.** Review current pricing in your account before purchasing resources.
Use a new app and a separate database, not your Spoodle Space production app.

1. Sign in using your own Heroku CLI or Dashboard session. Create/select the
   intended app and note its **exact generated hostname**. Do not assume the
   app URL is simply the app name followed by `.herokuapp.com`.
2. Choose the **Python buildpack**. `.python-version` requests Python 3.13 and
   `requirements.txt` pins the tested dependency resolution.
3. Attach a dedicated PostgreSQL database and verify `DATABASE_URL` is present.
   A local filesystem or SQLite database is not durable on Heroku dynos.
4. Set the configuration below in Heroku **Settings → Config Vars**. Keep all
   credentials outside this public repository and outside chat.
5. In **Deploy → GitHub**, connect this repository and deploy
   **`family-map-explorer`**, not `main`. Alternatively, after setting the correct
   Heroku Git remote, `git push heroku family-map-explorer:main` deploys this
   branch to the Heroku remote; it does not merge the GitHub `main` branch.
6. Verify the build's `collectstatic` step and the release phase finish. The
   Procfile runs migrations and the idempotent first import before starting
   Gunicorn. Do not set `DISABLE_COLLECTSTATIC`.
7. Run `heroku run python manage.py createsuperuser --app YOUR_APP` in your own
   authenticated terminal. No default administrator password exists.
8. Open the actual Heroku URL, not the static raw.githack preview. Sign in and
   run the acceptance checklist below before sharing the editing URL.

### Config Vars

| Name | Value / purpose |
|---|---|
| `SECRET_KEY` | Fresh random Django signing key; generate privately. |
| `DEBUG` | `false` in production. |
| `DATABASE_URL` | Dedicated PostgreSQL URL, normally supplied by the add-on. |
| `ALLOWED_HOSTS` | Comma-separated exact app/custom hostnames, no scheme or `*`. |
| `CSRF_TRUSTED_ORIGINS` | Exact `https://` app/custom origins if needed. |
| `MEDIA_BACKEND` | `cloudinary` in production; local storage is refused. |
| `CLOUDINARY_URL` | Private Cloudinary connection URL; uploads return 503 until configured. |
| `EMAIL_HOST`, `EMAIL_PORT` | SMTP service, typically port 587. |
| `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD` | Private SMTP credentials. |
| `EMAIL_USE_TLS` | `true` for the documented SMTP setup. |
| `DEFAULT_FROM_EMAIL` | Verified sender accepted by your email provider. |

Do not enable `FAMILY_TESTING` in Heroku. That flag deliberately relaxes security
for disposable local/CI tests. Production uses HTTPS-only session/CSRF cookies,
HSTS, CSRF validation, a same-origin Content Security Policy and no anonymous
writes. `CORS_ALLOWED_ORIGINS` defaults empty: leave it empty for this same-origin
browser application. No Cloudinary or Heroku secret is sent to the frontend.

The optional `app.json` describes this app's build/configuration. It intentionally
contains **no auto-provisioned paid add-ons** and does not set a dyno plan for you.

### First-run checks

- `/healthz/` returns `{"status":"ok"}`; this checks database connectivity only.
- Map opens with 22 Renee and 56 Bernard source profiles and all four original
  media groups; future editorial additions will increase the counts.
- Invited contributor A creates a person and uploads a permitted image.
  Contributor B can edit A's record. Another browser sees the revision notice
  and can refresh to see the saved change.
- Two open editors: the second stale save receives HTTP 409 without replacing
  its unsaved form text. Reopen the current record to reconcile manually.
- Test parent/partner validation, Trash and restore with disposable test records.
- Confirm a logged-out browser cannot write. Confirm logout actually ends
  authenticated writes and test password-reset email **delivery** with your SMTP.
- Check Cloudinary image/video delivery and a valid upload on the actual Heroku
  app. Mocked provider tests do not prove your provider credentials or quota.

## Persistence, public visibility and recovery

PostgreSQL is the shared source of truth for accounts, records, relationships,
versions, invitations, edit history and rate limits. Cloudinary stores newly
uploaded media. Original repository media and PDFs remain bundled static assets;
no re-upload to Cloudinary is required to preserve them.

This is a **public family viewer**, not a private family vault. Original names,
dates, source PDFs and images already in the public repository remain public.
Cloudinary delivery URLs in this version are public HTTPS URLs, not expiring
private URLs. Obtain appropriate permissions, particularly for children's media.
Do not store private contact details, medical information or identity documents.
Trash removes an editorial item from active views but does not erase public
source PDFs, Git history, already shared URLs or third-party copies.

Deleting a person also soft-deletes their active connections with a shared
batch identifier. Shared media is retained. Restore the person first; restore
connections separately so each is checked against the current graph. Deleting
media is reversible. Replacing a file keeps the prior asset and its URL in the
history. This consumes storage until a maintainer performs a separately reviewed
retention cleanup. Failed new uploads are cleaned up when possible; provider
cleanup failure is logged with a random asset ID for follow-up.

Use Heroku PostgreSQL backups for **full** recovery, including users and audit
history. Schedule backups appropriate to your plan and periodically restore a
backup into a **separate staging app/database** to test it. A database backup
does not back up Cloudinary files. Configure Cloudinary backup/retention in your
own plan and keep independent, permissioned copies of irreplaceable family
media. Never restore over a live database casually.

An additional editorial export is available:

```bash
heroku run --no-tty python manage.py export_family --app YOUR_APP > family-export.json
```

Inspect the output for CLI preamble before treating it as JSON. It contains
editorial records, Trash and original provenance, but **not** user passwords,
sessions or a complete database backup. Treat exports as personal data, never
commit them. `import_family` seeds only missing charts and never restores a full
backup or overwrites existing editorial changes.

Run `python manage.py clean_rate_buckets` and `python manage.py clearsessions`
periodically to remove expired operational records. No scheduler/add-on is
silently provisioned. Administrators should review abnormal activity and can
disable compromised accounts. Database-backed limits apply across dynos but
are not a substitute for an upstream WAF or volumetric abuse protection.

## Verification commands

```bash
FAMILY_TESTING=1 python manage.py test tests.backend --verbosity 2
FAMILY_TESTING=1 python manage.py makemigrations --check --dry-run
FAMILY_TESTING=1 python manage.py collectstatic --noinput
node tests/map-core.test.cjs
```

The backend workflow uses a disposable PostgreSQL 17 service and a separate
Playwright/Chromium browser run, including 1440px, 390px and 320px layouts.
Local SQLite checks do not validate PostgreSQL concurrency; use the PostgreSQL
CI job for that. Browser tests use fictional accounts and an actual temporary
HTTP server, not the deployed family site. Production deployment, SMTP delivery
and Cloudinary integration must be checked in your account.

## Primary engineering references

- [DRF authentication and CSRF](https://www.django-rest-framework.org/api-guide/authentication/)
- [Django deployment checklist](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/)
- [Heroku release phase](https://devcenter.heroku.com/articles/release-phase)
- [Heroku ephemeral filesystem](https://devcenter.heroku.com/articles/dynos#ephemeral-filesystem)
- [Heroku Postgres backups](https://devcenter.heroku.com/articles/heroku-postgres-backups)
- [Cloudinary Python uploads](https://cloudinary.com/documentation/django_image_and_video_upload)
- [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
