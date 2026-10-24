# Runtime image security gate

The final local image is scanned by immutable image ID before any registry push.
The OCI source revision must match the build source. Frozen regional MCP uses
its separate dependency-security build label and preserves the application label.
The pinned Trivy archive and binary are verified by SHA-256. Both advisory
inventories are downloaded before scanning; the vulnerability DB must be less
than 24 hours old. Scan errors, unsupported/EOL operating systems, missing OS or
language result inventories, and empty package reports fail the build.

Library findings at MEDIUM or higher block, including findings without fixes.
OS HIGH/CRITICAL findings with an available vendor fix block. Unfixed vendor OS
findings remain explicitly unresolved in the receipt and require vendor/context
follow-up; a passing build does not mean zero vulnerabilities. There is no blanket
ignore list. No Docker Config/ENV is retained in artifacts. The filtered assessment
and CycloneDX inventory are SHA-256-bound in receipt.json. After push, the exact
source-SHA tag is pulled and must resolve to the scanned image ID; the immutable
registry digest is added to the same receipt. CI retains these artifacts 90 days.
Historical scan evidence must remain available in release closeout records.

The Node probe confirms the exact intended runtime and removal of global package
managers from final images. Build stages retain npm. Changes to native dependencies
or runtime user still require real image smoke tests and Staging qualification.

The old Node-only legacy image remains a CI compatibility fixture; it is no
longer published by new CI runs. Regional DE releases use the separately scanned
legacy-dependency-security image. Existing US runtime identities are unchanged.
