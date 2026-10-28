import { describe, expect, it } from "vitest";
import { pad } from "../src/pad.ts";

describe("pad", () => {
  it("pad of an empty list is an empty list", () => expect(pad([])).toEqual([]));
});
