# Authentication

Create one browser client per application/server and call `initialize()` before using its session. Subscribe to its state to render signed-out, checking, authenticated and error states. `state.user` is obtained from `GET /api/v2/user/me`; decoded JWT display hints never establish authorization.

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

Use this adapter for a Custom UI launched from the compatible CMS My Apps host. The host supplies its exact origin and one-use launch nonce in bootstrap query parameters. The child creates one MessageChannel and transfers a port to that origin; all token requests/replies then use the accepted port. The adapter keeps credentials only in memory, verifies the user through `/api/v2/user/me`, coalesces renewal requests, and asks the host again near expiry or after a 401. It never reads browser storage, performs OAuth, or receives the CMS refresh token. `signIn()` is unavailable; `signOut()`/`dispose()` close only this app connection.

`getContext()` identifies the launched app and selected customer. `state.customerId` and ordinary API request defaults use that selection, while `state.user` remains the verified account identity. Explicit customer or instance requests still follow the existing API client's rules. The host context does not downscope the supplied JWT: this is a trusted alternate frontend with the user's normal API permissions, including global administrator authority. Closing/removing the app stops further handoffs; a copied access token retains normal validity. Do not promise app-specific revocation or a separate token lifetime.

In v1, `CUSTOMER` apps require an actual authenticated non-ADMIN account belonging to the app's immutable owning customer, for both hosted URLs and uploaded bundles. The backend compares the ordinary signed JWT's own customer ID with the stored owner. ADMIN and reseller/network OWNER visiting a member customer's app receive 403; a reseller OWNER can launch its own customer's apps with its normal API authority. Metadata management keeps its existing permissions. `PLATFORM` apps retain the current user's normal authority, including explicitly trusted ADMIN launches. Customer selection and frontend View As do not change the account identity or downscope its token; impersonation preview cannot launch embedded apps. A real backend customer-preview/delegation session is a separate step 2, not an available v1 login mode.

The application may send `await client.getToken()` as a bearer to its own configured backend. Use the same online validator below and enforce database ownership there; a selected customer supplied by the browser is not an authorization grant. Never write tokens to URLs, logs, source or persistent application records. An opaque iframe's `null` origin is not identity and cannot prove the final hosted provider origin.

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
