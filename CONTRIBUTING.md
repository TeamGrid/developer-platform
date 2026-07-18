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
types together. Do not commit credentials, customer data, or generated package
archives. By contributing, you agree that your contribution is licensed under
the MIT License.
