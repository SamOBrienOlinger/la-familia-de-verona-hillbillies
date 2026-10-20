# La Familia de Verona Hillbillies

## Collaborative Family Map — Django / Heroku edition

A map of people and generations, with shared editorial tools for names, dates,
relationships, photographs and videos. This work lives on `family-map-explorer`;
the existing GitHub Pages viewer and `main` branch are unchanged.

**[Heroku setup and recovery](docs/HEROKU.md)** ·
**[API contract](docs/API.md)** ·
**[Original static-viewer documentation](docs/STATIC-VIEWER.md)**

### Explore and contribute

Drag, zoom or search the family map. Select a person to open their profile and
follow parent, child, sibling or partner connections. The two original source
charts remain separate: 22 Renee records and 56 Bernard records are preserved,
including the existing family photographs and Dan's video.

On the Django-hosted app, **Contribute** opens sign-in and invitation-based
registration. Every active signed-in contributor can create, read, update,
soft-delete and restore shared people, connections and media, even records
created by another contributor. There is no owner-only editing restriction.
Anonymous visitors can read but cannot change the family record.

The editor includes permission-confirmed image/video uploads, captions,
descriptions, credits, validation, unsaved-draft warnings, version-conflict
messages, read-only edit history, and Trash/restore. Visible clients check for
new revisions every 30 seconds and offer a refresh without discarding drafts.
Original source snapshots and PDFs are never overwritten by editorial requests.

### Stack

Django 5.2 LTS, Django REST Framework, PostgreSQL, Gunicorn, WhiteNoise and
Cloudinary, with the existing HTML/CSS/JavaScript map. Django hosts the map and
API on the same origin and uses CSRF-protected session authentication. Spoodle
Space's familiar Django structure informed this implementation; its databases,
credentials, obsolete dependencies and deployed apps were not copied or changed.

### Run locally

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DEBUG=true
python manage.py migrate
python manage.py import_family
python manage.py createsuperuser
python manage.py runserver
```

Open the local Django URL, choose **Contribute**, and sign in. The staff account
can issue single-use, seven-day invitations from **Edit family → Create
invitation**. The deployment guide includes PowerShell and Heroku instructions.
`.env.example` is a reference only; Django reads the process environment.

Opening `dist/index.html` directly still provides a **read-only preview**, not
shared browser-local CRUD. The new backend is not live merely because this
branch exists. Deploy to a dedicated Heroku app/database and configure
Cloudinary for uploads and SMTP for password-reset delivery. No paid resources
or deployment credentials are provisioned by this repository.

### Tests

```bash
FAMILY_TESTING=1 python manage.py test tests.backend --verbosity 2
FAMILY_TESTING=1 python manage.py makemigrations --check --dry-run
FAMILY_TESTING=1 python manage.py collectstatic --noinput
node tests/map-core.test.cjs
```

The backend workflow additionally runs PostgreSQL concurrent-edit tests and a
real Django/Chromium editing journey at desktop and phone widths. The existing
static-map checks remain in place. Review the actual Actions result for the
commit you deploy; local SQLite tests alone cannot verify PostgreSQL locking.

### Visibility and recovery

This is a **public viewer, not a private family vault**. Only upload information
and media you have permission to publish. Trash is reversible and does not erase
source PDFs, Git history or previously shared media URLs. Replacing a file keeps
the previous asset for recovery; see the deployment guide for retention,
PostgreSQL backups, separate media backups and staging recovery checks.
