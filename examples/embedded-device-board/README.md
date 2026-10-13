# Embedded Fleet Overview

A read-only Custom UI for the CMS My Apps menu. It uses the host's current user access token, verifies `/api/v2/user/me`, and reads paginated devices for the selected customer. Search/status filters apply to the currently loaded page; the counters describe that page, not the entire fleet. Device/customer/user text is rendered as text, never HTML.

From the repository root:

```sh
npm ci
npm run build:embedded
```

The build produces `dist/examples/embedded/index.html` and `dist/examples/embedded/fleet-overview.zip`. Upload the ZIP to an HTML Bundle Custom UI, then open it from My Apps. The archive has a regular root `index.html`; it uses no display CustomApp manifest. All JavaScript and CSS are inline, so its opaque iframe does not depend on ES module asset CORS or external fonts. The ZIP builder is a development dependency and is not shipped inside the app.

The corresponding CMS host/backend feature must be deployed. A customer-owned example must be opened with a genuine customer-user session: v1 blocks global ADMIN launch for customer-owned apps, while platform apps remain eligible for trusted ADMIN launch. Customer selection/View As does not narrow the token; real customer preview is a separate follow-up. Opening the HTML directly displays connection instructions rather than starting OAuth. A successful local build and protocol tests do not establish production deployment or a provider's iframe support.

For a local protocol preview, run `npm run dev:embedded` and open `http://127.0.0.1:8747`. The explicitly synthetic host serves a real opaque iframe, bearer-authenticated HTTP fixture and 37 synthetic screens. Its controls exercise a 401/host renewal, reload, disable and logout. It is an integration fixture, not the production CMS implementation or a Wallboard authentication server.

See [embedded authentication](../../docs/authentication.md#embedded-cms-session) for the trust boundary, host token renewal and application-owned backend authorization. Adapt the source here for your own workflow. This example performs no Wallboard writes and stores no credentials or application data.
