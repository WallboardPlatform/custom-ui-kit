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

The standalone client's `signIn()` requires top-level navigation and rejects a framed login. For the CMS My Apps host, use [the embedded adapter](authentication.md#embedded-cms-session) instead. The host runs the app in an opaque script-enabled sandbox without `allow-same-origin`; uploaded documents also need an enforced server CSP sandbox for direct visits. Keep the host isolation when deploying a URL.

Opaque frames cannot use ordinary browser storage or cookie-based sessions. ES module scripts, fonts and external app-backend fetches may require CORS responses for an opaque origin. Embedded Wallboard API operations use the parent CMS proxy over a private MessagePort, without a bearer token or direct Wallboard fetch in the iframe. The [Fleet Overview upload](../examples/embedded-device-board/README.md) avoids asset CORS dependencies by inlining a classic script and styles. A hosted provider can still block framing or depend on unsupported storage/authentication. Verify that provider rather than relaxing the sandbox. The matching protocol version 2 CMS host/backend feature must be deployed before the embedded adapter can connect; standalone and signage hosting remain separate surfaces.
