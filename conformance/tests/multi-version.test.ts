import { describe, expect, test } from "bun:test";

import { loadCatalog } from "../src/catalog";
import { generateCorpus } from "../src/generator";
import { runConformance } from "../src/runner";

const CURRENT_CLI_UNSUPPORTED_OPERATIONS = new Set([
  "annotationQueues_createQueue",
  "datasetItems_create",
  "datasetRunItems_create",
  "datasets_create",
  "ingestion_batch",
  "legacy_scoreV1_create",
  "models_create",
  "opentelemetry_exportTraces",
  "promptVersion_update",
  "prompts_create",
  "scim_createUser",
  "score_create",
  "scores_create",
  "trace_deleteMultiple",
  "unstable_dashboardWidgets_create",
  "unstable_dashboards_addPlacement",
  "unstable_dashboards_create",
  "unstable_evaluationRules_create",
  "unstable_evaluators_create",
]);

describe("multi-version black-box matrix", () => {
  test("fake-calls every endpoint through the real CLI", async () => {
    const catalog = await loadCatalog();
    await Promise.all(catalog.versions.map(async (entry) => {
      const corpus = await generateCorpus(entry);
      const vectors = corpus.vectors;
      expect(vectors).toHaveLength(corpus.compiled.manifest.operations.length);
      const results = await runConformance({
        entry,
        manifest: corpus.compiled.manifest,
        vectors,
        adapter: "specli-v0",
        currentCli: true,
        quiet: true,
      });
      expect(results).toHaveLength(vectors.length);

      const expectedFailures = vectors
        .filter((vector) =>
          CURRENT_CLI_UNSUPPORTED_OPERATIONS.has(vector.operationId ?? ""),
        )
        .map((vector) => vector.id);
      const actualFailures = results
        .filter((result) => !result.passed)
        .map((result) => result.id);
      expect(actualFailures, entry.ref).toEqual(expectedFailures);
    }));
  }, 120_000);
});
