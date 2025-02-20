export declare class ClassScanUtility {
    static getParams(text: string): Array<string>;
    static list2str(list: Array<string>): string;
}
export declare class TypeScriptClassScanner {
    private sourceFolder;
    private methodAnnotation;
    private clsMap;
    private clsParents;
    private clsParameters;
    private clsMethods;
    constructor(sourceFolder: string, methodAnnotation: string);
    scan(): Promise<{
        classes: {};
        parents: {};
        parameters: {};
        methods: {};
    }>;
    private scanSource;
    private getSourceFile;
}
