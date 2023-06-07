var path = require('path')
var DecompressZip = require('decompress-zip');
var config = require('./config.json');

import * as httpc from 'typed-rest-client/HttpClient';
import * as engine from 'artifact-engine/Engine';
import * as providers from 'artifact-engine/Providers';
import * as tl from 'azure-pipelines-task-lib/task';
import * as tr from 'azure-pipelines-task-lib/toolrunner';

const area: string = 'PowerDocu';
const userAgent: string = `powerdocu-${config.PowerDocuVersion}`;
const powerDocuVersion: string = config.PowerDocuVersion;

interface PowerDocuRelease {
    Url: string;
    Filename: string;
    Version: string;
}

function getDefaultProps() {
    var hostType = (tl.getVariable('SYSTEM.HOSTTYPE') || "").toLowerCase();
    return {
        hostType: hostType,
        definitionName: '[NonEmail:' + (hostType === 'release' ? tl.getVariable('RELEASE.DEFINITIONNAME') : tl.getVariable('BUILD.DEFINITIONNAME')) + ']',
        processId: hostType === 'release' ? tl.getVariable('RELEASE.RELEASEID') : tl.getVariable('BUILD.BUILDID'),
        processUrl: hostType === 'release' ? tl.getVariable('RELEASE.RELEASEWEBURL') : (tl.getVariable('SYSTEM.TEAMFOUNDATIONSERVERURI') + tl.getVariable('SYSTEM.TEAMPROJECT') + '/_build?buildId=' + tl.getVariable('BUILD.BUILDID')),
        taskDisplayName: tl.getVariable('TASK.DISPLAYNAME'),
        jobid: tl.getVariable('SYSTEM.JOBID'),
        agentVersion: tl.getVariable('AGENT.VERSION'),
        agentOS: tl.getVariable('AGENT.OS'),
        agentName: tl.getVariable('AGENT.NAME'),
        version: config.version
    };
}

function publishTelemetry(feature, properties: any): void {
    try {
        var splitVersion = (process.env.AGENT_VERSION || '').split('.');
        var major = parseInt(splitVersion[0] || '0');
        var minor = parseInt(splitVersion[1] || '0');
        let telemetry = '';
        if (major > 2 || (major == 2 && minor >= 120)) {
            telemetry = `##vso[telemetry.publish area=${area};feature=${feature}]${JSON.stringify(Object.assign(getDefaultProps(), properties))}`;
        }
        else {
            if (feature === 'reliability') {
                let reliabilityData = properties;
                telemetry = "##vso[task.logissue type=error;code=" + reliabilityData.issueType + ";agentVersion=" + tl.getVariable('Agent.Version') + ";taskId=" + area + "-" + JSON.stringify(config.version) + ";]" + reliabilityData.errorMessage
            }
        }
        tl.debug(telemetry);
    }
    catch (err) {
        tl.warning("Failed to log telemetry, error: " + err);
    }
}

async function getPowerDocuRelease(handler): Promise<PowerDocuRelease> {
    return new Promise<PowerDocuRelease>((resolve, reject) => {
        let httpClient: httpc.HttpClient = new httpc.HttpClient(userAgent, [handler], { ignoreSslError: true });
        let latestReleaseUrl = `${config.GitHubRepository}/releases/tags/${powerDocuVersion}`;
        latestReleaseUrl = latestReleaseUrl.replace(/([^:]\/)\/+/g, "$1");

        tl.debug(`Fetching release from ${latestReleaseUrl}`);
        httpClient.get(latestReleaseUrl).then((res) => {
            res.readBody().then((body) => {
                let response = JSON.parse(body);
                let selfContainedRelease = response["assets"].filter(o => o.name.includes('selfcontained'))[0];
                tl.debug(`Found release on GitHub ${selfContainedRelease.name} with download URL ${selfContainedRelease.browser_download_url}`);

                let release: PowerDocuRelease = {
                    Url: selfContainedRelease.browser_download_url,
                    Filename: selfContainedRelease.name,
                    Version: response["tag_name"]
                }
                resolve(release);
            });
        }, (reason) => {
            reject(reason);
            tl.warning(`Failed to retrieve self contained release reason: ${reason}`)
        });
    });
}

function executeWithRetries<T>(operationName: string, operation: () => Promise<T>, retryCount): Promise<T> {
    var executePromise = new Promise<T>((resolve, reject) => {
        executeWithRetriesImplementation(operationName, operation, retryCount, resolve, reject);
    });

    return executePromise;
}

function executeWithRetriesImplementation<T>(operationName: string, operation: () => Promise<T>, currentRetryCount, resolve, reject) {
    operation().then((result) => {
        resolve(result);
    }).catch((error) => {
        if (currentRetryCount <= 0) {
            tl.error(tl.loc("OperationFailed", operationName, error));
            reject(error);
        }
        else {
            tl.debug(tl.loc('RetryingOperation', operationName, currentRetryCount));
            currentRetryCount = currentRetryCount - 1;
            setTimeout(() => executeWithRetriesImplementation(operationName, operation, currentRetryCount, resolve, reject), 4 * 1000);
        }
    });
}

