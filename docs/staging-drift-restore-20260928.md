# Staging drift restoration acceptance fixture

This documentation-only change is the frontend release candidate for a sandbox
Coordinator ticket. It changes no sample application or database behavior.

The acceptance test will merge an unrelated backend documentation change into
test staging while frontend staging E2E is running. The operator will then
choose restoration of this ticket's frontend staging change.
