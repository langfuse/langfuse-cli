import { describe, expect, it } from "bun:test";
import { asObject, stableJson } from "../fs";

describe("asObject", () => {
  it("returns object for plain objects", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
  });

  it("returns null for arrays", () => {
    expect(asObject([1, 2, 3])).toBeNull();
  });

  it("returns null for null", () => {
    expect(asObject(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(asObject(undefined)).toBeNull();
  });

  it("returns null for primitives", () => {
    expect(asObject("string")).toBeNull();
    expect(asObject(42)).toBeNull();
    expect(asObject(true)).toBeNull();
  });
});

describe("stableJson", () => {
  it("sorts keys alphabetically", () => {
    const result = stableJson({ z: 1, a: 2, m: 3 });
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toEqual(["a", "m", "z"]);
  });

  it("sorts nested keys", () => {
    const result = stableJson({ b: { z: 1, a: 2 }, a: 1 });
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toEqual(["a", "b"]);
    expect(Object.keys(parsed.b)).toEqual(["a", "z"]);
  });

  it("handles arrays without reordering elements", () => {
    const result = stableJson({ items: [3, 1, 2] });
    const parsed = JSON.parse(result);
    expect(parsed.items).toEqual([3, 1, 2]);
  });

  it("produces deterministic output for equivalent objects", () => {
    const a = stableJson({ b: 1, a: 2 });
    const b = stableJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("ends with newline", () => {
    const result = stableJson({ a: 1 });
    expect(result.endsWith("\n")).toBe(true);
  });

  it("handles null and primitive values", () => {
    expect(stableJson(null)).toBe("null\n");
    expect(stableJson(42)).toBe("42\n");
    expect(stableJson("hello")).toBe('"hello"\n');
  });
});
