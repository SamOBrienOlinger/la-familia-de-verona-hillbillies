# Collaborative family API (v1)

The Django app hosts the map at `/` and JSON API at `/api/`. Requests and uploads
are same-origin; `fetch` uses `credentials: "same-origin"`. This version has no
public bearer-token endpoint. A future native React Native client can reuse the
REST resources but needs a separately reviewed native authentication adapter;
this work does not convert the site into a React Native binary.

## Authentication

`GET /api/account/session/` returns `csrf`, `user` (or null), `upload_ready`,
`registration: "invitation"` and `public_read: true`. Send `X-CSRFToken` on every
write, including anonymous login/registration. The session ID is HttpOnly; it
is never saved in localStorage.

| Method and endpoint | Body / purpose |
|---|---|
| `POST /api/account/login/` | `username`, `password` |
| `POST /api/account/register/` | `username`, `email`, `password`, `invite` |
| `POST /api/account/logout/` | Empty JSON object |
| `POST /api/invites/` | Staff only; optional email binding; returns single-use code |
| `/accounts/password_reset/` | Django's CSRF-protected password-reset forms/email flow |

Invitations expire after seven days; only their SHA-256 hash is stored. Passwords
use Django's password hashing/validation. Contributor accounts cannot grant
themselves staff/superuser permissions. Every active signed-in contributor can
create, update, soft-delete and restore shared records regardless of creator.
Anonymous clients can only read active public content.

## Resources and version preconditions

| Resource | Writable fields |
|---|---|
| `/api/people/` | `chart` (create only), `name`, `aliases` list, `lines` list, `notes`, `generation` |
| `/api/relationships/` | `chart` (create only), `source`, `target`, `kind` (`parent`/`partner`), `notes` |
| `/api/media/` | multipart `file`, repeated `people`, `caption`, `alt`, `credit`, `consent_confirmed` |

For each resource: GET collection/detail, POST collection, PATCH/PUT detail,
DELETE detail, and POST `{id}/restore/`. Delete is **soft delete**, returns the
new version and deleted timestamp, and never permanently erases a record.
Lists return `count`, `next`, `previous`, `results`, with pages of 100.
Use `?chart=renee`, `?chart=bernard`, `?person=ID` for media, or signed-in
`?trash=1` to list deleted records. Detail GET returns an ETag.

Every PATCH, PUT, DELETE or restore must send the version read from that record:

```http
If-Match: "3"
X-CSRFToken: <token from the same browser session>
Content-Type: application/json
```

The version is checked **inside a database transaction after row locking**.
Missing precondition returns **428**; stale version returns **409**. The client
keeps the draft and asks the contributor to reopen/reconcile it, rather than
silently overwriting another person's changes. Chart locks serialize graph edits,
including concurrent cycle proposals. This simple locking scope is intentionally
suited to a small family graph, not a high-throughput public social network.

`id`, `version`, deletion metadata, media URLs, storage IDs, and `source_snapshot`
are never writable through the public serializer. Original PDFs/static chart
JSON are not edited by CRUD requests.

## Connections and generations

`parent` is directed **source parent → target child**; `partner` is unordered and
canonicalized. Self-links, duplicate active edges, cross-chart links, links to
deleted people and ancestry cycles are rejected. Partner groups occupy the same
generation and cannot simultaneously be in each other's ancestry. The generation
field is a layout hint for disconnected/new roots; descendants are placed below
parents. This version supports up to 30 display generations.

Partners do not automatically become parents of each other's children: add the
actual parent-child connection for each recorded parent. Different source charts
remain separate and are not silently merged. Shared photographs may be linked to
multiple people and both source-chart versions of a person.

## Media

New uploads accept JPEG, PNG and WebP (8 MiB maximum; 20 megapixels), or MP4/MOV
(20 MiB maximum, up to two minutes). SVG, HTML, arbitrary documents, remote-URL
imports and audio-only files are rejected. The server checks content rather than
trusting extensions alone. Photos are decoded, oriented and re-encoded as JPEG
to remove EXIF/GPS metadata. Original bundled media is preserved unchanged.
Video decoding/metadata is checked by Cloudinary in production and ffprobe in
local development. Not every codec plays in every browser: H.264/AAC MP4 is the
preferred upload format; test the actual result on target devices.

Upload metadata includes a human-readable caption, description, source credit,
and an explicit confirmation of permission to publish (including appropriate
parental permission). No automated identity inference is performed. A memory
can be associated with 1–20 active people. New media is the default profile cover;
**Manage memories** exposes the rest of the collection. A PATCH may replace a
file or edit its metadata; old assets remain recoverable through history.

Uploads use random server-controlled paths and server-only provider credentials.
A failed upload/validation never creates a successful database record. A newly
uploaded file is cleaned up if its later database transaction fails; cleanup
failures are logged for an operator. Normal Trash/replace does not destroy old
provider files. Provider delivery URLs remain public; see the privacy note in
[HEROKU.md](HEROKU.md).

## Snapshot, change history and refresh

- `GET /api/snapshot/` provides `data`, `graph`, `revision` compatible with the map.
- `GET /api/revision/` provides a small revision counter. Visible clients poll
  every 30 seconds and offer Refresh rather than overwriting open drafts.
- Signed-in `GET /api/history/?object_id=ID` returns before/after data and the
  contributor username. Use `before=EVENT_ID` for the next older page of 50.
- `GET /healthz/` checks database connectivity without revealing config secrets.

History is read-only through both the API and the content admin. A maintainer
with database access can still alter a database; this is not a tamper-proof
cryptographic ledger. Restoration of an earlier edit is manual reconciliation,
not an automatic whole-history rollback. Recovering deletion has a dedicated
Restore action with the same version and graph checks as other edits.

## Error and abuse handling

Validation: 400; unauthenticated/CSRF: 403; missing/deleted record: 404;
stale/duplicate conflict: 409; oversized upload stream: 413;
missing If-Match: 428; throttled: 429; provider/config unavailable: 503.
Client timeout/network messages retain forms and warn that a timed-out write may
still have reached the server: check the current record before retrying.

Database-backed limits: 240 mutations/hour/account, 20 uploads/hour/account,
30 account attempts/15 minutes/client, 15 login attempts/15 minutes/username,
5 password-reset attempts/15 minutes/client and 30 invites/hour/staff account.
These are baseline abuse controls, not a DDoS mitigation or an antivirus service.
Use private invitations, account suspension, logs, backups and provider quotas.
