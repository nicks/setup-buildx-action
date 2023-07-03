import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';
import * as util from 'util';
import * as path from 'path';
import {URL} from 'url';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import * as github from '@actions/github';
import {GitHub as Octokit} from '@actions/github/lib/utils';
import * as actionsToolkit from '@docker/actions-toolkit';
import {Buildx} from '@docker/actions-toolkit/lib/buildx/buildx';
import {Builder} from '@docker/actions-toolkit/lib/buildx/builder';
import {Docker} from '@docker/actions-toolkit/lib/docker/docker';
import {Toolkit} from '@docker/actions-toolkit/lib/toolkit';
import {Util} from '@docker/actions-toolkit/lib/util';
import {Node} from '@docker/actions-toolkit/lib/types/builder';

import * as context from './context';
import * as stateHelper from './state-helper';

actionsToolkit.run(
  // main
  async () => {
    const inputs: context.Inputs = await context.getInputs();
    stateHelper.setCleanup(inputs.cleanup);

    const toolkit = new Toolkit();
    const standalone = await toolkit.buildx.isStandalone();
    stateHelper.setStandalone(standalone);

    await core.group(`Docker info`, async () => {
      try {
        await Docker.printVersion();
        await Docker.printInfo();
      } catch (e) {
        core.info(e.message);
      }
    });

    let toolPath;
    if (Util.isValidRef(inputs.version)) {
      if (isGitHubVersion(inputs.version)) {
        // Download a fork of buildx.
        await core.group(`Download buildx from GitHub Releases`, async () => {
          toolPath = await downloadBuildxFork(inputs.version);
        });
      }
      if (standalone) {
        throw new Error(`Cannot build from source without the Docker CLI`);
      }
      if (!toolPath) {
        await core.group(`Build buildx from source`, async () => {
          core.info(`CHECKING ${inputs.version} ${isGitHubVersion(inputs.version)}`)
          throw new Error('xxx');
          toolPath = await toolkit.buildxInstall.build(inputs.version);
        });
      }
    } else if (!(await toolkit.buildx.isAvailable()) || inputs.version) {
      await core.group(`Download buildx from GitHub Releases`, async () => {
        toolPath = await toolkit.buildxInstall.download(inputs.version || 'latest');
      });
    }
    if (toolPath) {
      await core.group(`Install buildx`, async () => {
        if (standalone) {
          await toolkit.buildxInstall.installStandalone(toolPath);
        } else {
          await toolkit.buildxInstall.installPlugin(toolPath);
        }
      });
    }

    await core.group(`Buildx version`, async () => {
      await toolkit.buildx.printVersion();
    });

    core.setOutput('name', inputs.name);
    stateHelper.setBuilderName(inputs.name);
    stateHelper.setBuilderDriver(inputs.driver);

    fs.mkdirSync(Buildx.certsDir, {recursive: true});
    stateHelper.setCertsDir(Buildx.certsDir);

    if (inputs.driver !== 'docker') {
      await core.group(`Creating a new builder instance`, async () => {
        const certsDriverOpts = Buildx.resolveCertsDriverOpts(inputs.driver, inputs.endpoint, {
          cacert: process.env[`${context.builderNodeEnvPrefix}_0_AUTH_TLS_CACERT`],
          cert: process.env[`${context.builderNodeEnvPrefix}_0_AUTH_TLS_CERT`],
          key: process.env[`${context.builderNodeEnvPrefix}_0_AUTH_TLS_KEY`]
        });
        if (certsDriverOpts.length > 0) {
          inputs.driverOpts = [...inputs.driverOpts, ...certsDriverOpts];
        }
        const createCmd = await toolkit.buildx.getCommand(await context.getCreateArgs(inputs, toolkit));
        await exec.exec(createCmd.command, createCmd.args);
      });
    }

    if (inputs.append) {
      await core.group(`Appending node(s) to builder`, async () => {
        let nodeIndex = 1;
        const nodes = yaml.load(inputs.append) as Node[];
        for (const node of nodes) {
          const certsDriverOpts = Buildx.resolveCertsDriverOpts(inputs.driver, `${node.endpoint}`, {
            cacert: process.env[`${context.builderNodeEnvPrefix}_${nodeIndex}_AUTH_TLS_CACERT`],
            cert: process.env[`${context.builderNodeEnvPrefix}_${nodeIndex}_AUTH_TLS_CERT`],
            key: process.env[`${context.builderNodeEnvPrefix}_${nodeIndex}_AUTH_TLS_KEY`]
          });
          if (certsDriverOpts.length > 0) {
            node['driver-opts'] = [...(node['driver-opts'] || []), ...certsDriverOpts];
          }
          const appendCmd = await toolkit.buildx.getCommand(await context.getAppendArgs(inputs, node, toolkit));
          await exec.exec(appendCmd.command, appendCmd.args);
          nodeIndex++;
        }
      });
    }

    await core.group(`Booting builder`, async () => {
      const inspectCmd = await toolkit.buildx.getCommand(await context.getInspectArgs(inputs, toolkit));
      await exec.exec(inspectCmd.command, inspectCmd.args);
    });

    if (inputs.install) {
      if (standalone) {
        throw new Error(`Cannot set buildx as default builder without the Docker CLI`);
      }
      await core.group(`Setting buildx as default builder`, async () => {
        const installCmd = await toolkit.buildx.getCommand(['install']);
        await exec.exec(installCmd.command, installCmd.args);
      });
    }

    const builderInspect = await toolkit.builder.inspect(inputs.name);
    const firstNode = builderInspect.nodes[0];

    await core.group(`Inspect builder`, async () => {
      const reducedPlatforms: Array<string> = [];
      for (const node of builderInspect.nodes) {
        for (const platform of node.platforms?.split(',') || []) {
          if (reducedPlatforms.indexOf(platform) > -1) {
            continue;
          }
          reducedPlatforms.push(platform);
        }
      }
      core.info(JSON.stringify(builderInspect, undefined, 2));
      core.setOutput('driver', builderInspect.driver);
      core.setOutput('platforms', reducedPlatforms.join(','));
      core.setOutput('nodes', JSON.stringify(builderInspect.nodes, undefined, 2));
      core.setOutput('endpoint', firstNode.endpoint); // TODO: deprecated, to be removed in a later version
      core.setOutput('status', firstNode.status); // TODO: deprecated, to be removed in a later version
      core.setOutput('flags', firstNode['buildkitd-flags']); // TODO: deprecated, to be removed in a later version
    });

    if (!standalone && builderInspect.driver == 'docker-container') {
      stateHelper.setContainerName(`${Buildx.containerNamePrefix}${firstNode.name}`);
      await core.group(`BuildKit version`, async () => {
        for (const node of builderInspect.nodes) {
          const buildkitVersion = await toolkit.buildkit.getVersion(node);
          core.info(`${node.name}: ${buildkitVersion}`);
        }
      });
    }
    if (core.isDebug() || firstNode['buildkitd-flags']?.includes('--debug')) {
      stateHelper.setDebug('true');
    }
  },
  // post
  async () => {
    if (stateHelper.IsDebug && stateHelper.containerName.length > 0) {
      await core.group(`BuildKit container logs`, async () => {
        await exec
          .getExecOutput('docker', ['logs', `${stateHelper.containerName}`], {
            ignoreReturnCode: true
          })
          .then(res => {
            if (res.stderr.length > 0 && res.exitCode != 0) {
              core.warning(res.stderr.trim());
            }
          });
      });
    }

    if (!stateHelper.cleanup) {
      return;
    }

    if (stateHelper.builderDriver != 'docker' && stateHelper.builderName.length > 0) {
      await core.group(`Removing builder`, async () => {
        const buildx = new Buildx({standalone: stateHelper.standalone});
        const builder = new Builder({buildx: buildx});
        if (await builder.exists(stateHelper.builderName)) {
          const rmCmd = await buildx.getCommand(['rm', stateHelper.builderName]);
          await exec
            .getExecOutput(rmCmd.command, rmCmd.args, {
              ignoreReturnCode: true
            })
            .then(res => {
              if (res.stderr.length > 0 && res.exitCode != 0) {
                core.warning(res.stderr.trim());
              }
            });
        } else {
          core.info(`${stateHelper.builderName} does not exist`);
        }
      });
    }

    if (stateHelper.certsDir.length > 0 && fs.existsSync(stateHelper.certsDir)) {
      await core.group(`Cleaning up certificates`, async () => {
        fs.rmSync(stateHelper.certsDir, {recursive: true});
      });
    }
  }
);

