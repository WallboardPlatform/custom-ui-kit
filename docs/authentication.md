# Authentication

Create one browser client per application/server and call `initialize()` before using its session. Subscribe to its state to render signed-out, checking, authenticated and error states. `state.user` is obtained from `GET /api/v2/user/me`; decoded JWT display hints never establish authorization.

## Browser flow

The client discovers the configured server's OAuth endpoints. Supply a registered public `clientId`, or let the client request Dynamic Client Registration when the server advertises it. DCR can be restricted or unavailable; in that case register a client in the Wallboard UI and configure its exact redirect URI. No confidential client secret belongs in browser code.

`signIn()` generates state and PKCE, stores a one-use transaction, and navigates to authorization. The callback validates the transaction and redirect, removes OAuth parameters from the browser address, exchanges the code, and reads the verified user profile. Redirects default to the application's origin; deploy its entrypoint there or provide an explicitly registered callback URL that runs this client. Any route saved for return navigation stays within the application's origin.

Sessions use tab-local `sessionStorage` by default. Refresh tokens rotate, so `getToken()` coordinates one in-flight refresh per client. Avoid creating competing clients for the same stored session, or injecting shared cross-tab token storage without cross-tab refresh coordination. `signOut()` clears local credentials; use the application's explicit server logout policy where server-side revocation is required.

The default requests a short refresh session (`keepSignedIn: false`). The application can explicitly offer a longer session through the client's sign-in option. Expired, rejected or unreadable storage must produce a sign-in/error state, not silently bypass callback checks.

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
