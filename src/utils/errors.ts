// Marker for service-layer errors whose message is intentionally user-facing (validation-style
// failures like "Review not found." or "project_id is required when scope is project."). Route
// handlers only forward these messages to the client; any other thrown error must fall through
// to the generic 500 handler so internal D1/Vectorize error text never leaks in a response.
export class UserFacingError extends Error {}
