import assert from "node:assert/strict";
import { basePathFromDocumentUrl } from "../apps/web/src/base-path.ts";
import { instanceCookieSettings } from "../apps/server/src/auth.ts";

assert.equal(basePathFromDocumentUrl("https://example.com/"), "");
assert.equal(basePathFromDocumentUrl("https://example.com/pi-ark/?page=files"), "/pi-ark");
assert.equal(basePathFromDocumentUrl("https://example.com/pi-ark-backup/?workspace=workspace"), "/pi-ark-backup");

process.env.PI_ARK_INSTANCE = "dev";
process.env.PI_ARK_BASE_PATH = "/pi-ark/";
assert.deepEqual(instanceCookieSettings(), { name: "pi_ark_session_dev", path: "/pi-ark/" });
process.env.PI_ARK_INSTANCE = "backup";
process.env.PI_ARK_BASE_PATH = "/pi-ark-backup";
assert.deepEqual(instanceCookieSettings(), { name: "pi_ark_session_backup", path: "/pi-ark-backup/" });
process.env.PI_ARK_BASE_PATH = "relative";
assert.throws(() => instanceCookieSettings(), /absolute URL path/);
console.log("instance checks passed");
