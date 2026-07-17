/*
Purpose: select a Connector implementation without leaking source-specific conditionals into services or workers.
Responsibilities: register connectors at composition time and resolve one from a SourceType.
Connections: core/container assembles this registry; RefreshSourceWorker uses it for every refresh.
Future: plugin discovery, tenant connector entitlements, and connector health checks.
Best practice: fail explicitly for unsupported types; never use a default connector for unrecognized source configuration.
*/

import type { Connector } from "./connector.js";
import type { SourceType } from "../models/source.js";

export interface ConnectorRegistry { get(sourceType: SourceType): Connector; }

