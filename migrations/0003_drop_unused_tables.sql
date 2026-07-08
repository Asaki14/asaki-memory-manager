-- projects, memory_sources, and api_keys were never referenced by application code.
-- api_keys implied per-user auth that was never built; the project is a single-operator
-- personal tool (single shared ADMIN_API_KEY), so per-user auth isn't planned either.
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS memory_sources;
DROP TABLE IF EXISTS projects;
