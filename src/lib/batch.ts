import { defaultExportPath, outputExtension } from "./exportFlow";
import type { OutputFormat } from "./types";

export interface PlannedBatchOutput {
  path: string;
  outputPath: string;
  /** Set only when this input needs a numbered suffix to avoid a batch collision. */
  outputSuffix?: string;
}

function baseName(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

function stemOf(fileName: string): string {
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx <= 0 ? fileName : fileName.slice(0, dotIdx);
}

function joinDir(dir: string, name: string): string {
  const usesBackslash = dir.includes("\\") && !dir.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const endsWithSep = dir.endsWith("/") || dir.endsWith("\\");
  return endsWithSep ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * Plans each input file's export output path: next to the source when
 * `outputDir` is null (same semantics as `defaultExportPath`), or under
 * `outputDir` (source stem + suffix + the source's extension, see
 * `outputExtension`) when given.
 */
export function planBatchOutputs(
  paths: string[],
  outputDir: string | null,
  suffix: string,
  fmt: OutputFormat = "psd"
): PlannedBatchOutput[] {
  const preferred = paths.map((path) => {
    const outputPath =
      outputDir === null
        ? defaultExportPath(path, suffix, fmt)
        : joinDir(outputDir, `${stemOf(baseName(path))}${suffix}.${outputExtension(path, fmt)}`);
    return { path, outputPath };
  });
  const preferredPaths = new Set(preferred.map(({ outputPath }) => outputPath));
  const used = new Set<string>();
  return preferred.map((entry) => {
    if (!used.has(entry.outputPath)) {
      used.add(entry.outputPath);
      return entry;
    }
    let index = 1;
    let outputSuffix: string;
    let outputPath: string;
    do {
      outputSuffix = `${suffix}_${index}`;
      outputPath =
        outputDir === null
          ? defaultExportPath(entry.path, outputSuffix, fmt)
          : joinDir(
              outputDir,
              `${stemOf(baseName(entry.path))}${outputSuffix}.${outputExtension(entry.path, fmt)}`
            );
      index += 1;
    } while (used.has(outputPath) || preferredPaths.has(outputPath));
    used.add(outputPath);
    return { ...entry, outputPath, outputSuffix };
  });
}

/**
 * Returns the subset of planned output paths that already exist on disk, in
 * input order. `existsFn` is injected (plugin-fs `exists` in production) so
 * this stays a pure, unit-testable function.
 */
export async function findConflicts(
  planned: PlannedBatchOutput[],
  existsFn: (path: string) => Promise<boolean>
): Promise<string[]> {
  const flags = await Promise.all(planned.map((p) => existsFn(p.outputPath)));
  return planned.filter((_, i) => flags[i]).map((p) => p.outputPath);
}
