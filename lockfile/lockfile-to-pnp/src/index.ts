import { promises as fs } from 'fs'
import path from 'path'
import { type LockfileObject } from '@pnpm/lockfile.fs'
import {
  nameVerFromPkgSnapshot,
} from '@pnpm/lockfile.utils'
import { type Registries } from '@pnpm/types'
import { depPathToFilename, refToRelative } from '@pnpm/dependency-path'
import { generateInlinedScript, type PackageRegistry } from '@yarnpkg/pnp'
import normalizePath from 'normalize-path'

export async function writePnpFile (
  lockfile: LockfileObject,
  opts: {
    importerNames: Record<string, string>
    lockfileDir: string
    virtualStoreDir: string
    virtualStoreDirMaxLength: number
    registries: Registries
  }
): Promise<void> {
  const packageRegistry = lockfileToPackageRegistry(lockfile, opts)

  const loaderFile = generateInlinedScript({
    dependencyTreeRoots: [],
    ignorePattern: undefined,
    packageRegistry,
    shebang: undefined,
  })
  await fs.writeFile(path.join(opts.lockfileDir, '.pnp.cjs'), loaderFile, 'utf8')
}

export function lockfileToPackageRegistry (
  lockfile: LockfileObject,
  opts: {
    importerNames: { [importerId: string]: string }
    lockfileDir: string
    virtualStoreDir: string
    virtualStoreDirMaxLength: number
    registries: Registries
  }
): PackageRegistry {
  const packageRegistry = new Map()
  for (const [importerId, importer] of Object.entries(lockfile.importers)) {
    if (importerId === '.') {
      const packageStore = new Map([
        [
          null,
          {
            packageDependencies: new Map([
              ...((importer.dependencies != null) ? toPackageDependenciesMap(lockfile, importer.dependencies) : []),
              ...((importer.optionalDependencies != null) ? toPackageDependenciesMap(lockfile, importer.optionalDependencies) : []),
              ...((importer.devDependencies != null) ? toPackageDependenciesMap(lockfile, importer.devDependencies) : []),
            ]),
            packageLocation: './',
          },
        ],
      ])
      packageRegistry.set(null, packageStore)
    } else {
      const name = opts.importerNames[importerId]
      const packageStore = new Map([
        [
          importerId,
          {
            packageDependencies: new Map([
              [name, importerId],
              ...((importer.dependencies != null) ? toPackageDependenciesMap(lockfile, importer.dependencies, importerId) : []),
              ...((importer.optionalDependencies != null) ? toPackageDependenciesMap(lockfile, importer.optionalDependencies, importerId) : []),
              ...((importer.devDependencies != null) ? toPackageDependenciesMap(lockfile, importer.devDependencies, importerId) : []),
            ]),
            packageLocation: `./${importerId}`,
          },
        ],
      ])
      packageRegistry.set(name, packageStore)
    }
  }
  for (const [relDepPath, pkgSnapshot] of Object.entries(lockfile.packages ?? {})) {
    const { name, version, peerDepGraphHash } = nameVerFromPkgSnapshot(relDepPath, pkgSnapshot)
    const pnpVersion = toPnPVersion(version, peerDepGraphHash)
    let packageStore = packageRegistry.get(name)
    if (!packageStore) {
      packageStore = new Map()
      packageRegistry.set(name, packageStore)
    }

    // Seems like this field should always contain a relative path
    let packageLocation = normalizePath(path.relative(opts.lockfileDir, path.join(
      opts.virtualStoreDir,
      depPathToFilename(relDepPath, opts.virtualStoreDirMaxLength),
      'node_modules',
      name
    )))
    if (!packageLocation.startsWith('../')) {
      packageLocation = `./${packageLocation}`
    }
    packageStore.set(pnpVersion, {
      packageDependencies: new Map([
        [name, pnpVersion],
        ...((pkgSnapshot.dependencies != null) ? toPackageDependenciesMap(lockfile, pkgSnapshot.dependencies) : []),
        ...((pkgSnapshot.optionalDependencies != null) ? toPackageDependenciesMap(lockfile, pkgSnapshot.optionalDependencies) : []),
      ]),
      packageLocation,
    })
  }

  return packageRegistry
}

function toPackageDependenciesMap (
  lockfile: LockfileObject,
  deps: {
    [depAlias: string]: string
  },
  importerId?: string
): Array<[string, string | [string, string]]> {
  return Object.entries(deps).map(([depAlias, ref]) => {
    if (importerId && ref.startsWith('link:')) {
      return [depAlias, path.join(importerId, ref.slice(5))]
    }
    const relDepPath = refToRelative(ref, depAlias)
    if (!relDepPath) return [depAlias, ref]
    const { name, version, peerDepGraphHash } = nameVerFromPkgSnapshot(relDepPath, lockfile.packages![relDepPath])
    const pnpVersion = toPnPVersion(version, peerDepGraphHash)
    if (depAlias === name) {
      return [depAlias, pnpVersion]
    }
    return [depAlias, [name, pnpVersion]]
  })
}

function toPnPVersion (version: string, peerDepGraphHash: string | undefined) {
  return peerDepGraphHash
    ? `virtual:${version}${peerDepGraphHash}#${version}`
    : version
}
