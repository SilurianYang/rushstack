/**
 * @Copyright (c) Microsoft Corporation.  All rights reserved.
 */

import * as path from 'path';
import * as fsx from 'fs-extra';
import * as os from 'os';
import * as semver from 'semver';

import rushVersion from '../rushVersion';
import Validator = require('z-schema');
import JsonFile from '../utilities/JsonFile';
import RushConfigurationProject, { IRushConfigurationProjectJson } from './RushConfigurationProject';
import Utilities from '../utilities/Utilities';

/**
 * This represents the JSON data structure for the "rush.json" configuration file.
 * See rush-schema.json for documentation.
 */
export interface IRushConfigurationJson {
  $schema: string;
  commonFolder: string;
  npmVersion: string;
  rushMinimumVersion: string;
  nodeSupportedVersionRange?: string;
  projectFolderMinDepth?: number;
  projectFolderMaxDepth?: number;
  packageReviewFile?: string;
  reviewCategories?: string[];
  useLocalNpmCache?: boolean;
  projects: IRushConfigurationProjectJson[];
}

/**
 * This represents the JSON data structure for the "rush-link.json" data file.
 */
export interface IRushLinkJson {
  localLinks: {
    [name: string]: string[]
  };
}

/**
 * This represents the Rush configuration for a repository, based on the Rush.json
 * configuration file.
 */
export default class RushConfiguration {
  private _rushJsonFolder: string;
  private _commonFolder: string;
  private _commonFolderName: string;
  private _cacheFolder: string;
  private _tmpFolder: string;
  private _tempModulesFolder: string;
  private _homeFolder: string;
  private _rushLinkJsonFilename: string;
  private _npmToolVersion: string;
  private _npmToolFilename: string;
  private _projectFolderMinDepth: number;
  private _projectFolderMaxDepth: number;
  private _packageReviewFile: string;
  private _reviewCategories: Set<string>;
  private _projects: RushConfigurationProject[];
  private _projectsByName: Map<string, RushConfigurationProject>;

  /**
   * Loads the configuration data from an Rush.json configuration file and returns
   * an RushConfiguration object.
   */
  public static loadFromConfigurationFile(rushJsonFilename: string): RushConfiguration {
    const rushConfigurationJson: IRushConfigurationJson = JsonFile.loadJsonFile(rushJsonFilename);

    // Check the Rush version *before* we validate the schema, since if the version is outdated
    // then the schema may have changed.
    const rushMinimumVersion: string = rushConfigurationJson.rushMinimumVersion;
    // If the version is missing or malformed, fall through and let the schema handle it.
    if (rushMinimumVersion && semver.valid(rushMinimumVersion)) {
      if (semver.lt(rushVersion, rushMinimumVersion)) {
        throw new Error(`Your rush tool is version ${rushVersion}, but rush.json`
          + ` requires version ${rushConfigurationJson.rushMinimumVersion} or newer.  To upgrade,`
          + ` run "npm install @microsoft/rush -g".`);
      }
    }

    // Remove the $schema reference that appears in the configuration object (used for IntelliSense),
    // since we are replacing it with the precompiled version.  The validator.setRemoteReference()
    // API is a better way to handle this, but we'd first need to publish the schema file
    // to a public web server where Visual Studio can find it.
    delete rushConfigurationJson.$schema;

    const validator: ZSchema.Validator = new Validator({
      breakOnFirstError: true,
      noTypeless: true
    });

    const rushSchema: Object = JsonFile.loadJsonFile(path.join(__dirname, '../rush-schema.json'));

    if (!validator.validate(rushConfigurationJson, rushSchema)) {
      const error: ZSchema.Error = validator.getLastError();

      const detail: ZSchema.ErrorDetail = error.details[0];
      const errorMessage: string = `Error parsing file '${path.basename(rushJsonFilename)}',`
        + `section[${detail.path}]:${os.EOL}(${detail.code}) ${detail.message}`;

      console.log(os.EOL + 'ERROR: ' + errorMessage + os.EOL + os.EOL);
      throw new Error(errorMessage);
    }

    return new RushConfiguration(rushConfigurationJson, rushJsonFilename);
  }

