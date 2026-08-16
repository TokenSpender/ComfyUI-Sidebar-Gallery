/**
 * sbg-section-registry.js: Search-field name mapping (between display, canonical, and backend names)
 *
 * The metadata-section SCHEMA and rendering live in section_catalog.json and
 * sbg-translation-layer.js. This module holds ONLY the search-naming lookups the
 * gallery uses to translate a user-typed search field into the backend field name
 * (and back, for match-badge labels).
 */

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
  "Tags": { searchField: "tags" },
  "Lyrics": { searchField: "lyrics" },
  "Track": { searchField: "track" },
  "Extra Metadata": { searchField: "extra", displayName: "Details" },
  "Workflow Nodes": { searchField: "workflow_nodes" },
  "VLM Captioner": { searchField: "workflow_nodes" },
  "AIO Aux Preprocessor": { searchField: "workflow_nodes" },
  "Prompt Enhancer": { searchField: "workflow_nodes" },
  "Raw Prompt JSON": { searchField: null },
  "Raw Workflow JSON": { searchField: null },
};

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
  "tags": "Tags", "tag": "Tags", "audio_tags": "Tags",
  "lyrics": "Lyrics", "lyric": "Lyrics", "audio_lyrics": "Lyrics",
  "track": "Track", "artist": "Track", "album": "Track",
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
    if (SECTION_DEFS[dn]) return dn;
    const aliased = SEARCH_FIELD_ALIASES[dn.toLowerCase()];
    if (aliased) return aliased;
    // Only canonicals with a registry entry resolve; a retitled section that has
    // no backend search field must not turn into a bogus search tag.
    if (renames) {
      for (const [canonical, renamed] of Object.entries(renames)) {
        if (renamed.toLowerCase() === dn.toLowerCase() && SECTION_DEFS[canonical]) return canonical;
      }
    }
    return null;
  },

  /** Display name for a canonical section (applies renames + legacy displayName default). */
  getDisplayName(canonicalName, renames) {
    if (renames?.[canonicalName]) return renames[canonicalName];
    const def = SECTION_DEFS[canonicalName];
    if (def?.displayName) return def.displayName;
    return canonicalName;
  },

  getSearchField(canonicalSection) {
    const def = SECTION_DEFS[canonicalSection];
    if (!def) return canonicalSection.toLowerCase();
    return def.searchField || canonicalSection.toLowerCase();
  },

  /** All section defs (the gallery reads each def.searchField to map fields to sections). */
  get sectionDefs() { return SECTION_DEFS; },
};

export { SectionRegistry };
