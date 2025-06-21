export declare class EventScriptMock {
    private readonly flow;
    constructor(flowId: string);
    getFunctionRoute(taskName: string): string;
    assignFunctionRoute(taskName: string, mockFunction: string): this;
}
