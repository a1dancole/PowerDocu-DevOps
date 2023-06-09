var config = require('./config.json');

import path = require('path');
import tl = require('azure-pipelines-task-lib/task');
import tr = require("azure-pipelines-task-lib/toolrunner");
import os = require("os")
import { GitHubApi } from './github/githubapi';
import { Unzip } from './zip/unzip';
import { Retry } from './helpers/retry';

const area: string = 'PowerDocu';
const userAgent: string = `powerdocu-${config.PowerDocuVersion}`;

export class powerDocu {

    public static async main(): Promise<void> {
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
                console.log(`##[command] PowerDocu release found: ${powerDocuRelease.Version}`)

                await Retry.Operation('DownloadRelease', async () => await gitHubApi.DownloadRelease(powerDocuRelease.Url, path.join(tempDirectory, powerDocuRelease.Filename), customCredentialHandler), 3);

                await unzip.unzipRelease(path.join(tempDirectory, powerDocuRelease.Filename), tempDirectory)
                var cli = this.getCliWithArguments();
                await this.executeCli(cli, tempDirectory);

                resolve();
            } catch (err: any) {
                this.publishTelemetry('reliability', { issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                tl.setResult(tl.TaskResult.Failed, err, true);
                reject(err);
            }
        });

        tl.setResult(tl.TaskResult.Succeeded, "", true);
        return promise;
    }

    private static getDefaultProps() {
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

    private static publishTelemetry(feature, properties: any): void {
        try {
            var splitVersion = (process.env.AGENT_VERSION || '').split('.');
            var major = parseInt(splitVersion[0] || '0');
            var minor = parseInt(splitVersion[1] || '0');
            let telemetry = '';
            if (major > 2 || (major == 2 && minor >= 120)) {
                telemetry = `##vso[telemetry.publish area=${area};feature=${feature}]${JSON.stringify(Object.assign(this.getDefaultProps(), properties))}`;
            }
            else {
                if (feature === 'reliability') {
                    let reliabilityData = properties;
                    telemetry = "##vso[task.logissue type=error;code=" + reliabilityData.issueType + ";agentVersion=" + tl.getVariable('Agent.Version') + ";taskId=" + area + "-" + JSON.stringify(config.version) + ";]" + reliabilityData.errorMessage
                }
            }
        }
        catch (err) {
            console.log(`##[warning]Failed to log telemetry, error: ${err}`)
        }
    }

    private static getCliWithArguments(): tr.ToolRunner {

        let itemsToDocument = tl.getPathInput('itemsToDocument', true, true);
        console.log(`##[command] itemsToDocument=${itemsToDocument}`)
        let outputPath = tl.getPathInput('outputPath', false);
        console.log(`##[command] outputPath=${outputPath}`)
        let markDown = tl.getBoolInput('markDown', false);
        console.log(`##[command] markDown=${markDown}`)
        let word = tl.getBoolInput('word', false);
        console.log(`##[command] word=${word}`)
        let changesOnly = tl.getBoolInput('changesOnly', false);
        console.log(`##[command] changesOnly=${changesOnly}`)
        let defaultValues = tl.getBoolInput('defaultValues', false);
        console.log(`##[command] defaultValues=${defaultValues}`)
        let sortFlowsByName = tl.getBoolInput('sortFlowsByName', false);
        console.log(`##[command] sortFlowsByName=${sortFlowsByName}`)
        let wordTemplate = tl.getPathInput('wordTemplate', false);
        console.log(`##[command] wordTemplate=${wordTemplate}`);

        let cli = tl.tool(tl.which('pwsh') || tl.which('powershell') || tl.which('pwsh', true))
            .arg('-NoLogo')
            .arg('-NoProfile')
            .arg('-NonInteractive')
            .arg('.\\PowerDocu.CLI.exe')
            .arg('-p')
            .arg(itemsToDocument)
            .argIf(outputPath != '', '-o')
            .argIf(outputPath != '', outputPath)
            .argIf(markDown, '-m')
            .argIf(word, '-w')
            .argIf(changesOnly, '-c')
            .argIf(defaultValues, '-d')
            .argIf(sortFlowsByName, '-s')
            .argIf(wordTemplate != '', '-t')
            .argIf(wordTemplate != '', wordTemplate);

        return cli;
    }

    private static async executeCli(cli: tr.ToolRunner, workingDirectory: string): Promise<void> {
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

            cli.on('stdout', (data: Buffer) => {
                console.log(`##[command] ${data.toString('utf8')}`)
            });

            cli.on('stderr', (data: Buffer) => {
                stderrFailure = true;
                aggregatedStderr.push(data.toString('utf8'));
            });

            await cli.exec(options);

            if (stderrFailure) {
                aggregatedStderr.forEach((err: string) => {
                    tl.warning(err);
                });
            }

            resolve();
        })
    }

}

powerDocu.main();
