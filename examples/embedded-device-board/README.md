# Embedded Fleet Overview

A read-only Custom UI for the CMS My Apps menu. It receives verified user identity from the host and reads paginated devices through the tokenless parent API proxy. The iframe receives no Wallboard token. Search/status filters apply to the currently loaded page; the counters describe that page, not the entire fleet. Device/customer/user text is rendered as text, never HTML.

From the repository root:

```sh
npm ci
npm run build:embedded
```

The build produces `dist/examples/embedded/index.html`, `wallboard-ui.json` and `fleet-overview.zip`. The app imports `wallboard-ui.json` as its own source declaration, `{ "readOnly": true, "operations": [{ "method": "GET", "path": "/api/v2/device", "description": "Read the selected customer's device overview." }] }`, and passes it to `createEmbeddedWallboardClient({ manifest })`. Upload the ZIP to an HTML Bundle Custom UI and open it from My Apps. The isolated app initializes and declares its requirements with zero API access; Wallboard displays the complete list before granting any identity/API access. No administrator imports/registers permissions and no backend parses the manifest out of the ZIP. The archive has a regular root `index.html`; it uses no display CustomApp manifest. All JavaScript and CSS are inline, so its opaque iframe does not depend on ES module asset CORS or external fonts. The ZIP builder is a development dependency and is not shipped inside the app.

The corresponding CMS host/backend feature must be deployed. A customer-owned example requires an actual non-ADMIN account belonging to its immutable owning customer: v1 blocks ADMIN and reseller OWNER visiting a member customer's app, but allows the reseller's own-customer apps. Metadata management is unchanged. Platform apps keep normal user authority, including trusted ADMIN launch. Customer selection/View As does not change the account identity or narrow its token; real customer preview is a separate follow-up. Opening the HTML directly displays connection instructions rather than starting OAuth. A successful local build and protocol tests do not establish production deployment or a provider's iframe support.

For a local protocol preview, run `npm run dev:embedded` and open `http://127.0.0.1:8747`. The explicitly synthetic host serves a real opaque iframe, an API fixture and 37 synthetic screens. Click Open app to receive its declaration, then approve or decline in the parent. The parent supplies no identity/API results before approval, owns its synthetic bearer and performs HTTP requests without exposing it to the iframe. Its controls exercise permission approval, a 401/parent renewal, reload, disable and logout. It is an integration fixture, not the production CMS implementation or a Wallboard authentication server.

See [embedded authentication](../../docs/authentication.md#embedded-cms-session) for the approved-operation boundary, host-managed authentication and separate application-backend authentication requirements. Adapt the source here for your own workflow. This example performs no Wallboard writes and stores no credentials or application data.
