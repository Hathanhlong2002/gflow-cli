import { describe, expect, it } from "vitest";
import { projectIdFromUrl, projectSubUrl } from "../src/flow/ui.js";

describe("project url helpers", () => {
  it("extracts the project id from a flow url", () => {
    expect(projectIdFromUrl("https://flow.google.com/project/e7f6d6ef-61cf-478e-b7e0-31a09aac0f9f/characters"))
      .toBe("e7f6d6ef-61cf-478e-b7e0-31a09aac0f9f");
  });
  it("returns undefined when there is no project segment", () => {
    expect(projectIdFromUrl("https://flow.google.com")).toBeUndefined();
  });
  it("builds a project sub-url", () => {
    expect(projectSubUrl("abc", "characters")).toBe("https://flow.google.com/project/abc/characters");
    expect(projectSubUrl("abc", "")).toBe("https://flow.google.com/project/abc");
  });
});