  public static loadFromDefaultLocation(): RushConfiguration {
    let currentFolder: string = process.cwd();

    // Look upwards at parent folders until we find a folder containing rush.json
    for (let i: number = 0; i < 10; ++i) {
      const rushJsonFilename: string = path.join(currentFolder, 'rush.json');

      if (fsx.existsSync(rushJsonFilename)) {
        if (i > 0) {
          console.log('Found configuration in ' + rushJsonFilename);
        }
        console.log('');
        return RushConfiguration.loadFromConfigurationFile(rushJsonFilename);
      }

      const parentFolder: string = path.dirname(currentFolder);
      if (parentFolder === currentFolder) {
        break;
      }
      currentFolder = parentFolder;
    }
    throw new Error('Unable to find rush.json configuration file');
  }

  /**
   * This generates the unique names that are used to create temporary projects
   * in the Rush common folder.
   * NOTE: sortedProjectJsons is sorted by the caller.
   */
  private static _generateTempNamesForProjects(sortedProjectJsons: IRushConfigurationProjectJson[]):
    Map<IRushConfigurationProjectJson, string> {

    const tempNamesByProject: Map<IRushConfigurationProjectJson, string> =
      new Map<IRushConfigurationProjectJson, string>();
    const usedTempNames: Set<string> = new Set<string>();

    // NOTE: projectJsons was already sorted in alphabetical order by the caller.
    for (const projectJson of sortedProjectJsons) {
      // If the name is "@ms/MyProject", extract the "MyProject" part
      const unscopedName: string = Utilities.parseScopedPackageName(projectJson.packageName).name;

      // Generate a unique like name "rush-MyProject", or "rush-MyProject-2" if
      // there is a naming conflict
      let counter: number = 0;
      let tempProjectName: string = 'rush-' + unscopedName;
      while (usedTempNames.has(tempProjectName)) {
        ++counter;
        tempProjectName = 'rush-' + unscopedName + '-' + counter;
      }
      usedTempNames.add(tempProjectName);
      tempNamesByProject.set(projectJson, tempProjectName);
    }

    return tempNamesByProject;
  }

  /**
   * DO NOT CALL -- Use RushConfiguration.loadFromConfigurationFile() or Use RushConfiguration.loadFromDefaultLocation()
   * instead.
   */
  constructor(rushConfigurationJson: IRushConfigurationJson, rushJsonFilename: string) {
    if (rushConfigurationJson.nodeSupportedVersionRange) {
      if (!semver.validRange(rushConfigurationJson.nodeSupportedVersionRange)) {
        throw new Error('Error parsing the node-semver expression in the "nodeSupportedVersionRange"'
          + ` field from rush.json: "${rushConfigurationJson.nodeSupportedVersionRange}"`);
      }
      if (!semver.satisfies(process.version, rushConfigurationJson.nodeSupportedVersionRange)) {
        throw new Error(`Your dev environment is running Node.js version ${process.version} which does`
          + ` not meet the requirements for building this repository.  (The rush.json configuration`
          + ` requires nodeSupportedVersionRange="${rushConfigurationJson.nodeSupportedVersionRange}")`);
      }
    }

    this._rushJsonFolder = path.dirname(rushJsonFilename);
    this._commonFolder = path.resolve(path.join(this._rushJsonFolder, rushConfigurationJson.commonFolder));
    if (!fsx.existsSync(this._commonFolder)) {
      throw new Error(`Rush common folder does not exist: ${rushConfigurationJson.commonFolder}`);
    }
    this._commonFolderName = path.basename(this._commonFolder);

    if (rushConfigurationJson.useLocalNpmCache) {
      this._cacheFolder = path.resolve(path.join(this._commonFolder, 'npm-cache'));
      this._tmpFolder = path.resolve(path.join(this._commonFolder, 'npm-tmp'));
    }

    this._tempModulesFolder = path.join(this._commonFolder, 'temp_modules');

    const unresolvedUserFolder: string = process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];
    this._homeFolder = path.resolve(unresolvedUserFolder);
    if (!fsx.existsSync(this._homeFolder)) {
      throw new Error('Unable to determine the current user\'s home directory');
    }

