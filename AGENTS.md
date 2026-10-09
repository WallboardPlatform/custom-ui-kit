# Custom UI kit agent contract

This public repository contains reusable integration code and synthetic examples for end customers and partners. Read README.md and the relevant document under docs before editing. Preserve private customer source, credentials, identifiers, and configuration outside this repository.

## Runtime and ownership

The browser core is framework independent. Vue is an optional adapter. Applications own their frontend, backend, database, hosting, and access rules. MCP supplies the authoring guide and existing API knowledge; it does not host applications or pass the builder's credentials into generated apps.

## Verification

Run `npm ci`, then `npm run check`. Test risky authentication, refresh, tenant, and database boundaries with synthetic fixtures. Read the authoritative Wallboard API schema/controller before adding an endpoint or write. Do not perform live writes unless explicitly requested against designated test records.

Only verified API responses establish backend identity. Decoded browser JWT claims are display hints. Keep customer selection explicit for global administrators; backend permissions remain authoritative.

## Source of truth

`guide/custom-ui-guide.json` owns the sectioned MCP authoring contract. The MCP server consumes a pinned, generated snapshot; update it through its sync script. API endpoint documentation stays in Wallboard's existing API reference. Link to it; avoid another endpoint catalogue.

Keep core implementation and reusable examples here. Add provider instructions only after testing the stated provider behavior. Distinguish a local build from deployed authentication and embedding.

## Git

Use a branch and pull request from the current remote main. Keep existing work intact. Publishing a package to npm is separate from committing source and is not part of routine changes.
