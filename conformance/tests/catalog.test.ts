import { describe, expect, test } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";

import { loadCatalog, readVerifiedSpec, specPath } from "../src/catalog";
import { generateCorpus } from "../src/generator";
import { compareVersions } from "../src/add-version";

describe("immutable OpenAPI catalog", () => {
  test("all pinned snapshots pass SHA-256 verification", async () => {
    const catalog = await loadCatalog();
    const versions = catalog.versions.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort(compareVersions));
    for (const entry of catalog.versions) {
      const raw = await readVerifiedSpec(entry);
      expect(raw.startsWith("openapi: 3.0.")).toBe(true);
      await expect(SwaggerParser.parse(specPath(entry))).resolves.toBeDefined();
      if (entry.knownIssues?.includes("oas3.0-const-keyword")) {
        await expect(SwaggerParser.validate(specPath(entry))).rejects.toThrow(
          "Swagger schema validation failed",
        );
      } else {
        await expect(SwaggerParser.validate(specPath(entry))).resolves.toBeDefined();
      }
      expect(specPath(entry)).toEndWith(
        `conformance/specs/${entry.version}/openapi.yml`,
      );
    }
  });

  test("each operation produces one supported invocation", async () => {
    const catalog = await loadCatalog();
    for (const entry of catalog.versions) {
      const corpus = await generateCorpus(entry);
      expect(corpus.compiled.unsupported).toEqual([]);
      expect(corpus.vectors).toHaveLength(
        corpus.compiled.manifest.operations.length,
      );
      expect(corpus.vectors.length).toBeGreaterThan(0);
      if (entry.version === "4.10.0") {
        expect(
          corpus.compiled.manifest.operations
            .filter((operation) => operation.deprecated)
            .map((operation) => operation.operationId)
            .sort(),
        ).toEqual(
          [
            "datasetRunItems_create",
            "datasetRunItems_list",
            "datasets_deleteRun",
            "datasets_getRun",
            "datasets_getRuns",
            "ingestion_batch",
            "legacy_metricsV1_metrics",
            "legacy_observationsV1_get",
            "legacy_observationsV1_getMany",
            "scores_get-by-id",
            "scores_get-many",
            "sessions_get",
            "sessions_list",
            "trace_get",
            "trace_list",
          ].sort(),
        );
      }
    }
  });
});
