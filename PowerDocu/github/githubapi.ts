import { GithubRelease } from "../models/github-release";
import { PowerDocuRelease } from "../models/powerdocu-release";
import * as httpc from 'typed-rest-client/HttpClient';
import * as engine from 'artifact-engine/Engine';
import * as providers from 'artifact-engine/Providers';
import * as tl from 'azure-pipelines-task-lib/task';

var path = require('path');

export class GitHubApi {

    public async GetRelease(url: string, name: string, handler): Promise<PowerDocuRelease> {
        return new Promise<PowerDocuRelease>((resolve, reject) => {
            let httpClient: httpc.HttpClient = new httpc.HttpClient(name, [handler], { ignoreSslError: true });
            url = url.replace(/([^:]\/)\/+/g, "$1");

            console.log(`##[command] Fetching release from ${url}`)
            httpClient.get(url).then((res) => {
                res.readBody().then((body) => {
                    let response: GithubRelease = JSON.parse(body);
                    let selfContainedRelease = response.assets.filter(o => o.name.includes('selfcontained'))[0];
                    console.log(`##[command] Found release on GitHub ${selfContainedRelease.name} with download URL ${selfContainedRelease.browser_download_url}`)

                    let release: PowerDocuRelease = {
                        Url: selfContainedRelease.browser_download_url,
                        Filename: selfContainedRelease.name,
                        Version: response["tag_name"]
                    }
                    resolve(release);
                });
            }, (reason) => {
                console.log(`##[warning] Failed to retrieve self contained release reason: ${reason}`)
                reject(reason);
            });
        });
    }

    public async DownloadRelease(url: string, targetPath: string, handler): Promise<void> {
        await new Promise<void>(async (resolve, reject) => {
 
            var downloader = new engine.ArtifactEngine();
            var zipProvider = new providers.ZipProvider(url, handler, { ignoreSslError: true });
            var filesystemProvider = new providers.FilesystemProvider(targetPath);
            var parallelLimit: number = +tl.getVariable("release.artifact.download.parallellimit");
            var downloaderOptions = new engine.ArtifactEngineOptions();
            downloaderOptions.itemPattern = '**';
            var debugMode = tl.getVariable('System.Debug');
            downloaderOptions.verbose = debugMode ? debugMode.toLowerCase() != 'false' : false;
    
            if (parallelLimit) {
                downloaderOptions.parallelProcessingLimit = parallelLimit;
            }
    
            await downloader.processItems(zipProvider, filesystemProvider, downloaderOptions).then(async (result) => {        
                tl.debug(`Downloaded release from ${url}`)
                resolve();
            }).catch(err => {
                tl.warning(`Failed to download release from ${url} reason: ${err}`)
                reject(err);
            });
        })
    }
}