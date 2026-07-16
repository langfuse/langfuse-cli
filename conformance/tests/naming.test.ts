import { describe, expect, test } from "bun:test";

import { kebabCase, planCommandNames, pluralize } from "../src/naming";

describe("stable CLI naming policy", () => {
  test("normalizes Langfuse tags without importing specli", () => {
    expect(kebabCase("AnnotationQueues")).toBe("annotation-queues");
    expect(pluralize("trace")).toBe("traces");
    expect(pluralize("datasets")).toBe("datasets");
  });

  test("uses tag resources and operationId actions", () => {
    expect(
      planCommandNames([
        {
          operationId: "annotationQueues_listQueues",
          method: "GET",
          path: "/api/public/annotation-queues",
          tags: ["AnnotationQueues"],
        },
        {
          operationId: "trace_delete",
          method: "DELETE",
          path: "/api/public/traces/{traceId}",
          tags: ["Trace"],
        },
      ]),
    ).toEqual([
      {
        resource: "annotation-queues",
        action: "list",
        canonicalAction: "list",
      },
      {
        resource: "traces",
        action: "delete",
        canonicalAction: "delete",
      },
    ]);
  });

  test("disambiguates collisions deterministically", () => {
    const names = planCommandNames([
      {
        operationId: "comments_get",
        method: "GET",
        path: "/api/public/comments",
        tags: ["Comments"],
      },
      {
        operationId: "comments_get-by-id",
        method: "GET",
        path: "/api/public/comments/{commentId}",
        tags: ["Comments"],
      },
    ]);
    expect(new Set(names.map((name) => name.action)).size).toBe(2);
    expect(names.every((name) => name.aliasOf === "comments get")).toBe(true);
  });
});
