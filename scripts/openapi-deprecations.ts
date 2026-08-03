const V3_DEPENDENT_OPERATIONS = new Set([
  "GET /api/public/traces",
  "POST /api/public/traces",
  "GET /api/public/traces/{traceId}",
  "GET /api/public/observations",
  "GET /api/public/observations/{observationId}",
  "POST /api/public/events",
  "POST /api/public/generations",
  "PATCH /api/public/generations",
  "POST /api/public/spans",
  "PATCH /api/public/spans",
  "GET /api/public/sessions",
  "GET /api/public/sessions/{sessionId}",
  "GET /api/public/scores",
  "GET /api/public/scores/{scoreId}",
  "GET /api/public/v2/scores",
  "GET /api/public/v2/scores/{scoreId}",
  "GET /api/public/metrics",
  "GET /api/public/metrics/daily",
  "POST /api/public/dataset-run-items",
  "GET /api/public/dataset-run-items",
  "GET /api/public/datasets/{datasetName}/runs",
  "GET /api/public/datasets/{datasetName}/runs/{runName}",
  "DELETE /api/public/datasets/{datasetName}/runs/{runName}",
]);

export function isV3DependentOperation(path: string, method: string) {
  return V3_DEPENDENT_OPERATIONS.has(`${method.toUpperCase()} ${path}`);
}
