export declare class JavaScriptClassScanner {
    private readonly parentFolder;
    private readonly jsFolder;
    private readonly methodAnnotation;
    private readonly clsMap;
    private readonly clsParameters;
    private readonly clsMethods;
    constructor(parentFolder: string, jsFolder: string, methodAnnotation: string);
    scan(): Promise<{
        classes: {};
        parameters: {};
        methods: {};
    }>;
    private scanJs;
}
