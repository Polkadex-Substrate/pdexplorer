# Development workflow

All behavior changes in this repository must use strict test-driven development.
This applies to features, bug fixes, and behavior-changing refactors.

## Required cycle

1. **Red:** Write a focused test for the requested behavior or regression before
   changing its implementation. Run it against the existing code and observe the
   failure. Check that the failure demonstrates the missing or incorrect behavior;
   missing dependencies, permissions, and unrelated setup errors do not count.
   For a new API, add only the minimal declarations needed to reach a meaningful
   failing assertion before implementing its behavior.
2. **Green:** Make the smallest production change that passes that test. Run the
   test again and confirm it passes. Repeat this cycle for each additional behavior.
3. **Refactor:** Improve the implementation only while its tests pass. Rerun the
   affected tests after refactoring. Add a failing test first if the refactor reveals
   another behavior that needs to change.
4. **Verify:** Run the relevant integration and regression tests, then the full
   suite and production build for behavior changes. Preserve the existing CI gates.

## Test quality

- Assert observable behavior. Prefer real codecs, builders, and transaction
  lifecycle helpers where practical; mock external I/O and wallet signing.
- Cover relevant failures and asynchronous races, especially account/network
  changes, confirmation changes, and multisig approval versus execution.
- Never submit real transactions as part of automated tests.
- Do not weaken assertions, swallow failures, or skip required tests to make a
  change pass. Update an old expectation only when an intentional behavior change
  requires it, with tests that demonstrate the new behavior.
- Do not call tests added after an implementation evidence of a test-first process.
- Documentation-only and formatting-only changes do not need artificial tests.

## Commands and evidence

Use Node 22 and install the lockfile dependencies with `npm ci` when needed.

```sh
node --experimental-sqlite --test test/council-candidacy.test.js
npm test
npm run build
```

Replace the focused test file with the file relevant to the change. Record the
failing command and relevant failure, the passing command and result, and remaining
validation limits in the PR description or completion report. Do not commit a
deliberately failing final state merely to demonstrate the red step.

If a required test cannot run, resolve the setup problem before implementing the
behavior it must prove. Report any broader checks blocked by the environment as
blocked. A passing subset or JavaScript bundle check does not establish that the
full suite or production build passes.
