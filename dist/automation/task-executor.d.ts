import { EventEnvelope } from '../models/event-envelope.js';
import { Composable } from '../models/composable.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class TaskExecutor implements Composable {
    taskRefs: {};
    initialize(): Composable;
    handleEvent(event: EventEnvelope): Promise<any>;
    private executeTask;
    private getValueFromNonExistModel;
    private handleCallback;
    private resolveCondition;
    private handleResponseTask;
    private handleEndTask;
    private handleDecisionTask;
    private handleForkAndJoin;
    private handlePipelineTask;
    private sendResponse;
    private queueSequentialTask;
    private queueParallelTasks;
    private pipelineCompletion;
    private evaluateForCondition;
    private getParentFolder;
    private createParentFolders;
    private callExternalStateMachine;
    private removeModelElement;
    private setRhsElement;
    private setConstantValue;
    private getConstantValue;
    private getLhsElement;
    private getValueByType;
    private getMappingType;
    private getModelTypeIndex;
    private abortFlow;
    private endFlow;
}
