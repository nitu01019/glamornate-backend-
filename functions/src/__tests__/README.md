# Backend Test Fixture Conventions

## Reserved test ranges
- Email: `@glamornate.test` (RFC 2606) or `@example.com`
- Phone: `+91 90000 00xxx` (E.164 reserved)
- Names: Generic synthetic ("Test User", "QA Customer")
- UIDs: `test-uid-1`, etc., or Firebase emulator-generated

## Bank/payment fixtures
Bank account placeholders prefixed with `TEST-` (e.g., `TEST-XXXX1234`,
`TEST-SBIN0001234`) to make their fictional nature obvious.

## Why
Same as frontend — see `frontend/src/__tests__/README.md` for full rationale.
