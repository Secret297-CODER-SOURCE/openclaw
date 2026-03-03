// Side-effect-only module: installs the process warning filter as early as possible.
// Imported first in src/index.ts so the filter is in place before any transitive
// dependency (e.g. grammy's web.mjs) emits Node.js runtime warnings.
import { installProcessWarningFilter } from "./warning-filter.js";

installProcessWarningFilter();
