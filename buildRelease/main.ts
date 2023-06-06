var path = require('path')

import * as httpc from 'typed-rest-client/HttpClient';
import * as engine from 'artifact-engine/Engine';
import * as providers from 'artifact-engine/Providers';
import * as tl from 'azure-pipelines-task-lib/task';
import * as tr from 'azure-pipelines-task-lib/toolrunner';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';

var config = require('./config.json');
var task = require('./task.json')

const area: string = 'PowerDocu';
const userAgent: string = `powerdocu-${config.version}`;
const powerDocuVersion: string = config.powerDocuVersion;

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
        console.log(telemetry);
    }
    catch (err) {
        tl.warning("Failed to log telemetry, error: " + err);
    }
}

async function getPowerDocuRelease(handler): Promise<PowerDocuRelease> {
    var promise = new Promise<PowerDocuRelease>((resolve, reject) => {
        let httpClient: httpc.HttpClient = new httpc.HttpClient(userAgent, [handler], { ignoreSslError: true });
        let latestReleaseUrl = `https://api.github.com/repos/modery/PowerDocu/releases/tags/${powerDocuVersion}`;
        latestReleaseUrl = latestReleaseUrl.replace(/([^:]\/)\/+/g, "$1");

        console.log(`Fetching release from ${latestReleaseUrl}`);
        httpClient.get(latestReleaseUrl).then((res) => {
            res.readBody().then((body) => {
                let response = JSON.parse(body);
                console.log(response);
                let selfContainedRelease = response["assets"].filter(o => o.name.includes('selfcontained'))[0];
                console.log(selfContainedRelease);
                let release: PowerDocuRelease = {
                    Url: selfContainedRelease.browser_download_url,
                    Filename: selfContainedRelease.name,
                    Version: response["tag_name"]
                }
                resolve(release);
            });
        }, (reason) => {
            reject(reason);
            console.log(`Failed to retrieve self contained release reason: ${reason}`)
        });
    });

    return promise;
}

function executeWithRetries<T>(operationName: string, operation: () => Promise<T>, retryCount): Promise<T> {
    var executePromise = new Promise<T>((resolve, reject) => {
        executeWithRetriesImplementation(operationName, operation, retryCount, resolve, reject);
    });

    return executePromise;
}

function buildCliArguments(tr: ToolRunner) {
    let itemsToDocument: string = tl.getInput('itemsToDocument', true);
    let markDown: boolean = tl.getBoolInput('markDown', false);
    let word: boolean = tl.getBoolInput('word', false);
    let changesOnly: boolean = tl.getBoolInput('changesOnly', false);
    let defaultValues: boolean = tl.getBoolInput('defaultValues', false);
    let sortFlowsByName: boolean = tl.getBoolInput('sortFlowsByName', false);
    let wordTemplate: string = tl.getInput('wordTemplate', false);

    tr.arg('.\PowerDocu.CLI.exe -p ' + itemsToDocument);

    if (markDown) {
        tr.arg('-m')
    }
    if (word) {
        tr.arg('-w')
    }
    if (changesOnly) {
        tr.arg('-c')
    }
    if (defaultValues) {
        tr.arg('-d')
    }
    if (sortFlowsByName) {
        tr.arg('-s')
    }
    if (wordTemplate != '') {
        tr.arg('-t ' + wordTemplate)
    }
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
            console.log(tl.loc('RetryingOperation', operationName, currentRetryCount));
            currentRetryCount = currentRetryCount - 1;
            setTimeout(() => executeWithRetriesImplementation(operationName, operation, currentRetryCount, resolve, reject), 4 * 1000);
        }
    });
}

function unzipRelease(release: PowerDocuRelease): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
        var destinationFolder = "C:\temp" //tl.getVariable('agent.tempdirectory');
        var unzipLocation = tl.which('unzip', true);
        var unzip = tl.tool(unzipLocation);
        unzip.arg(release.Filename);
        unzip.arg('-d');
        unzip.arg(destinationFolder);

        await unzip.exec().then(result => {
            resolve();
        }).catch(err => {
            reject(err);
        })
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
            console.log(`PowerDocu release found: ${powerDocuRelease.Filename}`);
            var templatePath = path.join(__dirname, 'powerdocu.handlebars.txt');
            var gitHubReleaseVariables = {
                "endpoint": {
                    "url": "https://api.github.com/"
                }
            };
            var downloadPath = "C:\temp" //tl.getVariable('agent.tempdirectory');

            var webProvider = new providers.WebProvider(powerDocuRelease.Url, templatePath, gitHubReleaseVariables, customCredentialHandler, { ignoreSslError: true });
            var fileSystemProvider = new providers.FilesystemProvider(downloadPath);
            var parallelLimit: number = +tl.getVariable("release.artifact.download.parallellimit");

            var downloader = new engine.ArtifactEngine();
            var downloaderOptions = new engine.ArtifactEngineOptions();
            downloaderOptions.itemPattern = '**';
            var debugMode = tl.getVariable('System.Debug');
            downloaderOptions.verbose = debugMode ? debugMode.toLowerCase() != 'false' : false;

            if (parallelLimit) {
                downloaderOptions.parallelProcessingLimit = parallelLimit;
            }
            console.log(`Downloading ZIP from ${powerDocuRelease.Url}`)
            await downloader.processItems(webProvider, fileSystemProvider, downloaderOptions);
            await unzipRelease(powerDocuRelease);

            const aggregatedStderr: string[] = [];
            let stderrFailure = false;
            let cli = tl.tool(tl.which('bash', true));
            buildCliArguments(cli);

            let options: tr.IExecOptions = {
                cwd: downloadPath,
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

