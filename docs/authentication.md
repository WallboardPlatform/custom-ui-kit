# Authentication

Create one browser client per application/server and call `initialize()` before using its session. Subscribe to its state to render signed-out, checking, authenticated and error states. Standalone `state.user` comes from authenticated `GET /api/v2/user/me`; embedded `state.user` comes from the trusted CMS host's verified session profile. Decoded standalone JWT display hints never establish authorization.

## Browser flow

The client discovers the configured server's OAuth endpoints. Supply a registered public `clientId`, or let the client request Dynamic Client Registration when the server advertises it. DCR can be restricted or unavailable; in that case register a client in the Wallboard UI and configure its exact redirect URI. No confidential client secret belongs in browser code.

`signIn()` generates state and PKCE, stores a one-use transaction, and navigates to authorization. The callback validates the transaction and redirect, removes OAuth parameters from the browser address, exchanges the code, and reads the verified user profile. Redirects default to the application's origin; deploy its entrypoint there or provide an explicitly registered callback URL that runs this client. Any route saved for return navigation stays within the application's origin.

Sessions use tab-local `sessionStorage` by default. Refresh tokens rotate, so `getToken()` coordinates one in-flight refresh per client. Avoid creating competing clients for the same stored session, or injecting shared cross-tab token storage without cross-tab refresh coordination. `signOut()` clears local credentials; use the application's explicit server logout policy where server-side revocation is required.

The default requests a short refresh session (`keepSignedIn: false`). The application can explicitly offer a longer session through the client's sign-in option. Expired, rejected or unreadable storage must produce a sign-in/error state, not silently bypass callback checks.

## Embedded CMS session

```ts
import { createEmbeddedWallboardClient, WB, type WbDevice, type WbPage } from '@wallboard/custom-ui-kit';

const client = createEmbeddedWallboardClient();
await client.initialize();
const devices = await client.api.get<WbPage<WbDevice>>(WB.device, {
  query: { page: 0, size: 20, select: 'id,name,deviceStatus' },
});
```

Use this adapter for a Custom UI launched from the compatible CMS My Apps host. The host supplies its exact origin and one-use launch nonce in bootstrap query parameters. The child creates one MessageChannel and transfers a port to that origin. Protocol version 2 sends verified user/context information and JSON API requests/results over that port. The CMS performs the authenticated request itself; the iframe receives no Wallboard access or refresh token, opens no OAuth flow, reads no browser storage and performs no direct Wallboard fetch. `getToken()` rejects with `API_PROXY_ONLY`; `signIn()` is unavailable. `signOut()`/`dispose()` close only this app connection and cancel pending requests. A version 1 token host/client is incompatible: upgrade both the host and embedded SDK, with no token fallback.

`getContext()` identifies the launched app, selected customer, registered `apiPermissions`, effective `readOnly` mode and verified account. `state.customerId` and ordinary API request defaults use that selection, while `state.user` remains the actual account identity and `state.displayIdentity` is null. Explicit customer or instance requests still follow the API client's existing scope rules and backend permissions. The proxy limits methods/endpoints, not the resources the actual account can access through them. Closing/removing the app stops new operations and cancels pending requests; cancellation cannot undo a write already executed by the backend.

Register each method and path template the app calls, for example `{ "method": "GET", "path": "/api/v2/device", "description": "Read devices" }`. `PUT` on the same path is a separate permission. At most 128 declarations are accepted; paths are canonical `/api/` paths of at most 2048 characters with a literal first resource segment and subsequent literal or complete `{identifier}` segments. Descriptions are optional and at most 500 characters. Duplicate method/path pairs, wildcards, regex, encoded aliases, query strings and external origins are not permission templates. Pass query values in `options.query`; the proxy accepts JSON bodies and GET/POST/PUT/PATCH/DELETE, without app-supplied headers. `raw()` reconstructs a Response with status, body and content type; arbitrary headers, binary streaming and file uploads are outside this embedded transport.

The CMS shows the complete declaration before loading the app, and its proxy stays disabled until the user approves it. Undeclared operations fail even if the user's normal API permissions allow them. Changed declarations/source require renewed approval. The app cannot enlarge its permissions through the message channel. Host-owned authentication/elevation operations are unavailable, and the proxy does not silently use an existing temporary elevated CMS credential.

Read-only is the intersection of account, host-forced and app-declared restrictions: any read-only flag locks that launch to read-only. An app registered with `readOnly: true` has no write-mode switch. GET is allowed except known mutating/authentication GET routes; the exact read POST exceptions are `/api/deviceStat/{deviceId}/graphs` and `/api/v2/device/requestLog`, which must still be declared and approved. Diagnostic-log collection triggers device activity and should be explained in the permission description. The SDK guards obvious writes, but the CMS independently enforces the current declaration and mode on every request.

In v1, `CUSTOMER` apps require an actual authenticated non-ADMIN account belonging to the app's immutable owning customer, for both hosted URLs and uploaded bundles. The backend compares the ordinary signed JWT's own customer ID with the stored owner. ADMIN and reseller/network OWNER visiting a member customer's app receive 403; a reseller OWNER can launch its own customer's apps with its normal API authority. Metadata management keeps its existing permissions. `PLATFORM` apps retain the current user's normal authority, including explicitly trusted ADMIN launches. Customer selection and frontend View As do not change the account identity or downscope its token; impersonation preview cannot launch embedded apps. A real backend customer-preview/delegation session is a separate step 2, not an available v1 login mode.

An embedded app cannot forward a host Wallboard JWT to its own backend. Such a backend, background jobs and database access need a separate explicit authentication design; host profile fields forwarded by the iframe are not backend proof of identity. Standalone OAuth apps can use their own token with the validator below. Never write tokens to URLs, logs, source or persistent application records. An opaque iframe's `null` origin is not identity and cannot prove the final hosted provider origin.

## Application backend

```ts
import { createWallboardValidator, parseBearerToken, resolveCustomerScope } from '@wallboard/custom-ui-kit/backend';

const validator = createWallboardValidator({ serverUrl: process.env.WB_SERVER_URL! });
const identity = await validator.validate(parseBearerToken(request.headers.authorization));
const scope = resolveCustomerScope(identity);
```

Configure trusted Wallboard origins on the backend. A caller cannot select an arbitrary verification server. The online validator calls `/api/v2/user/me` without following redirects or caching identity, rejects malformed identity responses, and applies a timeout. Its read-only flag combines the authoritative account flag with a restrictive claim from the exact token accepted upstream. It never uses an unverified claim to grant identity or privileges.

For application records, enforce access using the verified server, customer and user. Global administrators need an explicit application-owned customer policy; a valid Wallboard administrator token alone grants no database access in the example. See the notes example for SQL ownership predicates and an explicit write policy.

The current backend adapter accepts bearer tokens on each request. It is not a cookie-session OAuth BFF. Add a complete callback/session/CSRF/logout lifecycle if server-side token custody is required.

## Local JWT verification

Wallboard exposes `/.well-known/jwks.json`. The kit's shipped backend validator uses online validation so the target server applies its current token and revocation policy. Standardizing the public key representation is a separate backend change. An offline validator also needs an explicit trusted-key, issuer, audience, expiry, key-refresh and revocation policy. Do not infer the JWT issuer from metadata or assume a resource audience survives refresh on every deployed version.
