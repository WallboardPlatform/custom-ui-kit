# API and application data

Use `client.api.forCustomer(customerId)` for customer-owned resources. Generic requests require a customer scope or deliberate `instance: true`; singleton identity calls are an exception. Never use instance-wide queries merely to avoid selecting a customer. The server still enforces customer, team, role and read-only restrictions.

Pass query parameters in `options.query`, request bodies in `options.body`, and an `AbortSignal` when a result can be superseded. The transport obtains fresh tokens, performs a bounded refresh on 401, and never replays an uncertain write as a network retry. A 403 should be shown as a permission error.

The typed routes and entity subsets are conveniences verified from the Wallboard API. For additional endpoints, inspect the target server schema and the existing MCP `api_howto`. Verify request replacement/cascade behavior before implementing a write. Use the narrowest operation and test against designated records.

## Helpers and UI

The framework-independent API module provides WBQL construction, common entity types, pagination and media handling. The Vue adapter provides `useAsyncData()` with cancellation and stale-response suppression, plus sign-in/customer/data-state gates. The two device-board examples show the same read-only integration in Vue and plain TypeScript.

Keep customer changes observable: abort or discard requests for a previous customer, clear its results immediately, then load the newly selected scope. Show loading, empty, error and forbidden states. Choose customer branding deliberately; the starter's theme is an editable fallback.

## Own database

An application backend may use any supported database. Store application-owned workflow state there; call the ordinary Wallboard APIs for Wallboard operations. A separate database does not inherit Wallboard permissions automatically.

The runnable [notes example](../examples/node-notes/README.md) uses parameterized SQLite queries and three ownership dimensions: configured Wallboard server, customer, and user. It proves that knowing another note ID does not grant access. Writes are disabled until enabled by application configuration and still honor its example role/read-only policy.

Adapt ownership to the domain: team-shared approval requests need a deliberate team policy; user-private notes use a user predicate. Validate all external identifiers and keep tokens and provider credentials out of stored records. Provider-managed SQL can replace SQLite without changing the browser connection contract.
