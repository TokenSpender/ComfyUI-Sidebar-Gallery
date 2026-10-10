let _schema = null;
let _reserved = null;

const _isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function _valid(p) {
  return _isObject(p) && _isObject(p.resolve) && _isObject(p.sections) && _isObject(p.root_fields)
    && _isObject(p.badge_labels) && Array.isArray(p.prefixes) && Array.isArray(p.reserved) && Array.isArray(p.roots);
}

/** Takes a payload in the served shape and answers whether it was one. */
export function setSearchSchema(payload) {
  if (!_valid(payload)) return false;
  _schema = payload;
  _reserved = null;
  return true;
}

export function searchSchemaReady() {
  return _schema !== null;
}

export function resolveSchemaField(spelling) {
  if (!_schema) return null;
  return _schema.resolve[String(spelling || "").trim().toLowerCase()] || null;
}

export function schemaPrefixes() {
  return _schema ? _schema.prefixes : [];
}

export function isSchemaReserved(name) {
  if (!_schema) return false;
  if (!_reserved) _reserved = new Set(_schema.reserved);
  return _reserved.has(String(name || "").trim().toLowerCase());
}

// Keyed by catalog title in the catalog's order, each row carrying section_id,
// search_field, key, kind, summary_keys and an optional display_name.
export function schemaSections() {
  return _schema ? _schema.sections : {};
}

// The search field that reads each summary root, keyed by the root.
export function schemaRootFields() {
  return _schema ? _schema.root_fields : {};
}

export function schemaRoots() {
  return _schema ? _schema.roots : [];
}

// The section title for each search field one section owns alone, and a field
// several sections share has no entry.
export function schemaBadgeLabels() {
  return _schema ? _schema.badge_labels : {};
}
