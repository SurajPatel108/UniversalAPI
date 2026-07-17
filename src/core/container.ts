/*
Purpose: be the composition root for dependency injection.
Responsibilities: choose concrete database, cache, queue, crawler, and service adapters for one process.
Connections: entry points call this module; feature code receives interfaces, never resolves global dependencies.
Future: construct production and test containers with lifecycle hooks.
Best practice: keep wiring centralized; do not use service locators inside domain code.
*/

export interface ApplicationContainer {
  // Add named ports/services here once their concrete adapters are implemented.
}

