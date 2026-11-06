import { existsSync } from "node:fs";

// A judge export flattens release/judge into the root and has no release/judge folder. In the owner tree that folder exists, so a file the export omits
// must be present there and a missing one must fail. Tests decide between "stand down" and "must exist" by this folder, never by the file itself.
export const EXPORT_MODE = !existsSync("release/judge");
