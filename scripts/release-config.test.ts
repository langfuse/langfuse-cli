import { describe, expect, test } from "bun:test";

import {
  npmEnvironment,
  parseReleaseArgs,
  prereleaseVersion,
  publishTagForVersion,
  versionMenu,
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
      publishLocal: false,
      showHelp: false,
    });
    expect(parseReleaseArgs(["--publish-local"]).publishLocal).toBe(true);
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
    expect(() => publishTagForVersion("1.0")).toThrow("Invalid semver: 1.0");
    expect(() => publishTagForVersion("1.0.0-rc.0", "latest")).toThrow();
    expect(() => publishTagForVersion("1.0.0", "v1")).toThrow();
    expect(() => publishTagForVersion("1.0.0-x.0")).toThrow();
    expect(() => publishTagForVersion("1.0.0-0.3.7")).toThrow(
      "pass --tag explicitly",
    );
  });

  test("offers direct bumps and prerelease entry points from a stable version", () => {
    const options = versionMenu("1.0.0");
    expect(options.map((option) => option.version ?? option.preLevel)).toEqual([
      "1.0.1",
      "1.1.0",
      "2.0.0",
      "prepatch",
      "preminor",
      "premajor",
    ]);
    expect(prereleaseVersion("1.0.0", "preminor", "beta")).toBe("1.1.0-beta.0");
    expect(prereleaseVersion("1.0.0", "premajor", "alpha")).toBe("2.0.0-alpha.0");
    expect(prereleaseVersion("1.0.0", "prepatch", "rc")).toBe("1.0.1-rc.0");
  });

  test("offers continuation, graduation, and identifier switch from a prerelease", () => {
    const options = versionMenu("1.1.0-rc.0");
    expect(options.map((option) => option.version)).toEqual([
      "1.1.0-rc.1", // continue the rc line
      "1.1.0", // graduate to stable
      "1.1.0-alpha.0", // switch identifier
      "1.1.0-beta.0",
    ]);
    const beta = versionMenu("2.0.0-beta.3");
    expect(beta[0].version).toBe("2.0.0-beta.4");
    expect(beta[1].version).toBe("2.0.0");
    expect(beta.map((option) => option.version)).toContain("2.0.0-rc.0");
  });
});