function isGitHubVersion(version: string): boolean {
  return version.startsWith('https://github.com/');
}

async function downloadBuildxFork(url: string): Promise<string> {
  const targetFile: string = os.platform() == 'win32' ? 'docker-buildx.exe' : 'docker-buildx';
  let [base, version] = url.split('#');
  if (!version) {
    return "";
  }
  if (!version.startsWith('v')) {
    core.info(`Only supports v-prefixed releases`)
    return "";
  }
  version = version.substring(1)

  if (!base.startsWith('https://github.com/')) {
    core.info(`Only supports github releases. Actual: ${base}`)
    return "";
  }
  
  let [owner, repo] = base.substring('https://github.com/'.length).split('/');
  if (!owner || !repo) {
    core.info(`Only supports github releases. Actual: ${base}, owner: ${owner}, repo: ${repo}`)
    return "";
  }
  if (repo.endsWith('.git')) {
    repo = repo.substring(0, repo.length - 4);
  }

  core.info(`Checking for releases in ${owner}/${repo}`);
  const cachedPath = tc.find('buildx', version, platform());
  if (cachedPath) {
    core.info(`Using cached download ${version}`);
    return cachedPath;
  }
  
  const octokit = github.getOctokit(process.env.GIT_AUTH_TOKEN || '');
  const release = await octokit.request('GET https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}', {
    repo: repo,
    owner: owner,
    tag: 'v' + version,
  })

  const expectedFilename = filename(version);
  const asset = release.data.assets.find((asset) => asset.name == expectedFilename);
  if (!asset) {
    core.info(`Could not find download asset: ${asset}`)
    return "";
  }
  const downloadURL = asset.url;
  core.info(`Downloading ${asset.name} from ${downloadURL}`);

  let auth: string | undefined = undefined;
  if (process.env.GIT_AUTH_TOKEN) {
    auth = `Bearer ${process.env.GIT_AUTH_TOKEN}`
  }
  const downloadPath = await tc.downloadTool(downloadURL.toString(), undefined, auth, {
    'Accept': 'application/octet-stream',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  core.debug(`Install.fetchBinary downloadPath: ${downloadPath}`);
  return await tc.cacheFile(downloadPath, targetFile, 'buildx', version, platform());
}

function platform(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arm_version = (process.config.variables as any).arm_version;
  return `${os.platform()}-${os.arch()}${arm_version ? 'v' + arm_version : ''}`;
}

function filename(version: string): string {
  let arch: string;
  switch (os.arch()) {
    case 'x64': {
      arch = 'amd64';
      break;
    }
    case 'ppc64': {
      arch = 'ppc64le';
      break;
    }
    case 'arm': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arm_version = (process.config.variables as any).arm_version;
      arch = arm_version ? 'arm-v' + arm_version : 'arm';
      break;
    }
    default: {
      arch = os.arch();
      break;
    }
  }
  const platform: string = os.platform() == 'win32' ? 'windows' : os.platform();
  const ext: string = os.platform() == 'win32' ? '.exe' : '';
  return util.format('buildx-v%s.%s-%s%s', version, platform, arch, ext);
}
