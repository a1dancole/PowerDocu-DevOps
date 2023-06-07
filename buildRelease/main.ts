var path = require('path');
var config = require('./config.json');

import * as tl from 'azure-pipelines-task-lib/task';
import * as tr from 'azure-pipelines-task-lib/toolrunner';
import * as os from "os";
import { GitHubApi } from './github/githubapi';
import { Unzip } from './zip/unzip';
import { Retry } from './helpers/retry';

const area: string = 'PowerDocu';
const userAgent: string = `powerdocu-${config.PowerDocuVersion}`;

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

async function executeCli(cli: tr.ToolRunner, workingDirectory: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const aggregatedStderr: string[] = [];
        let stderrFailure = false;

        let options: tr.IExecOptions = {
            cwd: workingDirectory,
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
    })
}

async function main(): Promise<void> {    
    const gitHubApi = new GitHubApi();
    const unzip = new Unzip();

    var tempDirectory = tl.getVariable('Agent.TempDirectory') || os.tmpdir();
    var promise = new Promise<void>(async (resolve, reject) => {
        try {
            var customCredentialHandler = {
                canHandleAuthentication: () => false,
                handleAuthentication: () => { },
                prepareRequest: () => { }
            };

            let powerDocuRelease = await Retry.Operation('GetRelease', async () => await gitHubApi.GetRelease(`${config.GitHubRepository}/releases/tags/${config.PowerDocuVersion}`, userAgent, customCredentialHandler), 3); 
            tl.debug(`PowerDocu release found: ${powerDocuRelease.Version}`);

            await Retry.Operation('DownloadRelease', async () => await gitHubApi.DownloadRelease(powerDocuRelease.Url, path.join(tempDirectory, powerDocuRelease.Filename), customCredentialHandler), 3).then(async () => {
                await unzip.unzipRelease(path.join(tempDirectory, powerDocuRelease.Filename), tempDirectory)
            })

            var cli = await getCliWithArguments();
            await executeCli(cli, tempDirectory);

            resolve();
        } catch (err: any) {
            tl.error(`Unexpected error ${err}`)
            reject(err);
        }
    });

    return promise;
}

main()
    .then(() => {
        tl.setResult(tl.TaskResult.Succeeded, "", true);
    })
    .catch((err) => {
        publishTelemetry('reliability', { issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
        tl.setResult(tl.TaskResult.Failed, err, true);
    });

