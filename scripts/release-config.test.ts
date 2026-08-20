import { describe, expect, test } from "bun:test";

import {
  assertReleasableVersion,
  npmEnvironment,
  parseReleaseArgs,
  prereleaseVersion,
  publishTagForVersion,
  releaseGuard,
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
        "--publish-local",
      ]),
    ).toEqual({
      version: "1.0.0-rc.0",
      tag: "rc",
      dryRun: true,
      allowDirty: false,
      publishLocal: true,
      showHelp: false,
    });
    expect(parseReleaseArgs(["--publish-local"]).publishLocal).toBe(true);
    // the CI publish derives the dist-tag itself; --tag is publish-local only
    expect(() => parseReleaseArgs(["--tag", "rc"])).toThrow(
      "--tag only applies to --publish-local",
    );
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

  test("releasable-version policy normalizes and fails closed", () => {
    expect(assertReleasableVersion("1.0.1")).toBe("1.0.1");
    expect(assertReleasableVersion("v1.0.1")).toBe("1.0.1"); // normalized
    expect(assertReleasableVersion("1.1.0-rc.2")).toBe("1.1.0-rc.2");
    expect(assertReleasableVersion("2.0.0-alpha.0")).toBe("2.0.0-alpha.0");
    expect(() => assertReleasableVersion("1.2.3+sha-abc")).toThrow(
      "Build metadata",
    );
    expect(() => assertReleasableVersion("1.0.0-RC.1")).toThrow(
      'identifier "RC" is not releasable',
    );
    expect(() => assertReleasableVersion("1.2.0-next.0")).toThrow(
      'identifier "next" is not releasable',
    );
    expect(() => assertReleasableVersion("1.0")).toThrow("Invalid semver");
  });

  test("publish-time guard binds tag, prerelease flag, and latest monotonicity", () => {
    const base = {
      version: "1.1.0",
      tagName: "v1.1.0",
      isPrerelease: false,
      currentLatest: "1.0.0",
    };
    expect(releaseGuard(base)).toBe("latest");
    expect(releaseGuard({ ...base, currentLatest: null })).toBe("latest"); // first publish
    expect(
      releaseGuard({
        version: "1.2.0-rc.0",
        tagName: "v1.2.0-rc.0",
        isPrerelease: true,
        // monotonicity applies only to latest; rc may trail the current latest
        currentLatest: "9.9.9",
      }),
    ).toBe("rc");

    expect(() =>
      releaseGuard({ ...base, currentLatest: "1.1.0" }),
    ).toThrow('Refusing to move npm dist-tag "latest" backwards');
    expect(() =>
      releaseGuard({ ...base, currentLatest: "2.0.0" }),
    ).toThrow("backwards");
    expect(() => releaseGuard({ ...base, tagName: "v1.1.1" })).toThrow(
      "does not match",
    );
    expect(() => releaseGuard({ ...base, isPrerelease: true })).toThrow(
      "must not be marked",
    );
    expect(() =>
      releaseGuard({
        version: "1.2.0-rc.0",
        tagName: "v1.2.0-rc.0",
        isPrerelease: false,
        currentLatest: null,
      }),
    ).toThrow("must be published as a GitHub pre-release");
    expect(() =>
      releaseGuard({ ...base, version: "v1.1.0", tagName: "vv1.1.0" }),
    ).toThrow("not in normalized form");
  });
});
