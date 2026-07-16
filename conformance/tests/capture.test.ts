import { afterEach, describe, expect, test } from "bun:test";

import { CaptureServer, requestDiff } from "../src/capture";

let capture: CaptureServer | undefined;

afterEach(() => capture?.stop());

describe("black-box capture oracle", () => {
  test("records raw HTTP traffic and returns the armed response", async () => {
    capture = new CaptureServer();
    capture.arm({
      key: "201",
      status: 201,
      contentType: "application/json",
      sample: { id: "created" },
    });
    const response = await fetch(`${capture.url}/widgets?id=1&id=2`, {
      method: "POST",
      headers: {
        authorization: "Basic test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "widget" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "created" });
    expect(
      requestDiff(
        {
          method: "POST",
          pathname: "/widgets",
          query: [
            ["id", "1"],
            ["id", "2"],
          ],
          headers: {
            authorization: "Basic test",
            "content-type": "application/json",
          },
          body: { name: "widget" },
        },
        capture.requests[0],
      ),
    ).toEqual([]);
  });
});
