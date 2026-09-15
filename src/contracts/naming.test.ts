import { describe, expect, test } from "bun:test";

import { kebabCase, planCommandNames, pluralize } from "./naming";

describe("stable CLI naming policy", () => {
  test("normalizes tags and pluralizes resources", () => {
    expect(kebabCase("AnnotationQueues")).toBe("annotation-queues");
    expect(pluralize("trace")).toBe("traces");
    expect(pluralize("datasets")).toBe("datasets");
  });

  test("uses path resources and keeps tags as aliases", () => {
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
      },
      {
        resource: "traces",
        action: "delete",
        aliases: [{ resource: "trace", action: "delete", source: "tag" }],
      },
    ]);
  });

  test("uses REST semantics instead of stuttered dashboard actions", () => {
    const names = planCommandNames([
      {
        operationId: "unstable_dashboards_create",
        method: "POST",
        path: "/api/public/unstable/dashboards",
        tags: ["UnstableDashboards"],
      },
      {
        operationId: "unstable_dashboards_update",
        method: "PATCH",
        path: "/api/public/unstable/dashboards/{dashboardId}",
        tags: ["UnstableDashboards"],
      },
      {
        operationId: "unstable_dashboards_delete",
        method: "DELETE",
        path: "/api/public/unstable/dashboards/{dashboardId}",
        tags: ["UnstableDashboards"],
      },
      {
        operationId: "unstable_dashboards_addPlacement",
        method: "POST",
        path: "/api/public/unstable/dashboards/{dashboardId}/placements",
        tags: ["UnstableDashboards"],
      },
      {
        operationId: "unstable_dashboards_updatePlacement",
        method: "PATCH",
        path: "/api/public/unstable/dashboards/{dashboardId}/placements/{placementId}",
        tags: ["UnstableDashboards"],
      },
      {
        operationId: "unstable_dashboards_deletePlacement",
        method: "DELETE",
        path: "/api/public/unstable/dashboards/{dashboardId}/placements/{placementId}",
        tags: ["UnstableDashboards"],
      },
    ]);
    expect(names.map(({ resource, action }) => `${resource} ${action}`)).toEqual([
      "unstable-dashboards create",
      "unstable-dashboards update",
      "unstable-dashboards delete",
      "unstable-dashboards add-placement",
      "unstable-dashboards update-placement",
      "unstable-dashboards delete-placement",
    ]);
  });

  test("prefers the latest active route and exposes path and tag aliases", () => {
    const names = planCommandNames([
      {
        operationId: "scores_get-many",
        method: "GET",
        path: "/api/public/v2/scores",
        tags: ["Scores"],
        deprecated: true,
      },
      {
        operationId: "scoresV3_getManyV3",
        method: "GET",
        path: "/api/public/v3/scores",
        tags: ["ScoresV3"],
      },
    ]);

    expect(names).toEqual([
      {
        resource: "scores-v2",
        action: "list",
      },
      {
        resource: "scores",
        action: "list",
        aliases: [
          { resource: "scores-v3", action: "list", source: "version" },
        ],
      },
    ]);
  });

  test("names unversioned deprecated reads legacy-<resource>-v1", () => {
    expect(
      planCommandNames([
        {
          operationId: "trace_list",
          method: "GET",
          path: "/api/public/traces",
          tags: ["Trace"],
          deprecated: true,
        },
        {
          operationId: "legacy_observationsV1_getMany",
          method: "GET",
          path: "/api/public/observations",
          tags: ["LegacyObservationsV1"],
          deprecated: true,
        },
        {
          operationId: "observations_getMany",
          method: "GET",
          path: "/api/public/v2/observations",
          tags: ["Observations"],
        },
      ]),
    ).toEqual([
      {
        resource: "legacy-traces-v1",
        action: "list",
        aliases: [
          { resource: "traces", action: "list", source: "path" },
          { resource: "trace", action: "list", source: "tag" },
        ],
      },
      {
        resource: "legacy-observations-v1",
        action: "list",
      },
      {
        resource: "observations",
        action: "list",
        aliases: [
          { resource: "observations-v2", action: "list", source: "version" },
        ],
      },
    ]);
  });
});
