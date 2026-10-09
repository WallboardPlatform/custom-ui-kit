# Hosting and embedding

The browser examples build to static files. Serve them over HTTPS with the application entrypoint available at its OAuth redirect URI. Configure `VITE_WB_SERVER_URL` and optional `VITE_WB_CLIENT_ID` at build time, or let the user choose the server. Browser variables are public configuration, never secrets.

For a backend, choose a provider that supports its runtime and durable storage, or implement the same online identity contract in the provider's runtime. The Node/SQLite example needs a persistent disk. An ephemeral serverless filesystem is not a durable database; use that provider's SQL service or an external database. Keep credentials server-side and configure the exact browser origin. Configure HTTPS and a reverse proxy for production Node hosting.

Deployment checks:

1. The exact callback URL is registered and loads the callback-handling application.
2. Login, refresh, logout, rejected credentials and missing permissions behave on that origin.
3. API CORS and backend origin settings match the application's public origin.
4. Routing serves the entrypoint where expected, and assets work under the chosen base path.
5. The database survives restarts and its authorization rules isolate users/customers.

Sites and other hosted builders may own callback routes, authentication, or server runtime conventions. Adapt to those documented capabilities and prove the actual deployment; a local bundle alone does not establish provider compatibility.

## Frames

A standalone URL can be embedded only if its hosting headers permit the parent, the Wallboard surface permits the required iframe features, and browser authentication/storage works there. CMS panels and signage widgets have different sandboxes. Interactive sign-in is not established by a public URL or an absence of frame-blocking headers.

The kit's current `signIn()` requires top-level navigation and rejects a framed login attempt with a clear error. A future popup/callback handoff must explicitly validate origins and state, fit the host's sandbox, and handle third-party storage restrictions. Do not remove sandbox protections just to make a demo appear to work.

Configure any CMS navigation/panel or signage URL through its actual available product flow. The MCP authoring guide itself adds no new CMS menu entry or iframe surface.
