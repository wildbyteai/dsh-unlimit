import { fail, object } from "./validation.js";

export const CREDENTIAL_FIELDS = Object.freeze([
  "name",
  "username",
  "target",
  "notes",
  "assetId",
  "serviceId",
  "role",
  "source",
]);
const fields = new Set(CREDENTIAL_FIELDS);
const own = (value, key) => Object.hasOwn(value, key);
const legacy = (key, value) => key !== "secret" && (!fields.has(key) || typeof value !== "string");

/** Metadata fields are explicitly non-secret; opaque legacy values never leave this boundary. */
export function credentialView(item) {
  const data = item.data ?? {};
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    kind: "credential",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    data: Object.fromEntries(
      CREDENTIAL_FIELDS.filter((key) => typeof data[key] === "string").map((key) => [
        key,
        data[key],
      ]),
    ),
    secretState: {
      hasSecret: typeof data.secret === "string" ? data.secret.length > 0 : data.secret != null,
      legacyFieldCount: Object.entries(data).filter(([key, value]) => legacy(key, value)).length,
    },
  };
}

export function credentialUpdate(previous, input, { clearLegacyFields = false } = {}) {
  object(input, "credential data");
  if (typeof clearLegacyFields !== "boolean")
    fail("INVALID_INPUT", "clearLegacyFields must be boolean");
  if (Object.keys(input).some((key) => !fields.has(key) && key !== "secret"))
    fail("INVALID_INPUT", "Credential data contains unsupported fields");
  const data = { ...(previous ?? {}) };
  if (clearLegacyFields)
    for (const [key, value] of Object.entries(data)) if (legacy(key, value)) delete data[key];
  for (const key of CREDENTIAL_FIELDS)
    if (own(input, key)) {
      if (typeof input[key] !== "string")
        fail("INVALID_INPUT", "Credential metadata values must be strings");
      if (input[key] === "") delete data[key];
      else data[key] = input[key];
    }
  if (own(input, "secret")) {
    if (typeof input.secret !== "string")
      fail("INVALID_INPUT", "Credential secret must be a string");
    if (/^(?:\[REDACTED\]|\[已隐藏\]|[•*]{3,})(?:\s*·\s*已隐藏)?$/i.test(input.secret))
      fail("INVALID_INPUT", "A display mask cannot replace a credential secret");
    if (input.secret === "") delete data.secret;
    else data.secret = input.secret;
  }
  return data;
}
