import { strict as assert } from "node:assert";
import test from "node:test";

import { assertRequiredTools } from "../src/init/verify.js";

test("init verification requires the complete login verification tool set", () => {
  assert.doesNotThrow(() => assertRequiredTools([
    "tdei_sso_login",
    "tdei_auth_status",
    "listServices",
  ]));

  assert.throws(
    () => assertRequiredTools(["tdei_sso_login"]),
    /tdei_auth_status, listServices/,
  );
});