    this._rushLinkJsonFilename = path.join(this._commonFolder, 'rush-link.json');

    this._npmToolVersion = rushConfigurationJson.npmVersion;
    this._npmToolFilename = path.join(this._commonFolder, 'npm-local', 'node_modules', '.bin', 'npm');

    this._projectFolderMinDepth = rushConfigurationJson.projectFolderMinDepth !== undefined
      ? rushConfigurationJson.projectFolderMinDepth : 1;
    if (this._projectFolderMinDepth < 1) {
      throw new Error('Invalid projectFolderMinDepth; the minimum possible value is 1');
    }

    this._projectFolderMaxDepth = rushConfigurationJson.projectFolderMaxDepth !== undefined
      ? rushConfigurationJson.projectFolderMaxDepth : 2;
    if (this._projectFolderMaxDepth < this._projectFolderMinDepth) {
      throw new Error('The projectFolderMaxDepth cannot be smaller than the projectFolderMinDepth');
    }

    this._packageReviewFile = undefined;
    if (rushConfigurationJson.packageReviewFile) {
      this._packageReviewFile = path.resolve(path.join(this._rushJsonFolder, rushConfigurationJson.packageReviewFile));
      if (!fsx.existsSync(this._packageReviewFile)) {
        throw new Error('The packageReviewFile file was not found: "' + this._packageReviewFile + '"');
      }
    }

    this._reviewCategories = new Set<string>(rushConfigurationJson.reviewCategories);

    this._projects = [];
    this._projectsByName = new Map<string, RushConfigurationProject>();

    // We sort the projects array in alphabetical order.  This ensures that the packages
    // are processed in a deterministic order by the various Rush algorithms.
    const sortedProjectJsons: IRushConfigurationProjectJson[] = rushConfigurationJson.projects.slice(0);
    sortedProjectJsons.sort(
      (a: IRushConfigurationProjectJson, b: IRushConfigurationProjectJson) => a.packageName.localeCompare(b.packageName)
    );

    const tempNamesByProject: Map<IRushConfigurationProjectJson, string>
      = RushConfiguration._generateTempNamesForProjects(sortedProjectJsons);

    for (const projectJson of sortedProjectJsons) {
      const tempProjectName: string = tempNamesByProject.get(projectJson);
      const project: RushConfigurationProject = new RushConfigurationProject(projectJson, this, tempProjectName);
      this._projects.push(project);
      if (this._projectsByName.get(project.packageName)) {
        throw new Error(`The project name "${project.packageName}" was specified more than once`
          + ` in the rush.json configuration file.`);
      }
      this._projectsByName.set(project.packageName, project);
    }

