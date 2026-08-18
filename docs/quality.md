# Quality and release gates

GAOS treats a passing test suite as necessary but not sufficient release
evidence. A release candidate must satisfy the automated gates below and the
human compatibility checklist before publication.

## Automated pull-request gates

The protected `main` branch requires the current commit to pass:

- TypeScript tests, type checking, architecture checks, deterministic evidence,
  build, and package inspection on Node.js 20.3 and 22;
- Python tests, branch coverage, and package builds on Python 3.10 and 3.12;
- deterministic-math checks in Chromium, Firefox, WebKit, and workerd;
- TypeScript line, branch, function, and statement coverage thresholds; and
- install-from-archive smoke tests on Linux, macOS, and Windows.

Coverage thresholds are checked into the repository. They are baseline floors,
not targets: pull requests must not lower them, and releases should raise them
when new tests make a higher floor sustainable.

`npm run api:check` compares every TypeScript package entry point with the
reviewed reports in `etc/api/`. Any declaration drift fails pull-request and
release CI. Run `npm run api:update` only when an intentional compatibility
change has been reviewed.

## Mutation testing

`npm run test:mutation` uses Stryker against deterministic randomness,
commitment, settlement, and submission-signature code. The measured baseline is
64; a score below 63 fails to allow one point of timing variance from timeout
classification. This floor must only move upward, and the first ratchet target
is a stable 65, with particular attention to surviving signature verification
mutants. The weekly mutation workflow retains the detailed report as a build
artifact.

Python mutation testing uses mutmut against signature and verifier-kit code.
Run `python -m mutmut run` from the `python/` directory in an environment with
`python[dev]` installed. The measured detected-mutant score is 82.77%; the
weekly workflow fails below 82% and records the statistics so tests can be
added before a release candidate. Artifact mutation and fuzzing remain
separate techniques; they do not substitute for source-code mutation testing.

## v1.0 release-candidate checklist

Record the evidence and named owner for every item in the release pull request.

### Contract freeze

- [ ] The intended v1.0 export surface is captured and reviewed.
- [ ] Deprecated aliases scheduled for v1.0 are removed, with a migration table.
- [ ] RFC-017 through RFC-021 completion tests remain green.
- [ ] Historical replay v1.0–v1.3 retains its documented interpretation, and
      replay v1.4 interaction records, schemas, signatures, and verifier
      semantics remain green.
- [ ] At least one independent product consumer builds and runs its integration
      suite against the exact release-candidate tag.

### Verification

- [ ] Every required `main` check passes on the release-candidate tag.
- [ ] TypeScript and Python coverage do not regress from the previous release.
- [ ] The TypeScript mutation gate passes.
- [ ] The latest Python mutation report has no unexplained high-risk survivors.
- [ ] Security-sensitive negative paths—malformed artifacts, stale authority,
      invalid signatures, traversal, resource limits, and interrupted durable
      sessions—are explicitly exercised.
- [ ] Benchmark and long-session results show no accepted performance or memory
      regression outside the documented budget.

### Packaging and operations

- [ ] TypeScript and Python versions match the annotated tag.
- [ ] npm, wheel, and source archives install in clean environments.
- [ ] Release notes, migration guidance, supported runtimes, and known issues
      are complete.
- [ ] Rollback owners have confirmed how to deprecate the package, mark the
      GitHub release, and publish a corrective version without moving the tag.
- [ ] The release owner and one compatibility reviewer record GO.

## Publication

1. Merge the release pull request after all required checks pass.
2. Create and push the annotated release tag.
3. Create a GitHub **draft** release for that tag.
4. Confirm the tag's SDK CI and latest scheduled mutation workflow are green.
5. Run **Publish SDK release** with the draft tag.

The publication workflow re-runs coverage, mutation, cross-runtime,
documentation, package, and Python checks before it publishes packages,
uploads archives, and makes the GitHub release public. A failed validation
leaves the release as a draft.

Tags are immutable release evidence. Correct a bad candidate or release with a
new version; do not move a published tag.
