import { CodeMaker } from 'codemaker';
import * as fs from 'fs-extra';
import { Assembly } from 'jsii-reflect';
import { Rosetta } from 'jsii-rosetta';
import * as path from 'path';

import { IGenerator, Legalese } from '../generator';
import * as logging from '../logging';
import { findLocalBuildDirs, Target, TargetOptions } from '../target';
import { shell } from '../util';
import { Documentation } from './go/documentation';
import { GOMOD_FILENAME, RootPackage } from './go/package';
import { JSII_INIT_PACKAGE } from './go/runtime';
import { tarballName } from './go/util';

export class Golang extends Target {
  private readonly goGenerator: GoGenerator;

  public constructor(options: TargetOptions) {
    super(options);
    this.goGenerator = new GoGenerator(options.rosetta);
  }

  public get generator() {
    return this.goGenerator;
  }

  /**
   * Generates a publishable artifact in `outDir`.
   *
   * @param sourceDir the directory where the generated source is located.
   * @param outDir    the directory where the publishable artifact should be placed.
   */
  public async build(sourceDir: string, outDir: string): Promise<void> {
    // copy generated sources to the output directory
    await this.copyFiles(sourceDir, outDir);

    const pkgDir = path.join(outDir, this.goGenerator.rootPackage.packageName);

    // write `local.go.mod` with "replace" directives for local modules
    const localGoMod = await this.writeLocalGoMod(pkgDir);

    try {
      // run `go build` with local.go.mod, go 1.16 requires that we download
      // modules explicit so go.sum is updated.
      await go('mod', ['download', '-modfile', localGoMod], { cwd: pkgDir });
    } catch (e) {
      const content = await fs.readFile(localGoMod, 'utf8');
      logging.info(`Content of ${localGoMod} file:\n${content}`);
      return Promise.reject(e);
    }
    await go('build', ['-modfile', localGoMod, './...'], { cwd: pkgDir });

    // delete local.go.mod and local.go.sum from the output directory so it doesn't get published
    const localGoSum = `${path.basename(localGoMod, '.mod')}.sum`;
    await fs.remove(path.join(pkgDir, localGoMod));
    return fs.remove(path.join(pkgDir, localGoSum));
  }

  /**
   * Creates a copy of the `go.mod` file called `local.go.mod` with added
   * `replace` directives for local mono-repo dependencies. This is required in
   * order to run `go fmt` and `go build`.
   *
   * @param pkgDir The directory which contains the generated go code
   */
  private async writeLocalGoMod(pkgDir: string) {
    const replace: Record<string, string> = {};

    // find local deps by check if `<jsii.outdir>/go` exists for dependencies
    // and also consider `outDir` in case pacmak is executed using `--outdir
    // --recurse` (in which case all go code will be generated there).
    const dirs = [
      path.dirname(pkgDir),
      ...(await findLocalBuildDirs(this.packageDir, 'go')),
    ];

    // try to resolve @jsii/go-runtime (only exists as a devDependency)
    const localModules = tryFindLocalRuntime();
    if (localModules != null) {
      for (const [name, localPath] of Object.entries(localModules)) {
        replace[name] = localPath;
      }
    }

    // iterate (recursively) on all package dependencies and check if we have a
    // local build directory for this module. if
    // we do, add a "replace" directive to point to it instead of download from
    // the network.
    const visit = (pkg: RootPackage) => {
      for (const dep of pkg.packageDependencies) {
        for (const baseDir of dirs) {
          const moduleDir = tryFindLocalModule(baseDir, dep);
          if (moduleDir) {
            replace[dep.goModuleName] = moduleDir;

            // we found a replacement for this dep, we can stop searching
            break;
          }
        }

        // recurse to transitive deps ("replace" is only considered at the top level go.mod)
        visit(dep);
      }
    };

    visit(this.goGenerator.rootPackage);

    // write `local.go.mod`

    // read existing content
    const goMod = path.join(pkgDir, GOMOD_FILENAME);
    const lines = (await fs.readFile(goMod, 'utf-8')).split('\n');

    for (const [from, to] of Object.entries(replace)) {
      logging.info(`Local replace: ${from} => ${to}`);
      lines.push(`replace ${from} => ${to}`);
    }

    const localGoMod = `local.${GOMOD_FILENAME}`;
    await fs.writeFile(path.join(pkgDir, localGoMod), lines.join('\n'));
    return localGoMod;
  }
}

class GoGenerator implements IGenerator {
  private assembly!: Assembly;
  public rootPackage!: RootPackage;

  private readonly code = new CodeMaker({
    indentCharacter: '\t',
    indentationLevel: 1,
  });
  private readonly documenter: Documentation;

  public constructor(private readonly rosetta: Rosetta) {
    this.documenter = new Documentation(this.code, this.rosetta);
  }

  public async load(_: string, assembly: Assembly): Promise<void> {
    this.assembly = assembly;
    return Promise.resolve();
  }

  public async upToDate(_outDir: string) {
    return Promise.resolve(false);
  }

  public generate(): void {
    this.rootPackage = new RootPackage(this.assembly);

    return this.rootPackage.emit({
      code: this.code,
      documenter: this.documenter,
    });
  }

  public async save(
    outDir: string,
    tarball: string,
    { license, notice }: Legalese,
  ): Promise<any> {
    const output = path.join(outDir, this.rootPackage.packageName);
    await this.code.save(output);
    await fs.copyFile(
      tarball,
      path.join(output, JSII_INIT_PACKAGE, tarballName(this.assembly)),
    );

    if (license) {
      await fs.writeFile(path.join(output, 'LICENSE'), license, {
        encoding: 'utf8',
      });
    }

    if (notice) {
      await fs.writeFile(path.join(output, 'NOTICE'), notice, {
        encoding: 'utf8',
      });
    }
  }
}

/**
 * Checks if `buildDir` includes a local go build version (with "replace"
 * directives).
 * @param baseDir the `dist/go` directory
 * @returns `undefined` if not or the module directory otherwise.
 */
function tryFindLocalModule(baseDir: string, pkg: RootPackage) {
  const gomodPath = path.join(baseDir, pkg.packageName, GOMOD_FILENAME);
  if (!fs.pathExistsSync(gomodPath)) {
    return undefined;
  }

  // read `go.mod` and check that it is for the correct module
  const gomod = fs.readFileSync(gomodPath, 'utf-8').split('\n');
  const isExpectedModule = gomod.find(
    (line) => line.trim() === `module ${pkg.goModuleName}`,
  );

  if (!isExpectedModule) {
    return undefined;
  }

  return path.resolve(path.dirname(gomodPath));
}

/**
 * Check if we are running from inside the jsii repository, and then we want to
 * use the local runtime instead of download from a released version.
 *
 * This is a generator that procudes an entry for each local module that
 * is identified under the local module path exposed by `@jsii/go-runtime` .
 */
function tryFindLocalRuntime():
  | { readonly [name: string]: string }
  | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, import/no-extraneous-dependencies
    const localRuntime = require('@jsii/go-runtime');
    logging.debug(`Using @jsii/go-runtime from ${localRuntime.runtimePath}`);

    return localRuntime.runtimeModules;
  } catch {
    return undefined;
  }
}

/**
 * Executes a go CLI command.
 *
 *
 * @param command The `go` command to execute (e.g. `build`)
 * @param args Additional args
 * @param options Options
 */
async function go(command: string, args: string[], options: { cwd: string }) {
  const { cwd } = options;
  return shell('go', [command, ...args], {
    cwd,
    env: {
      // disable the use of sumdb to reduce eventual consistency issues when new modules are published
      GOSUMDB: 'off',
    },
  });
}
