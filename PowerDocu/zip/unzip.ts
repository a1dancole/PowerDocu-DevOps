
import * as tl from 'azure-pipelines-task-lib/task';

var DecompressZip = require('decompress-zip');

export class Unzip {
    public async unzipRelease(zip: string, destination: string): Promise<void> {
        await new Promise<void>(function (resolve, reject) {

            console.log(`##[command] Extracting ' + ${zip}`)
            var unzipper = new DecompressZip(zip);
            unzipper.on('error', err => {
                console.log(`##[warning] Failed to Unzip PowerDocu reason: ${err}`)
                return reject(tl.loc("ExtractionFailed", err))
            });
            unzipper.on('extract', log => {
                console.log(`##[command] Extracted to ${destination}`)
                return resolve();
            });
            unzipper.extract({
                path: destination
            });
        });
    }
}