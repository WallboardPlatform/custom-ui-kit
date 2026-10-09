# Wallboard Custom UI Kit

Build your own Wallboard-connected web application. End customers and partners use the same integration: users sign in with their Wallboard accounts, and Wallboard enforces their existing API permissions.

Use the framework-independent browser core with any frontend, the optional Vue components for a quicker start, or the backend validator when your app has its own database. Host the result wherever its runtime requirements are supported.

## Start

Requires Node 22.13+. Browser-only applications use standard Web APIs; the optional SQLite example uses Node's experimental SQLite module.

```sh
git clone https://github.com/WallboardPlatform/custom-ui-kit.git
cd custom-ui-kit
npm ci
npm run check
npm run dev:vue
```

Open `http://localhost:8745`, enter your Wallboard server URL, and sign in. Visit `http://localhost:8745/?demo=1` to inspect the Vue screen with explicitly synthetic data. `npm run dev:vanilla` opens the framework-independent example on port 8746. Both use read-only device queries.

For a standalone project with an editable, vendored SDK:

```sh
npm run build
npm run new-app -- vue ../my-wallboard-ui
cd ../my-wallboard-ui
npm install
npm run dev
```

Choose `vanilla` instead of `vue` for plain TypeScript. The generator refuses an existing destination. It copies source, licence, and built SDK into the new app, so no published npm package is required. There is no npm registry release yet.

## Included source

| Path | Purpose |
| --- | --- |
| `src/browser` | OAuth discovery and registration, PKCE, callback state, tab-local sessions, coordinated rotating refresh |
| `src/api` | Authenticated requests, explicit customer scope, WBQL, typed common entities, pagination and media helpers |
| `src/vue` | Optional reactive adapter, sign-in gate, customer selector, app frame, loading/error/empty states, connectivity, async loading |
| `src/backend` | Online identity validation against a configured Wallboard server, customer scope and application permission helpers |
| `examples/vue-device-board` | Read-only device overview, including signed-out, selected-customer, loading, empty and error states |
| `examples/vanilla-device-board` | The same integration without a UI framework |
| `examples/node-notes` | Backend with SQLite and user/customer-isolated application records; writes are explicitly opt-in |
| `guide/custom-ui-guide.json` | Canonical, versioned authoring guide consumed by the Wallboard MCP server |

Import browser/API modules from `@wallboard/custom-ui-kit`, backend modules from `@wallboard/custom-ui-kit/backend`, and the optional adapter from `@wallboard/custom-ui-kit/vue`. The examples resolve these names to local source; generated apps use their vendored package.

```ts
import { createWallboardClient, WB, type WbDevice, type WbPage } from '@wallboard/custom-ui-kit';

const client = createWallboardClient({ serverUrl: 'https://your-wallboard.example' });
await client.initialize();
// Render a sign-in button that calls client.signIn() when anonymous.
const user = client.getState().user;
if (user?.customerId) {
  const devices = await client.api.forCustomer(user.customerId).get<WbPage<WbDevice>>(WB.device, {
    query: { page: 0, size: 20, select: 'id,name,deviceStatus' },
  });
}
```

## Integration guides

- [Authentication and runtime identity](docs/authentication.md)
- [API, data and database patterns](docs/data.md)
- [Hosting and embedding](docs/hosting.md)
- [AI authoring workflow](docs/authoring.md)
- [Backend/database example](examples/node-notes/README.md)

API field and operation details remain authoritative in the [Wallboard API reference](https://docs.wallboard.us/api-reference/). Use the connected MCP's `api_howto` and the target server's `/v3/api-docs` to verify operations instead of guessing endpoints from UI labels. Common typed entities here describe selected fields, not the complete server schema.

## Verification and boundaries

`npm run check` runs the TypeScript/Vue check, synthetic unit/integration tests, SDK build, and both browser example bundles. The backend tests exercise real local SQLite ownership boundaries with a mocked Wallboard identity service. Browser OAuth tests mock HTTP and storage; passing them does not establish deployed OAuth, provider hosting, or iframe compatibility.

The app owner supplies hosting, an allowed OAuth redirect, and any database or backend secrets. Generated source contains no builder/MCP token. Standalone login is implemented; iframe login handoff and a configurable CMS Custom UI menu are separate integrations. Database permissions belong to the application. No public app catalogue, customer-specific configuration, or private application source is included.

The reusable kit is MIT-licensed. Its browser auth/API patterns originate in Wallboard's Custom UI framework; customer applications retain their own source and release lifecycle.
