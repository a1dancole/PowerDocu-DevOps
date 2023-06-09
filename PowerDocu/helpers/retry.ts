import * as tl from 'azure-pipelines-task-lib/task';

export class Retry {

    public static Operation<T>(operationName: string, operation: () => Promise<T>, retryCount): Promise<T> {
        var executePromise = new Promise<T>((resolve, reject) => {
            this.RetryImplementation(operationName, operation, retryCount, resolve, reject);
        });

        return executePromise;
    }

    private static RetryImplementation<T>(operationName: string, operation: () => Promise<T>, currentRetryCount, resolve, reject) {
        operation().then((result) => {
            resolve(result);
        }).catch((error) => {
            if (currentRetryCount <= 0) {
                console.log(`##[error] ${tl.loc("OperationFailed", operationName, error)}`)
                reject(error);
            }
            else {
                console.log(`##[warning] ${tl.loc('RetryingOperation', operationName, currentRetryCount)}`)
                currentRetryCount = currentRetryCount - 1;
                setTimeout(() => this.RetryImplementation(operationName, operation, currentRetryCount, resolve, reject), 4 * 1000);
            }
        });
    }
}