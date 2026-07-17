/*
Purpose: verify the HTTP contract for source creation and retrieval.
Responsibilities: boot the application in-memory and assert JSON responses and status codes.
Connections: these tests cover the route boundary and the Fastify integration layer.
Future: add auth, validation, and error cases as the API grows.
Best practice: keep the tests realistic by using the actual app setup rather than isolated mocks.
*/

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";

describe("sources API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("creates and retrieves a source", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/sources",
      payload: { sourceType: "website", url: "https://example.com/products" }
    });

    expect(createResponse.statusCode).toBe(201);
    const payload = JSON.parse(createResponse.body);
    expect(payload.id).toBeTruthy();
    expect(payload.status).toBe("draft");

    const getResponse = await app.inject({
      method: "GET",
      url: `/v1/sources/${payload.id}`
    });

    expect(getResponse.statusCode).toBe(200);
    const fetched = JSON.parse(getResponse.body);
    expect(fetched.id).toBe(payload.id);
  });

  it("returns a 400 response for invalid input", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/sources",
      payload: { sourceType: "website", url: "not-a-url" }
    });

    expect(response.statusCode).toBe(400);
  });
});
