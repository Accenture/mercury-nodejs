export declare class JavaScriptClassScanner {
    private parentFolder;
    private jsFolder;
    private methodAnnotation;
    private clsMap;
    private clsParameters;
    private clsMethods;
    constructor(parentFolder: string, jsFolder: string, methodAnnotation: string);
    scan(): Promise<{
        classes: {};
        parameters: {};
        methods: {};
    }>;
    private scanJs;
}
