import { describe, expect, test } from "bun:test";

import {
  npmEnvironment,
  parseReleaseArgs,
  publishTagForVersion,
} from "./release-config";

describe("release configuration", () => {
  test("parses valid releases and selects safe npm tags", () => {
    expect(
      parseReleaseArgs([
        "--version",
        "1.0.0-rc.0",
        "--tag",
        "rc",
        "--dry-run",
      ]),
    ).toEqual({
      version: "1.0.0-rc.0",
      tag: "rc",
      dryRun: true,
      allowDirty: false,
      showHelp: false,
    });
    expect(publishTagForVersion("1.0.0-rc.0")).toBe("rc");
    expect(publishTagForVersion("1.0.0")).toBe("latest");
    expect(publishTagForVersion("1.0.0-0.3.7", "next")).toBe("next");
    expect(
      npmEnvironment(
        { npm_config_tag: "rc", NPM_CONFIG_TAG: "beta", HOME: "/tmp/home" },
        "/tmp/cache",
      ),
    ).toEqual({ HOME: "/tmp/home", npm_config_cache: "/tmp/cache" });
  });

  test("rejects invalid arguments and unsafe npm tags", () => {
    expect(() => parseReleaseArgs(["--version"])).toThrow(
      "--version requires a value",
    );
    expect(() => parseReleaseArgs(["--wat"])).toThrow(
      "Unknown release option: --wat",
    );
    expect(() => publishTagForVersion("1.0.0-rc.0", "latest")).toThrow();
    expect(() => publishTagForVersion("1.0.0", "v1")).toThrow();
    expect(() => publishTagForVersion("1.0.0-x.0")).toThrow();
    expect(() => publishTagForVersion("1.0.0-0.3.7")).toThrow(
      "pass --tag explicitly",
    );
  });
});
