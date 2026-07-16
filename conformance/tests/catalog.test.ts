import { describe, expect, test } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";

import { loadCatalog, readVerifiedSpec, specPath } from "../src/catalog";
import { generateCorpus } from "../src/generator";

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

  test("each operation produces one supported endpoint call", async () => {
    const catalog = await loadCatalog();
    for (const entry of catalog.versions) {
      const corpus = await generateCorpus(entry);
      expect(corpus.compiled.unsupported).toEqual([]);
      expect(corpus.vectors).toHaveLength(
        corpus.compiled.manifest.operations.length,
      );
      expect(corpus.vectors.length).toBeGreaterThan(0);
    }
  });
});
