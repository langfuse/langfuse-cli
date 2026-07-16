import { describe, expect, test } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";

import { loadCatalog, readVerifiedSpec, specPath } from "../src/catalog";
import { checkCorpus } from "../src/generator";

describe("immutable OpenAPI catalog", () => {
  test("all pinned snapshots pass SHA-256 verification", async () => {
    const catalog = await loadCatalog();
    expect(catalog.versions.map((entry) => entry.version)).toEqual([
      "3.0.0",
      "3.50.0",
      "3.100.0",
      "3.150.0",
      "3.176.0",
      "3.200.0",
      "3.212.0",
      "3.216.0",
    ]);
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

  test("generated corpora are deterministic and fully supported", async () => {
    const catalog = await loadCatalog();
    for (const entry of catalog.versions) {
      const corpus = await checkCorpus(entry);
      expect(corpus.coverage.unsupported).toEqual([]);
      expect(corpus.coverage.sourceIssues).toEqual(entry.knownIssues ?? []);
      expect(corpus.coverage.counts.operations).toBeGreaterThan(0);
      expect(corpus.coverage.counts.vectors).toBeGreaterThan(
        corpus.coverage.counts.operations,
      );
    }
  });
});
