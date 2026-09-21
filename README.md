# Coordinator sample frontend

Small executable programs, locked npm builds, short-lived GitHub Actions artifacts and temporary test services for the sandbox only. No product credentials, environments or deployments are used.

The repository also exposes the Coordinator-facing workflow contract used by the real frontend:

- `deploy-staging.yml` and `build-upload-deploy-prod.yml` keep the real workflow names, entry branches, inputs and concurrency groups.
- The staging and production E2E dispatch workflows pass the exact successful deploy run ID to their matching E2E workflow.
- Deploy jobs publish `fake-deployment-evidence-v1` artifacts. E2E reads the artifact from that exact run, verifies its source commit, and executes the built sample frontend.

These workflows are a safe interface mirror, not a product deployment. They do not use AWS, the real website, product secrets, or the real E2E suites. The daily production canary schedule is intentionally not mirrored because the Coordinator does not dispatch or depend on it. The older `sandbox-release.yml` remains available while the Coordinator is taught to use the mirrored interface.

The coordinator directory is generated from the standalone Coordinator; edit the source project and republish the bundle instead of maintaining a second implementation.
