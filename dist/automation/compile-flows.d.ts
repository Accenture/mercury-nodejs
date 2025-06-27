/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class CompileFlows {
    start(): void;
    private loadFlows;
    private createFlow;
    private parseTaskList;
    private parseTask;
    private isValidTaskConfiguration;
    private validateTaskName;
    private addTask;
    private parseInputDataMapping;
    private parseOutputDataMapping;
    private parseJoinTask;
    private parseNonSinkTask;
    private parsePipeline;
    private parseLoopStatement;
    private parseForLoop;
    private parseWhileLoop;
    private setDelay;
    private addFlow;
    private hasExternalState;
    private hasIncompleteMapping;
    private getCondition;
    private getForPart1;
    private getForPart2;
    private getForPart3;
    private validForStatement;
    private filterDataMapping;
    private handleThreePartFormat;
    private filterMapping;
    private normalizedNegateTypeMapping;
    private trimTypeQualifier;
    private validInput;
    private validModel;
    private validKeyValues;
    private validOutput;
    private validOutputLhs;
    private validOutputRhs;
    private validExecutionType;
}
