import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const SYMBIAN_MASS_STORAGE_STAGE = "mass-storage-data";
export const SYMBIAN_MASS_STORAGE_MANIFEST = "manifest.json";
export const SYMBIAN_MASS_STORAGE_FILES = "files";

const SAFE_COMPONENT =
  /^[A-Za-z0-9_-](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9_-])?$/;
const MAX_RELATIVE_PATH_LENGTH = 200;

export interface SymbianMassStorageDataEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SymbianMassStorageDataManifest {
  readonly schemaVersion: 1;
  readonly data: readonly SymbianMassStorageDataEntry[];
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function canonicalizePotentialPath(pathInput: string): string {
  let ancestor = resolve(pathInput);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(
        `cannot resolve Symbian mass-storage build path: ${pathInput}`,
      );
    }
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

export function assertSymbianMassStorageDataStageSeparation(
  sourceRootInput: string,
  payloadRootInput: string,
): void {
  const sourceRoot = realpathSync(resolve(sourceRootInput));
  const payloadRoot = canonicalizePotentialPath(payloadRootInput);
  if (isWithin(sourceRoot, payloadRoot) || isWithin(payloadRoot, sourceRoot)) {
    throw new Error(
      "Symbian mass-storage data root and build payload must not overlap",
    );
  }
}

export function validateSymbianMassStorageRelativePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > MAX_RELATIVE_PATH_LENGTH ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/")
  ) {
    throw new Error(
      `unsafe Symbian mass-storage data path ${JSON.stringify(path)}`,
    );
  }
  const components = path.split("/");
  if (
    components.some((component) =>
      component === "." ||
      component === ".." ||
      !SAFE_COMPONENT.test(component)
    )
  ) {
    throw new Error(
      `unsafe Symbian mass-storage data path ${JSON.stringify(path)}`,
    );
  }
  return path;
}

function sha256FileSync(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

interface SourceFile {
  readonly source: string;
  readonly relativePath: string;
}

function collectSourceFiles(
  sourceRoot: string,
  directory: string,
  components: readonly string[],
  files: SourceFile[],
): void {
  for (const name of readdirSync(directory).sort()) {
    const relativePath = [...components, name].join("/");
    validateSymbianMassStorageRelativePath(relativePath);
    const source = join(directory, name);
    const metadata = lstatSync(source);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Symbian mass-storage data cannot contain symlinks: ${relativePath}`,
      );
    }
    if (metadata.isDirectory()) {
      collectSourceFiles(
        sourceRoot,
        source,
        [...components, name],
        files,
      );
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `Symbian mass-storage data must contain only regular files: ${relativePath}`,
      );
    }
    const normalized = relative(sourceRoot, source).split("\\").join("/");
    if (normalized !== relativePath) {
      throw new Error(
        `unsafe Symbian mass-storage data path ${JSON.stringify(relativePath)}`,
      );
    }
    files.push({ source, relativePath });
  }
}

/**
 * Copy one immutable custom-core data tree into the serialized Symbian
 * payload. The manifest deliberately contains no host source paths.
 */
export function stageSymbianMassStorageData(
  sourceRootInput: string,
  payloadRootInput: string,
): SymbianMassStorageDataManifest {
  const sourceRoot = resolve(sourceRootInput);
  const payloadRoot = resolve(payloadRootInput);
  const stageRoot = join(payloadRoot, SYMBIAN_MASS_STORAGE_STAGE);
  assertSymbianMassStorageDataStageSeparation(sourceRoot, payloadRoot);
  const rootMetadata = lstatSync(sourceRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(
      `Symbian mass-storage data root must be a real directory: ${sourceRoot}`,
    );
  }
  if (existsSync(stageRoot)) {
    throw new Error(`Symbian mass-storage stage already exists: ${stageRoot}`);
  }

  const sourceFiles: SourceFile[] = [];
  collectSourceFiles(sourceRoot, sourceRoot, [], sourceFiles);
  if (sourceFiles.length === 0) {
    throw new Error("Symbian mass-storage data root contains no regular files");
  }
  sourceFiles.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0
  );
  const folded = new Set<string>();
  for (const file of sourceFiles) {
    const key = file.relativePath.toLowerCase();
    if (folded.has(key)) {
      throw new Error(
        `Symbian mass-storage data has a case-insensitive collision: ${file.relativePath}`,
      );
    }
    folded.add(key);
  }

  const filesRoot = join(stageRoot, SYMBIAN_MASS_STORAGE_FILES);
  mkdirSync(filesRoot, { recursive: true });
  const data: SymbianMassStorageDataEntry[] = [];
  for (const file of sourceFiles) {
    const before = lstatSync(file.source);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(
        `Symbian mass-storage data changed while staging: ${file.relativePath}`,
      );
    }
    const destination = join(
      filesRoot,
      ...file.relativePath.split("/"),
    );
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.source, destination, constants.COPYFILE_EXCL);
    const after = lstatSync(file.source);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(
        `Symbian mass-storage data changed while staging: ${file.relativePath}`,
      );
    }
    const staged = statSync(destination);
    if (!Number.isSafeInteger(staged.size)) {
      throw new Error(
        `Symbian mass-storage data file is too large to manifest safely: ${file.relativePath}`,
      );
    }
    data.push({
      path: file.relativePath,
      bytes: staged.size,
      sha256: sha256FileSync(destination),
    });
  }

  const manifest: SymbianMassStorageDataManifest = {
    schemaVersion: 1,
    data,
  };
  writeFileSync(
    join(stageRoot, SYMBIAN_MASS_STORAGE_MANIFEST),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

export function resolveSymbianMassStorageDataRoot(
  root: string | undefined,
  coreLibrary: string | undefined,
): string | undefined {
  if (root === undefined) return undefined;
  if (root.trim().length === 0) {
    throw new Error("Symbian mass-storage data root must not be empty");
  }
  if (coreLibrary === undefined) {
    throw new Error(
      "Symbian mass-storage data requires an application-specific --core-library",
    );
  }
  return resolve(root);
}
