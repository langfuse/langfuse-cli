import { describe, expect, it } from "bun:test";
import { parseEnvContent } from "../env";

describe("parseEnvContent", () => {
  it("parses simple key=value pairs", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comments and empty lines", () => {
    const result = parseEnvContent("# comment\n\nFOO=bar\n  \n# another comment\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles quoted values (double quotes)", () => {
    const result = parseEnvContent('FOO="hello world"');
    expect(result).toEqual({ FOO: "hello world" });
  });

  it("handles quoted values (single quotes)", () => {
    const result = parseEnvContent("FOO='hello world'");
    expect(result).toEqual({ FOO: "hello world" });
  });

  it("handles export prefix", () => {
    const result = parseEnvContent("export FOO=bar\nexport BAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles values with equals signs", () => {
    const result = parseEnvContent("FOO=a=b=c");
    expect(result).toEqual({ FOO: "a=b=c" });
  });

  it("handles empty values", () => {
    const result = parseEnvContent("FOO=");
    expect(result).toEqual({ FOO: "" });
  });

  it("trims keys and values", () => {
    const result = parseEnvContent("  FOO  =  bar  ");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("skips lines without =", () => {
    const result = parseEnvContent("NOEQ\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("returns empty object for empty content", () => {
    expect(parseEnvContent("")).toEqual({});
    expect(parseEnvContent("  \n  ")).toEqual({});
  });

  it("handles URL values with trailing slashes", () => {
    const result = parseEnvContent("HOST=https://cloud.langfuse.com/");
    expect(result).toEqual({ HOST: "https://cloud.langfuse.com/" });
  });
});
