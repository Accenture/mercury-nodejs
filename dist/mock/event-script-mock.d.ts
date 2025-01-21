export declare class EventScriptMock {
    private flow;
    constructor(flowId: string);
    getFunctionRoute(taskName: string): string;
    assignFunctionRoute(taskName: string, mockFunction: string): EventScriptMock;
}