function getCliWithArguments(): Promise<tr.ToolRunner> {
    return new Promise<tr.ToolRunner>((resolve, reject) => {
        try {
            let itemsToDocument = tl.getInput('itemsToDocument', true);
            let markDown = tl.getBoolInput('markDown', false);
            let word = tl.getBoolInput('word', false);
            let changesOnly = tl.getBoolInput('changesOnly', false);
            let defaultValues = tl.getBoolInput('defaultValues', false);
            let sortFlowsByName = tl.getBoolInput('sortFlowsByName', false);
            let wordTemplate = tl.getInput('wordTemplate', false);

            let cli = tl.tool(tl.which('pwsh') || tl.which('powershell') || tl.which('pwsh', true))
                .arg('-NoLogo')
                .arg('-NoProfile')
                .arg('-NonInteractive')
                .arg('.\\PowerDocu.CLI.exe')
                .arg('-p')
                .arg(itemsToDocument)
                .argIf(markDown, '-m')
                .argIf(word, '-w')
                .argIf(changesOnly, '-c')
                .argIf(defaultValues, '-d')
                .argIf(sortFlowsByName, '-s')
                .argIf(wordTemplate != '', '-t')
                .argIf(wordTemplate != '', wordTemplate);

            resolve(cli);
        } catch (err) {
            tl.warning(`Failed to build CLI with arguments reason: ${err}`)
            reject(err)
        }
    })
}

async function unzipRelease(release: PowerDocuRelease): Promise<void> {
    await new Promise<void>(function (resolve, reject) {
        let zipLocation = path.join(__dirname, release.Filename);
        tl.debug('Extracting ' + zipLocation);

        var unzipper = new DecompressZip(zipLocation);
        unzipper.on('error', err => {
            tl.warning(`Failed to Unzip PowerDocu reason: ${err}`)
            return reject(tl.loc("ExtractionFailed", err))
        });
        unzipper.on('extract', log => {
            tl.debug('Extracted to ' + path.join(__dirname, userAgent));
            return resolve();
        });
        unzipper.extract({
            path: path.join(__dirname, userAgent)
        });
    });
}

async function downloadGitHubRelease(release: PowerDocuRelease): Promise<void> {
    await new Promise<void>(async (resolve, reject) => {
        var customCredentialHandler = {
            canHandleAuthentication: () => false,
            handleAuthentication: () => { },
            prepareRequest: (options) => { }
        };
        var downloader = new engine.ArtifactEngine();
        var zipProvider = new providers.ZipProvider(release.Url, customCredentialHandler, { ignoreSslError: true });
        var filesystemProvider = new providers.FilesystemProvider(path.join(__dirname, release.Filename));
        var parallelLimit: number = +tl.getVariable("release.artifact.download.parallellimit");
        var downloaderOptions = new engine.ArtifactEngineOptions();
        downloaderOptions.itemPattern = '**';
        var debugMode = tl.getVariable('System.Debug');
        downloaderOptions.verbose = debugMode ? debugMode.toLowerCase() != 'false' : false;

        if (parallelLimit) {
            downloaderOptions.parallelProcessingLimit = parallelLimit;
        }

        await downloader.processItems(zipProvider, filesystemProvider, downloaderOptions).then(async () => {
            resolve();
        }).catch(err => {
            tl.warning(`Failed to download PowerDocu release ${release.Version} reason: ${err}`)
            reject(err);
        });
    })
}

async function main(): Promise<void> {
    var promise = new Promise<void>(async (resolve, reject) => {
        try {
            var customCredentialHandler = {
                canHandleAuthentication: () => false,
                handleAuthentication: () => { },
                prepareRequest: (options) => { }
            };

            let powerDocuRelease = await executeWithRetries("getPowerDocuRelease", () => getPowerDocuRelease(customCredentialHandler), 3);
            tl.debug(`PowerDocu release found: ${powerDocuRelease.Version}`);

            tl.debug(`Downloading ZIP from ${powerDocuRelease.Url}`)
            await downloadGitHubRelease(powerDocuRelease).then(async () => {
                tl.debug(`Unzipping release ${powerDocuRelease.Filename}`)
                await unzipRelease(powerDocuRelease);
            })

            const aggregatedStderr: string[] = [];
            let stderrFailure = false;

            var cli = await getCliWithArguments();
            let options: tr.IExecOptions = {
                cwd: path.join(__dirname, userAgent),
                failOnStdErr: false,
                errStream: process.stdout,
                outStream: process.stdout,
                ignoreReturnCode: true
            };

            cli.on('stderr', (data: Buffer) => {
                stderrFailure = true;
                aggregatedStderr.push(data.toString('utf8'));
            });

            let exitCode: number = await cli.exec(options);

            if (exitCode !== 0) {
                reject(exitCode);
            }

            if (stderrFailure) {
                aggregatedStderr.forEach((err: string) => {
                    tl.error(err);
                });

                reject(aggregatedStderr);
            }

            resolve();
        } catch (err: any) {
            tl.error(`Unexpected error ${err}`)
            reject(err);
        }
    });

    return promise;
}

main()
    .then((result) => {
        tl.setResult(tl.TaskResult.Succeeded, "", true);
    })
    .catch((err) => {
        //publishTelemetry('reliability', { issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
        tl.setResult(tl.TaskResult.Failed, err, true);
    });