    for (const project of this._projects) {
      project.cyclicDependencyProjects.forEach((cyclicDependencyProject: string) => {
        if (!this.getProjectByName(cyclicDependencyProject)) {
          throw new Error(`In rush.json, the "${cyclicDependencyProject}" project does not exist,`
            + ` but was referenced by the cyclicDependencyProjects for ${project.packageName}`);
        }
      });

      // Compute the downstream dependencies within the list of Rush projects.
      if (project.packageJson.dependencies) {
        Object.keys(project.packageJson.dependencies).forEach(dependencyName => {
          const depProject: RushConfigurationProject = this._projectsByName.get(dependencyName);

          if (depProject) {
            depProject.downstreamDependencyProjects.push(project.packageName);
          }
        });
      }
    }
  }

  /**
   * The folder that contains rush.json for this project.
   */
  public get rushJsonFolder(): string {
    return this._rushJsonFolder;
  }

  /**
   * The common folder specified in rush.json.  By default, this is the fully
   * resolved path for a subfolder of rushJsonFolder whose name is "common".
   * Example: "C:\MyRepo\common"
   */
  public get commonFolder(): string {
    return this._commonFolder;
  }

  /**
   * This is how we refer to the common folder, e.g. in error messages.
   * For example if commonFolder is "C:\MyRepo\common" then
   * commonFolderName="common".
   */
  public get commonFolderName(): string {
    return this._commonFolderName;
  }

  /**
   * The cache folder specified in rush.json. If no folder is specified, this
   * value is undefined.
   * Example: "C:\MyRepo\common\npm-cache"
   */
  public get cacheFolder(): string {
    return this._cacheFolder;
  }

  /**
   * The tmp folder specified in rush.json. If no folder is specified, this
   * value is undefined.
   * Example: "C:\MyRepo\common\npm-tmp"
   */
  public get tmpFolder(): string {
    return this._tmpFolder;
  }

  /**
   * The folder containing the temp packages generated by "rush generate".
   * Example: "C:\MyRepo\common\temp_modules"
   */
  public get tempModulesFolder(): string {
    return this._tempModulesFolder;
  }

  /**
   * The absolute path to the home directory for the current user.  On Windows,
   * it would be something like "C:\Users\YourName".
   */
  public get homeFolder(): string {
    return this._homeFolder;
  }

  /**
   * The filename of the build dependency data file.  By default this is
   * called 'rush-link.json' resides in the Rush common folder.
   * Its data structure is defined by IRushLinkJson.
   */
  public get rushLinkJsonFilename(): string {
    return this._rushLinkJsonFilename;
  }

  /**
   * The version of the locally installed NPM tool.  (Example: "1.2.3")
   */
  public get npmToolVersion(): string {
    return this._npmToolVersion;
  }

  /**
   * The absolute path to the locally installed NPM tool.  If "rush install" has not
   * been run, then this file may not exist yet.
   * Example: "C:\MyRepo\common\npm-local\node_modules\.bin\npm"
   */
  public get npmToolFilename(): string {
    return this._npmToolFilename;
  }

  /**
   * The minimum allowable folder depth for the projectFolder field in the rush.json file.
   * This setting provides a way for repository maintainers to discourage nesting of project folders
   * that makes the directory tree more difficult to navigate.  The default value is 2,
   * which implements a standard 2-level hierarchy of <categoryFolder>/<projectFolder>/package.json.
   */
  public get projectFolderMinDepth(): number {
    return this._projectFolderMinDepth;
  }

  /**
   * The maximum allowable folder depth for the projectFolder field in the rush.json file.
   * This setting provides a way for repository maintainers to discourage nesting of project folders
   * that makes the directory tree more difficult to navigate.  The default value is 2,
   * which implements on a standard convention of <categoryFolder>/<projectFolder>/package.json.
   */
  public get projectFolderMaxDepth(): number {
    return this._projectFolderMaxDepth;
  }

  /**
   * The absolute path to a JSON file that tracks the NPM packages that were approved for usage
   * in this repository.  This is part of an optional approval workflow, whose purpose is to
   * review any new dependencies that are introduced (e.g. maybe a legal review is required, or
   * maybe we are trying to minimize bloat).  When "rush generate" is run, any new
   * package.json dependencies will be appended to this file.  When "rush install" is run
   * (e.g. as part of a PR build), an error will be reported if the file is not up to date.
   * The intent is that this file will be stored in Git and tracked by a branch policy which
   * notifies reviewers whenever a PR attempts to modify the file.
   *
   * The PackageReviewConfiguration class can load/save this file format.
   *
   * Example: "C:\MyRepo\common\reviews\PackageDependenies.json"
   */
  public get packageReviewFile(): string {
    return this._packageReviewFile;
  }

  /**
   * A list of category names that are valid for usage as the RushConfigurationProject.reviewCategory field.
   * This array will never be undefined.
   */
  public get reviewCategories(): Set<string> {
    return this._reviewCategories;
  }

  public get projects(): RushConfigurationProject[] {
    return this._projects;
  }

  public get projectsByName(): Map<string, RushConfigurationProject> {
    return this._projectsByName;
  }

  public getProjectByName(projectName: string): RushConfigurationProject {
    return this._projectsByName.get(projectName);
  }
}
