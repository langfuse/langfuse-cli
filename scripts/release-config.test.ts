import { describe, expect, test } from "bun:test";

import {
  npmEnvironment,
  parseReleaseArgs,
  publishTagForVersion,
} from "./release-config";

describe("release configuration", () => {
  test("parses an explicit RC release", () => {
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
  });

  test("infers safe tags from the version", () => {
    expect(publishTagForVersion("1.0.0-rc.0")).toBe("rc");
    expect(publishTagForVersion("1.0.0-beta.2")).toBe("beta");
    expect(publishTagForVersion("1.0.0")).toBe("latest");
    expect(publishTagForVersion("1.0.0-rc.0", "next")).toBe("next");
  });

  test("rejects publishing a prerelease as latest", () => {
    expect(() => publishTagForVersion("1.0.0-rc.0", "latest")).toThrow(
      "cannot be published with the latest tag",
    );
  });

  test("does not leak a global npm tag into registry checks", () => {
    expect(
      npmEnvironment(
        { npm_config_tag: "rc", NPM_CONFIG_TAG: "beta", HOME: "/tmp/home" },
        "/tmp/cache",
      ),
    ).toEqual({ HOME: "/tmp/home", npm_config_cache: "/tmp/cache" });
  });

  test("rejects missing values and unknown options", () => {
    expect(() => parseReleaseArgs(["--version"])).toThrow(
      "--version requires a value",
    );
    expect(() => parseReleaseArgs(["--wat"])).toThrow(
      "Unknown release option: --wat",
    );
  });
});
