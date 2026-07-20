# Contributing

Thank you for helping improve the TeamGrid Developer Platform.

Before opening a pull request:

```sh
cd developer-platform
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
```

Keep changes focused and update the checked OpenAPI contract and generated
types together. Synchronize a reviewed API commit with:

```sh
cd developer-platform
npm run sync:contracts -- /path/to/teamgrid-api <full-api-commit-sha>
```

The synchronizer reads from the Git object, not the API working tree. Commit
all files under `openapi/`, including `source.json`, together. Do not commit
credentials, customer data, or generated package
archives. By contributing, you agree that your contribution is licensed under
the MIT License.
