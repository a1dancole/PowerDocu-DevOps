
import * as tl from 'azure-pipelines-task-lib/task';

var DecompressZip = require('decompress-zip');

export class Unzip {
    public async unzipRelease(zip: string, destination: string): Promise<void> {
        await new Promise<void>(function (resolve, reject) {

            tl.debug('Extracting ' + zip);
    
            var unzipper = new DecompressZip(zip);
            unzipper.on('error', err => {
                tl.warning(`Failed to Unzip PowerDocu reason: ${err}`)
                return reject(tl.loc("ExtractionFailed", err))
            });
            unzipper.on('extract', log => {
                tl.debug(`Extracted to ${destination}`);
                return resolve();
            });
            unzipper.extract({
                path: destination
            });
        });
    }
}