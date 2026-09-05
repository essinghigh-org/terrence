import { expect, spyOn, test } from "bun:test";
import { newResourceId } from "../../src/lib/resource-id";

test("compact resource IDs keep their public lengths without truncating UUID version bits", () => {
  const uuid = spyOn(crypto, "randomUUID");
  try {
    expect(newResourceId("run")).toMatch(/^run-[a-f0-9]{14}$/);
    for (const prefix of ["ws", "prj", "var", "varset", "hyokcv", "sa", "stc", "st", "sst", "sds", "saj", "sdg", "sdr"]) {
      expect(newResourceId(prefix)).toMatch(new RegExp(`^${prefix}-[a-f0-9]{16}$`));
    }
    expect(uuid).not.toHaveBeenCalled();
  } finally {
    uuid.mockRestore();
  }
});

test("configuration versions and UUID resources retain the whole UUID", () => {
  for (const prefix of ["cv", "user", "org", "orgmem", "tm", "rc", "mod", "rt"]) {
    expect(newResourceId(prefix)).toMatch(new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`));
  }
});
