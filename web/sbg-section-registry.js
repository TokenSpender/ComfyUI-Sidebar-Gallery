/**
 * sbg-section-registry.js — Search-field name mapping (display ↔ canonical ↔ backend field)
 *
 * The metadata-section SCHEMA and rendering now live in section_catalog.json and
 * sbg-translation-layer.js (the translation-layer rewrite). This module retains
 * ONLY the search-naming lookups the gallery uses to translate a user-typed
 * search field into the backend field name — and back, for match-badge labels.
 *
 * The former render engine (resolveValue / mergeSpec / getParamStyle /
 * hasSectionData / getOrderedSections / isSectionEnabled / _buildReverseMap / …)
 * and the per-section render specs were dead after the rewrite and have been
 * removed.
 */

// Canonical section name → backend search field (+ optional legacy display name).
// ORDER IS SIGNIFICANT: the gallery builds a searchField → canonical map with
// "last wins" for match-badge labels (so "prompt" → Negative Prompt, and
// "workflow_nodes" → Prompt Enhancer). This mirrors the historical order exactly.
const SECTION_DEFS = {
  "File Info": { searchField: "fileinfo" },
  "Models": { searchField: "model" },
  "Sampling": { searchField: "sampling" },
  "LoRAs": { searchField: "lora" },
  "ControlNet": { searchField: "controlnet" },
  "ADetailer": { searchField: "adetailer" },
  "Upscaling": { searchField: "upscaling" },
  "Interpolation": { searchField: "interpolation" },
  "MMAudio": { searchField: "mmaudio" },
  "Positive Prompt": { searchField: "prompt" },
  "Negative Prompt": { searchField: "prompt" },
  "Extra Metadata": { searchField: "extra", displayName: "Details" },
  "Workflow Nodes": { searchField: "workflow_nodes" },
  "VLM Captioner": { searchField: "workflow_nodes" },
  "AIO Aux Preprocessor": { searchField: "workflow_nodes" },
  "Prompt Enhancer": { searchField: "workflow_nodes" },
  "Raw Prompt JSON": { searchField: null },
  "Raw Workflow JSON": { searchField: null },
};

// Search field name aliases (what users/old code may type → canonical).
const SEARCH_FIELD_ALIASES = {
  "file info": "File Info", "fileinfo": "File Info",
  "models": "Models", "model": "Models",
  "sampling": "Sampling", "sampler": "Sampling",
  "loras": "LoRAs", "lora": "LoRAs",
  "controlnet": "ControlNet",
  "adetailer": "ADetailer",
  "upscaling": "Upscaling",
  "interpolation": "Interpolation",
  "mmaudio": "MMAudio",
  "positive prompt": "Positive Prompt", "prompt": "Positive Prompt",
  "negative prompt": "Negative Prompt",
  "workflow nodes": "Workflow Nodes", "workflow_nodes": "Workflow Nodes",
  "extra": "Extra Metadata", "extra metadata": "Extra Metadata", "details": "Extra Metadata",
  "vlm captioner": "VLM Captioner",
  "prompt enhancer": "Prompt Enhancer",
};

const SectionRegistry = {
  /** Canonical section name from a user-typed display name (handles renames + aliases). */
  getCanonicalName(displayName, layout) {
    if (!displayName) return null;
    const dn = displayName.trim();
    // Direct match
    if (SECTION_DEFS[dn]) return dn;
    // Search field aliases
    const aliased = SEARCH_FIELD_ALIASES[dn.toLowerCase()];
    if (aliased) return aliased;
    // Layout renames (reverse: display → canonical)
    if (layout?.renames) {
      for (const [canonical, renamed] of Object.entries(layout.renames)) {
        if (renamed.toLowerCase() === dn.toLowerCase()) return canonical;
      }
    }
    return null; // Unknown section
  },

  /** Display name for a canonical section (applies renames + legacy displayName default). */
  getDisplayName(canonicalName, layout) {
    if (layout?.renames?.[canonicalName]) return layout.renames[canonicalName];
    const def = SECTION_DEFS[canonicalName];
    if (def?.displayName) return def.displayName;
    return canonicalName;
  },

  /** Backend search field name for a canonical section. */
  getSearchField(canonicalSection) {
    const def = SECTION_DEFS[canonicalSection];
    if (!def) return canonicalSection.toLowerCase();
    return def.searchField || canonicalSection.toLowerCase();
  },

  /** All section defs (the gallery reads each def.searchField to map fields → sections). */
  get sectionDefs() { return SECTION_DEFS; },
};

export { SectionRegistry };
