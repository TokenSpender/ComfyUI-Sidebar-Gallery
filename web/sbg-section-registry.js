/**
 * sbg-section-registry.js: Search-field name mapping (between display, canonical, and backend names)
 *
 * The metadata-section SCHEMA and rendering now live in section_catalog.json and
 * sbg-translation-layer.js (the translation-layer rewrite). This module retains
 * ONLY the search-naming lookups the gallery uses to translate a user-typed
 * search field into the backend field name (and back, for match-badge labels).
 *
 * The former render engine (resolveValue / mergeSpec / getParamStyle /
 * hasSectionData / getOrderedSections / isSectionEnabled / _buildReverseMap / …)
 * and the per-section render specs were dead after the rewrite and have been
 * removed.
 */

// Backend search field per canonical section name (+ optional legacy display name).
// ORDER MATTERS: the gallery builds a searchField-to-name map with "last wins"
// for match-badge labels, so "prompt" labels as Negative Prompt and
// "workflow_nodes" as Prompt Enhancer.
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

// Search field name aliases, mapping what users/old code may type to the canonical name.
const SEARCH_FIELD_ALIASES = {
  "file info": "File Info", "fileinfo": "File Info", "file_info": "File Info",
  "models": "Models", "model": "Models",
  "sampling": "Sampling", "sampler": "Sampling", "samplers": "Sampling",
  "loras": "LoRAs", "lora": "LoRAs",
  "controlnet": "ControlNet",
  "adetailer": "ADetailer",
  "upscaling": "Upscaling",
  "interpolation": "Interpolation",
  "mmaudio": "MMAudio",
  "positive prompt": "Positive Prompt", "prompt": "Positive Prompt",
  "positive": "Positive Prompt",
  "negative prompt": "Negative Prompt", "negative": "Negative Prompt",
  "original prompt (pre-enhance)": "Positive Prompt",
  "workflow nodes": "Workflow Nodes", "workflow_nodes": "Workflow Nodes",
  "extra": "Extra Metadata", "extra metadata": "Extra Metadata", "details": "Extra Metadata",
  "vlm captioner": "VLM Captioner",
  "prompt enhancer": "Prompt Enhancer",
};

const SectionRegistry = {
  /** Canonical section name from a user-typed display name (handles renames + aliases).
   *  `renames` is the layout-editor title map from TL.getSectionRenames(). */
  getCanonicalName(displayName, renames) {
    if (!displayName) return null;
    const dn = displayName.trim();
    // Direct match
    if (SECTION_DEFS[dn]) return dn;
    // Search field aliases
    const aliased = SEARCH_FIELD_ALIASES[dn.toLowerCase()];
    if (aliased) return aliased;
    // Layout-editor renames (the reverse direction: user title back to canonical).
    // Only canonicals with a registry entry resolve; a retitled section that has
    // no backend search field must not turn into a bogus search tag.
    if (renames) {
      for (const [canonical, renamed] of Object.entries(renames)) {
        if (renamed.toLowerCase() === dn.toLowerCase() && SECTION_DEFS[canonical]) return canonical;
      }
    }
    return null; // Unknown section
  },

  /** Display name for a canonical section (applies renames + legacy displayName default). */
  getDisplayName(canonicalName, renames) {
    if (renames?.[canonicalName]) return renames[canonicalName];
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

  /** All section defs (the gallery reads each def.searchField to map fields to sections). */
  get sectionDefs() { return SECTION_DEFS; },
};

export { SectionRegistry };
