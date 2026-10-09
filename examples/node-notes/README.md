# Node backend with application-owned notes

A runnable HTTP/SQLite example for an application with its own database. It validates each request through the fixed Wallboard server's `GET /api/v2/user/me`, then scopes every database operation by Wallboard origin, customer, and user email. It makes no Wallboard write requests.

Use Node.js 22.13 or later. From the repository root after `npm install`:

```sh
WB_SERVER_URL=https://your-wallboard-server.example \
NOTES_ALLOWED_ORIGIN=http://localhost:5173 \
NOTES_ALLOW_WRITES=true \
node --experimental-sqlite --import tsx examples/node-notes/index.ts
```

PowerShell:

```powershell
$env:WB_SERVER_URL = 'https://your-wallboard-server.example'
$env:NOTES_ALLOWED_ORIGIN = 'http://localhost:5173'
$env:NOTES_ALLOW_WRITES = 'true'
node --experimental-sqlite --import tsx examples/node-notes/index.ts
```

The example binds to `127.0.0.1:3001` and creates `notes.sqlite` in the working directory. Override `HOST`, `PORT`, and `NOTES_DATABASE` as needed. On a hosted deployment use HTTPS, a persistent volume or a provider-managed database, and its configured public browser origin. SQLite files on ephemeral/serverless disks are not durable storage.

The browser obtains its own access token through the kit's OAuth client. Send that token in the `Authorization: Bearer …` header to this backend. Keep it out of URLs, source files, logs, and persisted notes. CORS accepts only `NOTES_ALLOWED_ORIGIN`; bearer-authenticated non-browser clients do not send an `Origin` header.

| Method | Endpoint | Response |
| --- | --- | --- |
| GET | `/api/session` | Verified identity, database ownership scope, and effective write permission |
| GET | `/api/notes` | `{ notes: Note[] }`, newest 100 owned notes |
| POST | `/api/notes` | Created note, HTTP 201 |
| PATCH | `/api/notes/:id` | Updated owned note |
| DELETE | `/api/notes/:id` | HTTP 204 |

POST/PATCH accept exactly `{ "text": "My note" }` with `Content-Type: application/json`. Text contains 1–2,000 characters and request bodies are limited to 16 KiB. A note is `{ id, text, createdAt, updatedAt }` with ISO timestamps. Other users' and customers' note IDs return 404 for update/delete, just like missing notes.

Writes are disabled unless `NOTES_ALLOW_WRITES=true`. When enabled, the example permits authenticated users to maintain their own notes except `VIEWER`, `DEVICE_USER`, and read-only identities. This is an explicit example application policy, not a general mapping of Wallboard roles to other databases. Adapt it to your application's domain and team-sharing rules.

Global administrators are denied by default. To authorize selected customers, set the application-owned `NOTES_ADMIN_CUSTOMER_IDS=123,456` allowlist and send one of those IDs as `X-Customer-Id`. Regular users cannot choose another customer. Administrators still only see their own notes, not other users' notes. An allowlist entry authorizes all global administrators on the configured server for that customer; add a per-user policy if your application needs a narrower rule.

The validator's `readOnly` combines the authoritative user account flag with a restrictive `readOnly=true` claim on the exact token Wallboard accepted. Decoded token fields never establish identity. Online validation does not cache identity and honors whichever revocation/expiry checks the configured Wallboard deployment applies; it does not create a new revocation mechanism.

This example accepts a bearer token on each request. It is not an OAuth BFF implementation and does not store refresh tokens or establish cookie sessions. A BFF deployment needs its own OAuth callback, secure session storage, HttpOnly cookies, CSRF protection, and logout lifecycle.
