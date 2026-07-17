/*
Purpose: define a disposable read-optimization cache boundary.
Responsibilities: read, write, and invalidate serialized endpoint representations with TTLs.
Connections: endpoint service uses this before repositories; Redis later implements it.
Future: stampede protection, tag invalidation, compression, and cache metrics.
Best practice: cache misses and outages must fall back safely to durable storage.
*/

export interface CacheStore { get<T>(key: string): Promise<T | null>; set<T>(key: string, value: T, ttlSeconds: number): Promise<void>; delete(key: string): Promise<void>; }

