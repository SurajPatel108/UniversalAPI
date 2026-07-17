/*
Purpose: expose stable, customer-facing data endpoints separate from administrative source routes.
Responsibilities: map a public slug to EndpointService and serialize the published normalized JSON.
Connections: api/app registers it; EndpointService uses cache and durable versions.
Future: GET /v1/data/:slug, auth scopes, query filtering, pagination, and conditional GET support.
Best practice: keep endpoint URLs stable even when extraction definitions and versions evolve.
*/

export const generatedEndpointPrefix = "/v1/data";

