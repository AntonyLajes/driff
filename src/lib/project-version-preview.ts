import { execute as parseExpoVersion } from "@/lib/expo-app-config-version.js";
import { execute as parsePackageVersion } from "@/lib/package-json-version.js";
import { execute as parsePbxprojVersion } from "@/lib/pbxproj-version.js";
import { execute as parsePlistVersion } from "@/lib/plist-version.js";
import { parseVersionMarkerFile } from "@/lib/version-marker-file.js";

export const parseProjectVersionPreview = (
  kind: string,
  path: string,
  raw: string,
) => {
  switch (kind) {
    case "react_native_expo":
      return parseExpoVersion(raw, path);
    case "node_package":
      return parsePackageVersion(raw);
    case "ios_plist":
      return parsePlistVersion(raw);
    case "ios_pbx":
      return parsePbxprojVersion(raw);
    default:
      return parseVersionMarkerFile(kind, raw);
  }
};
