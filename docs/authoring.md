# AI authoring workflow

For end customers and partners, begin with purpose, actors, read/write operations, customer scope, brand, target device/surface, and source/deployment ownership. The builder can use any technology compatible with the verified OAuth/REST contract. Framework/provider choice is an application decision.

Use the Wallboard MCP `custom_ui_guide` for this repository and its pinned contract version. Clone the specified revision, read AGENTS.md and the relevant docs, install dependencies, and inspect the example that matches the runtime. The kit offers reusable code; examples demonstrate mechanics and an editable fallback style.

Before customer API work, call `get_current_user`, obtain endpoint contracts through `api_howto`, and resolve customer/branding inputs through the ordinary authorized tools. These authoring credentials remain in the builder session. Runtime users sign in through the generated application's own OAuth flow.

Prefer a browser app when it only calls Wallboard. Add a backend and database for application-owned records, server-side jobs, or credentials. Choose the data ownership/access policy before writing database queries. Confirm consequential runtime writes with the app owner and verify their API contract.

Deliver editable source, the exact kit revision, startup/build commands, configuration placeholders, validation results, and the preview/deployed URL when actually available. Identify which login, hosting, database durability and iframe behaviors were empirically verified. Keep synthetic fixtures separate from customer data and never include tokens, private customer apps, or private server registries in source.

The canonical structured contract is [guide/custom-ui-guide.json](../guide/custom-ui-guide.json). The MCP server's sync script snapshots a committed revision into its source tree with provenance; change the contract here rather than maintaining two authored copies.
