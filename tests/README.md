# Test strategy

Keep tests close to behavior, not framework internals. Unit-test services and normalizers with fake ports; contract-test each adapter against its interface; integration-test the HTTP/queue/database composition; store redacted crawl/parser fixtures under `tests/fixtures`; and add end-to-end refresh-to-endpoint cases once Phase 5 exists. Test retries, idempotency, cache misses, and malformed upstream pages as first-class paths.

