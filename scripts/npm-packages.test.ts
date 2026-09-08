import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  CANONICAL_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME,
  prepareNpmPackages,
} from "./npm-packages";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function fixture(): Promise<{ source: string; output: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "langfuse-npm-packages-test-"));
  temporaryDirectories.push(root);
  const source = resolve(root, "source");
  const output = resolve(root, "output");
  await Promise.all([
    mkdir(resolve(source, "bin"), { recursive: true }),
    mkdir(resolve(source, "dist"), { recursive: true }),
    mkdir(resolve(source, "npm/legacy"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      resolve(source, "package.json"),
      JSON.stringify({
        name: CANONICAL_PACKAGE_NAME,
        version: "1.2.3",
        bin: { langfuse: "bin/langfuse.mjs" },
        files: ["bin", "dist", "README.md"],
        publishConfig: { access: "public" },
      }),
    ),
    writeFile(resolve(source, "README.md"), "canonical readme\n"),
    writeFile(resolve(source, "npm/legacy/README.md"), "deprecated readme\n"),
    writeFile(resolve(source, "LICENSE"), "MIT\n"),
    writeFile(resolve(source, "bin/langfuse.mjs"), "runtime\n"),
    writeFile(resolve(source, "dist/cli.js"), "runtime\n"),
  ]);
  return { source, output };
}

describe("npm package staging", () => {
  test("creates canonical and deprecated legacy packages from one runtime", async () => {
    const { source, output } = await fixture();
    const gitHead = "a".repeat(40);
    const paths = await prepareNpmPackages(output, source, gitHead);
    const canonical = JSON.parse(
      await readFile(resolve(paths.canonical, "package.json"), "utf8"),
    );
    const legacy = JSON.parse(
      await readFile(resolve(paths.legacy, "package.json"), "utf8"),
    );

    expect(canonical.name).toBe(CANONICAL_PACKAGE_NAME);
    expect(legacy.name).toBe(LEGACY_PACKAGE_NAME);
    expect(legacy.version).toBe(canonical.version);
    expect(legacy.gitHead).toBe(gitHead);
    expect(canonical.gitHead).toBe(gitHead);
    expect(legacy.bin).toEqual(canonical.bin);
    expect(await readFile(resolve(paths.canonical, "README.md"), "utf8")).toBe(
      "canonical readme\n",
    );
    expect(await readFile(resolve(paths.legacy, "README.md"), "utf8")).toBe(
      "deprecated readme\n",
    );
    expect(await readFile(resolve(paths.legacy, "dist/cli.js"), "utf8")).toBe(
      await readFile(resolve(paths.canonical, "dist/cli.js"), "utf8"),
    );
  });

  test("refuses a non-canonical source or an existing output directory", async () => {
    const first = await fixture();
    const pkgPath = resolve(first.source, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    await writeFile(pkgPath, JSON.stringify({ ...pkg, name: LEGACY_PACKAGE_NAME }));
    await expect(prepareNpmPackages(first.output, first.source)).rejects.toThrow(
      `package.json must use canonical name ${CANONICAL_PACKAGE_NAME}`,
    );

    const second = await fixture();
    await mkdir(second.output);
    await expect(prepareNpmPackages(second.output, second.source)).rejects.toThrow(
      "npm package output already exists",
    );
  });
});
