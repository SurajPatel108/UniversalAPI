/*
Purpose: assemble the HTTP application without starting a network listener.
Responsibilities: register middleware, versioned routes, error mapping, and dependency-injected handlers.
Connections: server entry point starts it; routes register against the selected framework.
Future: Fastify instance, authentication, rate limits, OpenAPI, correlation IDs, and health checks.
Best practice: app construction should be deterministic so integration tests can use it in memory.
*/

export interface ApiApplication { /* Framework-specific type will be introduced in Phase 1. */ }

